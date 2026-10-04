// SPDX-License-Identifier: AGPL-3.0-only
// Planification, webhooks et alertes dans le worker (tâche 2.5, 08 § 5) :
// - files `scheduled-run` (alimentée par le cron de pg-boss), `scheduled-run-deferred` (`overlap: queue`), `webhook-delivery`,
//   `alert-email` et `persistence-attempt` (mode « SYM ne lâche pas », D-49) ; chaque job est traité par la fonction de
//   `@runtime/db` correspondante ;
// - miroir pg-boss reconstruit depuis `schedules` au démarrage (source de vérité : la table) ;
// - contrôle des `warning` qui durent au-delà de D, périodique, atomique entre workers ; au même pas, retrait des secrets
//   webhook précédents dont la grâce est passée ;
// - journal : aucune adresse e-mail de destinataire (un compteur), aucun secret.
// Aucune règle n'est copiée dans les jobs : le gestionnaire relit la base.
import {
  SCHEDULED_RUN_QUEUE,
  type ScheduledRunJobData,
} from '@runtime/core';
import type { PersistencePolicy } from '@runtime/core';
import type { SsrfGuard } from '@runtime/core/net';
import {
  ALERT_QUEUE,
  alertQueueDefinition,
  checkLongWarnings,
  deliverWebhookAttempt,
  handleScheduledRun,
  purgeExpiredWebhookSecrets,
  reconcileSchedules,
  scheduledRunDeferredQueueDefinition,
  scheduledRunQueueDefinition,
  sendAlertEmail,
  SCHEDULED_RUN_DEFERRED_QUEUE,
  WEBHOOK_DELIVERY_QUEUE,
  webhookDeliveryQueueDefinition,
  NEGATIVE_MEMORY_UNAVAILABLE,
  PERSISTENCE_QUEUE,
  persistenceQueueDefinition,
  runPersistenceAttempt,
  sweepDuePersistence,
  type AlertJob,
  type NegativeMemory,
  type PersistenceJob,
  type PgBossJobQueue,
  type ReconcileResult,
  type SecretStore,
  type WebhookDeliveryJob,
} from '@runtime/db';
import type pg from 'pg';
import type { Logger } from 'pino';

export type SchedulingOptions = {
  pool: pg.Pool;
  queue: PgBossJobQueue;
  store: SecretStore;
  guard: SsrfGuard;
  log: Logger;
  /** Horloge : réelle en production, simulée en test. */
  now: () => Date;
  warningCheckSeconds: number;
  pollingIntervalSeconds: number;
  smtpCa?: string[];
  /** Mode « SYM ne lâche pas » (D-49) : créneaux et plafonds lus au démarrage. */
  persistence: PersistencePolicy;
  /** `USER_BUDGET_DAILY_USD` : budget USD par utilisateur et par jour, appliqué aux runs planifiés (08b § 3). */
  userBudgetDailyUsd?: number;
  /** `MAX_COST_USD_PER_RUN` : borne l'enveloppe d'un run dans le budget de l'utilisateur (tentatives du mode « SYM ne lâche pas »). */
  maxCostUsdPerRun?: number;
  /** Mémoire négative (2.12) : indisponible tant qu'elle n'est pas branchée, le mode ne tente alors rien. */
  negativeMemory?: NegativeMemory;
};

export type Scheduling = {
  reconciled: ReconcileResult;
  /** Un passage du contrôle des `warning` trop longs (exposé pour les tests). */
  checkWarnings(): Promise<string[]>;
  stop(): Promise<void>;
};

const errorText = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 300);

export async function startScheduling(options: SchedulingOptions): Promise<Scheduling> {
  const { pool, queue, store, guard, log, now } = options;
  for (const definition of [scheduledRunQueueDefinition(), scheduledRunDeferredQueueDefinition(), webhookDeliveryQueueDefinition(), alertQueueDefinition(), persistenceQueueDefinition()]) {
    await queue.createQueue(definition);
  }
  // Miroir reconstruit AVANT de consommer : lignes actives → schedule(), clés orphelines → unschedule().
  const reconciled = await reconcileSchedules(pool, queue);
  for (const bad of reconciled.invalid) log.warn(bad, 'planification illisible : ignorée');

  const polling = { pollingIntervalSeconds: options.pollingIntervalSeconds };
  const onTrigger = async (job: { id: string; data: ScheduledRunJobData; createdOn?: Date }) => {
    const data = job.data;
    if (typeof data?.schedule_id !== 'string') {
      log.error({ jobId: job.id }, 'déclenchement sans schedule_id : ignoré');
      return;
    }
    // `createdOn` : instant d'émission de l'occurrence par le cron (un job traité en retard garde son jour et son heure).
    const outcome = await handleScheduledRun({ pool, queue, now, jobId: job.id, data, ...(job.createdOn ? { occurredAt: job.createdOn } : {}), ...(options.userBudgetDailyUsd === undefined ? {} : { userBudgetDailyUsd: options.userBudgetDailyUsd, ...(options.maxCostUsdPerRun === undefined ? {} : { maxCostUsdPerRun: options.maxCostUsdPerRun }) }) });
    log.info({ scheduleId: data.schedule_id, ...outcome }, 'planification : déclenchement traité');
  };
  await queue.work<ScheduledRunJobData>(SCHEDULED_RUN_QUEUE, { concurrency: 2, ...polling }, onTrigger);
  await queue.work<ScheduledRunJobData>(SCHEDULED_RUN_DEFERRED_QUEUE, { concurrency: 1, ...polling }, onTrigger);

  const deliveryContext = {
    pool,
    queue,
    store,
    guard,
    now,
    onSsrfBlocked: (detail: { subscriptionId: string; reason: string; host: string }) => log.warn(detail, 'webhook : destination refusée par la garde SSRF'),
  };
  await queue.work<WebhookDeliveryJob>(WEBHOOK_DELIVERY_QUEUE, { concurrency: 5, ...polling }, async (job) => {
    const result = await deliverWebhookAttempt(deliveryContext, job.data);
    log.info({ dispatchId: job.data.dispatch_id, attempt: job.data.attempt, outcome: result.outcome }, 'webhook : tentative');
  });

  const alertContext = { pool, queue, store, guard, now, ...(options.smtpCa ? { smtpCa: options.smtpCa } : {}) };
  await queue.work<AlertJob>(ALERT_QUEUE, { concurrency: 1, ...polling }, async (job) => {
    const result = await sendAlertEmail(alertContext, job.data);
    // Jamais les adresses des destinataires (données personnelles) : `recipients` est un compteur.
    log.info({ apiId: job.data.api_id, cause: job.data.cause, ...result }, 'alerte : traitée');
  });

  // Mode « SYM ne lâche pas » (2.16) : un job par API, qui relit tout en base (créneau, plafonds, refus, reports).
  const persistence = {
    queue,
    now,
    policy: options.persistence,
    negativeMemory: options.negativeMemory ?? NEGATIVE_MEMORY_UNAVAILABLE,
    ...(options.userBudgetDailyUsd === undefined ? {} : { costCaps: { userBudgetDailyUsd: options.userBudgetDailyUsd, maxCostUsdPerRun: options.maxCostUsdPerRun ?? Number.POSITIVE_INFINITY } }),
  };
  await queue.work<PersistenceJob>(PERSISTENCE_QUEUE, { concurrency: 1, ...polling }, async (job) => {
    if (typeof job.data?.api_id !== 'string') return;
    const tick = await runPersistenceAttempt(pool, persistence, job.data.api_id);
    log.info({ apiId: job.data.api_id, tick: tick.kind, ...('reason' in tick ? { reason: tick.reason } : {}) }, 'persistance : passage');
  });

  const checkWarnings = async () => {
    const alerted = await checkLongWarnings({ pool, queue, now });
    // Filet du réveil de la persistance : un job perdu ne fige jamais un cycle.
    await sweepDuePersistence(pool, persistence);
    const purged = await purgeExpiredWebhookSecrets(pool, now());
    if (purged > 0) log.info({ purged }, 'webhook : secrets précédents expirés supprimés');
    return alerted;
  };
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    checkWarnings()
      .then((alerted) => {
        if (alerted.length > 0) log.warn({ alerted }, 'warning au-delà de D : alerte mise en file');
      })
      .catch((error: unknown) => log.error({ err: errorText(error) }, 'contrôle des warning : échec'))
      .finally(() => (checking = false));
  }, options.warningCheckSeconds * 1000);
  timer.unref();

  return {
    reconciled,
    checkWarnings,
    async stop() {
      clearInterval(timer);
      for (const name of [SCHEDULED_RUN_QUEUE, SCHEDULED_RUN_DEFERRED_QUEUE, WEBHOOK_DELIVERY_QUEUE, ALERT_QUEUE, PERSISTENCE_QUEUE]) {
        await queue.offWork(name).catch((error: unknown) => log.warn({ err: errorText(error), queue: name }, 'arrêt : offWork'));
      }
    },
  };
}
