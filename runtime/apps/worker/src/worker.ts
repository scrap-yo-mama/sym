// SPDX-License-Identifier: AGPL-3.0-only
// Service `worker` (tâche 1.3 ; 03 § Services ; 14 § 1, § 3, § 4) :
// 1. schéma à jour, verrou partagé des secrets puis `keyCheck` AVANT toute file : une autre MASTER_KEY arrête le worker
//    avant tout run (D-12, `assert_worker_key_mismatch`) ;
// 2. pg-boss démarré (connexion de session), file `run` (retryLimit 0, expireInSeconds > budget) ;
// 3. par job : prise du run (jeton `job_id`), `runs.heartbeat_at` toutes les RUN_HEARTBEAT_SECONDS, exécution,
//    clôture ; perte du bail (annulation, reprise) → interruption ;
// 4. `worker_heartbeats` toutes les 15 s ; balayeur des runs orphelins toutes les 60 s ;
// 5. planification, webhooks et alertes (tâche 2.5) : voir scheduling.ts ; la fin d'un run est annoncée dans la transaction
//    qui la clôt (`finishRunAndNotify`) ;
// 6. SIGTERM : `draining`, plus de nouveau job, fin des runs en cours sous SHUTDOWN_TIMEOUT_SECONDS, sinon remise en file ;
// 7. RGPD (1.8, D-25) : clé des sujets chargée au démarrage ; par run, registre de masquage (`RunContext.personal`, vidé
//    en fin de run, appliqué à `error_detail`) et liste d'exclusion (`RunContext.excludeSubjects`, appliquée aussi par
//    `RunContext.writeItems`, qui écrit le dataset sous l'identité du propriétaire avec la dédup de la planification) ; passe de rétention
//    planifiée toutes les RETENTION_TICK_SECONDS (marquage horaire, purge et `ensure_partitions` quotidiens, verrou
//    consultatif : une seule instance à la fois), sur une connexion de session.
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import {
  createLogger,
  filterExcludedItems,
  initTelemetry,
  PersonalValueRegistry,
  RUN_QUEUE,
  RUN_SHUTDOWN_DETAIL,
  secretValues,
  withRunContext,
  withSpan,
  type DatasetWrite,
  type RunExecutor,
  type RunJobData,
  type RunResult,
  type SpanHandle,
} from '@runtime/core';
import {
  appendRunItems,
  beatWorker,
  claimRun,
  createRunLogger,
  currentSchemaVersion,
  expectedSchemaVersion,
  finishRunAndNotify,
  heartbeatRun,
  holdSecretsLock,
  keyCheck,
  loadSubjectExclusions,
  loadSubjectKey,
  PgBossJobQueue,
  recordAttempt,
  removeWorkerBeat,
  requeueRun,
  resolveConnections,
  runQueueDefinition,
  secretStore,
  runRetentionTick,
  schemaVersionRefusal,
  sweepOrphans,
  withActor,
  type SweepResult,
} from '@runtime/db';
import { SsrfGuard } from '@runtime/core/net';
import pg from 'pg';
import type { Logger } from 'pino';
import type { WorkerConfig } from './config.js';
import { startScheduling, type Scheduling } from './scheduling.js';

class WorkerStartupError extends Error {
  override name = 'WorkerStartupError';
}

/**
 * Exécuteur par défaut tant que les exécuteurs E1-E3 (tâche 1.6) ne sont pas branchés : le run est clos `failed`
 * (`code_error`, `executor_unavailable`), jamais laissé `running`.
 */
export const unavailableExecutor: RunExecutor = async () => ({
  state: 'failed',
  failure_class: 'code_error',
  retryable: false,
  error_detail: 'executor_unavailable',
});

export interface Worker {
  readonly workerId: string;
  /** Runs en cours dans ce processus. */
  inFlight(): number;
  /** Un passage du balayeur (exposé pour les tests et `runtime doctor`). */
  sweep(): Promise<SweepResult>;
  /** Arrêt propre (idempotent). */
  stop(): Promise<void>;
}

export type StartWorkerOptions = {
  config: WorkerConfig;
  executor?: RunExecutor;
  logger?: Logger;
  workerId?: string;
  /** Réglages de la planification (tests : horloge simulée, passages du cron rapprochés). */
  scheduling?: {
    clock?: ConstructorParameters<typeof PgBossJobQueue>[0]['clock'];
    now?: () => Date;
    cronMonitorIntervalSeconds?: number;
    cronWorkerIntervalSeconds?: number;
    supervise?: boolean;
    smtpCa?: string[];
  };
};

type AbortCause = 'lease_lost' | 'expired' | 'shutdown';
type Running = { runId: string; jobId: string; controller: AbortController; cause: AbortCause | null; done: Promise<void> };

const errorDetail = (error: unknown): string =>
  secretValues.redactText(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);

export async function startWorker(options: StartWorkerOptions): Promise<Worker> {
  const { config } = options;
  const log = options.logger ?? createLogger({ name: 'worker', level: config.observability.logLevel }); // masquage INV8, run_id par AsyncLocalStorage
  // OTel : coupé par défaut (aucun module chargé) ; actif seulement si `OTEL_ENABLED=true` avec un endpoint explicite.
  const telemetry = await initTelemetry(config.observability.otel);
  const executor = options.executor ?? unavailableExecutor;
  const workerId = options.workerId ?? `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;

  const { sessionUrl } = await resolveConnections({
    DATABASE_URL: config.databaseUrl,
    ...(config.databaseUrlDirect ? { DATABASE_URL_DIRECT: config.databaseUrlDirect } : {}),
  });
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax, application_name: 'runtime-worker' });
  pool.on('error', (error) => log.error({ err: errorDetail(error) }, 'pool : connexion perdue'));
  const lockClient = new pg.Client({ connectionString: sessionUrl, application_name: 'runtime-worker-lock' });
  lockClient.on('error', (error) => log.error({ err: errorDetail(error) }, 'verrou des secrets : connexion perdue'));
  let releaseLock: (() => Promise<void>) | undefined;
  let queue: PgBossJobQueue | undefined;
  let scheduling: Scheduling | undefined;
  let subjectKey: Buffer | undefined;
  // Passes de rétention : verrou consultatif de session et DETACH CONCURRENTLY exigent une connexion de session.
  const maintenancePool = new pg.Pool({ connectionString: sessionUrl, max: 1, application_name: 'runtime-worker-retention' });
  maintenancePool.on('error', (error) => log.error({ err: errorDetail(error) }, 'rétention : connexion perdue'));

  const cleanup = async () => {
    await scheduling?.stop().catch(() => undefined);
    await queue?.stop({ timeoutMs: 1000 }).catch(() => undefined);
    await releaseLock?.().catch(() => undefined);
    await lockClient.end().catch(() => undefined);
    await maintenancePool.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await telemetry.shutdown().catch(() => undefined);
  };

  try {
    const expected = expectedSchemaVersion();
    const version = await currentSchemaVersion(pool);
    const refusal = schemaVersionRefusal(version, expected, 'worker');
    if (refusal) throw new WorkerStartupError(refusal);
    await lockClient.connect();
    releaseLock = await holdSecretsLock(lockClient);
    // D-12 : clé différente → KeyCheckError ici, avant pg-boss, avant toute prise de job.
    const checked = await keyCheck(pool, config.keyring);
    subjectKey = await loadSubjectKey(pool, config.keyring, checked);
    queue = new PgBossJobQueue({
      connectionString: sessionUrl,
      application_name: 'runtime-worker-queue',
      onError: (error) => log.error({ err: errorDetail(error) }, 'file : erreur pg-boss'),
      schedule: true,
      ...(options.scheduling?.clock ? { clock: options.scheduling.clock } : {}),
      ...(options.scheduling?.cronMonitorIntervalSeconds ? { cronMonitorIntervalSeconds: options.scheduling.cronMonitorIntervalSeconds } : {}),
      ...(options.scheduling?.cronWorkerIntervalSeconds ? { cronWorkerIntervalSeconds: options.scheduling.cronWorkerIntervalSeconds } : {}),
      ...(options.scheduling?.supervise === undefined ? {} : { supervise: options.scheduling.supervise }),
    });
    await queue.start();
    await queue.createQueue(runQueueDefinition(config.runBudgetSeconds));
    await beatWorker(pool, { workerId, version: config.version });
    scheduling = await startScheduling({
      pool,
      queue,
      store: secretStore(pool, config.keyring, checked),
      guard: new SsrfGuard({ policy: config.ssrfPolicy }),
      log,
      now: options.scheduling?.now ?? (() => new Date()),
      warningCheckSeconds: config.warningCheckSeconds,
      pollingIntervalSeconds: config.queuePollingSeconds,
      ...(options.scheduling?.smtpCa ? { smtpCa: options.scheduling.smtpCa } : {}),
    });
    log.info({ workerId, key: checked.fingerprint, concurrency: config.concurrency }, 'worker démarré');
  } catch (error) {
    await cleanup();
    throw error;
  }
  const q = queue;
  const subjects = subjectKey!;

  let draining = false;
  const running = new Map<string, Running>();

  const beat = () =>
    beatWorker(pool, {
      workerId,
      version: config.version,
      draining,
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
    }).catch((error: unknown) => log.warn({ err: errorDetail(error) }, 'worker_heartbeats : écriture impossible'));
  const beatTimer = setInterval(() => void beat(), config.workerHeartbeatSeconds * 1000);

  const sweep = async (): Promise<SweepResult> => {
    const result = await sweepOrphans(pool, q, { staleSeconds: config.runStaleSeconds });
    if (result.requeued.length + result.failed.length > 0) log.warn(result, 'balayeur : runs orphelins repris');
    return result;
  };
  let sweeping = false;
  const sweepTimer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    sweep()
      .catch((error: unknown) => log.error({ err: errorDetail(error) }, 'balayeur : échec'))
      .finally(() => (sweeping = false));
  }, config.sweepIntervalSeconds * 1000);

  let retentionRunning: Promise<void> | undefined;
  const retentionTimer = setInterval(() => {
    if (retentionRunning) return;
    retentionRunning = runRetentionTick(maintenancePool, new Date(), config.retention)
      .then((r) => {
        if (r.daily) log.info({ report: r.report }, 'rétention : passe quotidienne');
      })
      .catch((error: unknown) => log.error({ err: errorDetail(error) }, 'rétention : échec de la passe'))
      .finally(() => (retentionRunning = undefined));
  }, config.retentionTickSeconds * 1000);

  const execute = (runId: string, jobId: string, jobSignal: AbortSignal, trace: string | undefined): Promise<void> =>
    withRunContext(runId, () =>
      withSpan('run.execute', { attributes: { run_id: runId }, parentTraceparent: trace ?? null }, (span) => executeRun(runId, jobId, jobSignal, span)),
    );

  const executeRun = async (runId: string, jobId: string, jobSignal: AbortSignal, span: SpanHandle): Promise<void> => {
    const claim = await claimRun(pool, { runId, jobId, workerId });
    if (!claim) {
      log.info({ runId, jobId }, 'job sans run à prendre (annulé ou repris) : ignoré');
      return;
    }
    // Registre de masquage de ce run (vidé en fin de run).
    const personal = new PersonalValueRegistry();
    const runLog = await createRunLogger(
      pool,
      { runId, ownerId: claim.ownerId, personal },
      { minLevel: config.observability.logLevel, onError: (error) => log.warn({ err: errorDetail(error) }, 'run_logs : écriture impossible') },
    );
    await runLog.log('info', 'run_claimed', { worker: workerId, job: jobId });
    const controller = new AbortController();
    let resolveDone!: () => void;
    const entry: Running = { runId, jobId, controller, cause: null, done: new Promise((r) => (resolveDone = r)) };
    const abort = (cause: AbortCause) => {
      if (controller.signal.aborted) return;
      entry.cause = cause;
      controller.abort(new Error(cause));
    };
    running.set(runId, entry);
    const onJobAbort = () => abort(draining ? 'shutdown' : 'expired');
    jobSignal.addEventListener('abort', onJobAbort, { once: true });
    const heartbeat = setInterval(() => {
      heartbeatRun(pool, runId, jobId).then(
        (ours) => {
          if (!ours) abort('lease_lost');
        },
        (error: unknown) => log.warn({ runId, err: errorDetail(error) }, 'battement du run : écriture impossible'),
      );
    }, config.runHeartbeatSeconds * 1000);
    // Bilan cumulé des écritures du dataset par l'exécuteur (`ctx.writeItems`), reporté dans le résultat du run.
    const dataset: { written: DatasetWrite | null } = { written: null };
    try {
      let result: RunResult;
      try {
        // Liste d'exclusion des sujets effacés, chargée à la prise du run.
        const excluded = await loadSubjectExclusions(pool);
        const writeItems = async (outputSchema: unknown, items: readonly unknown[]): Promise<DatasetWrite> => {
          const { kept, dropped } = filterExcludedItems(subjects, excluded, outputSchema, items);
          const r = await withActor(pool, { userId: claim.ownerId, role: 'member' }, (tx) => appendRunItems(tx, { runId, items: kept, hashKey: subjects }));
          const before = dataset.written;
          const next: DatasetWrite = {
            dataset_id: r.datasetId,
            written: (before?.written ?? 0) + r.written,
            new_items: r.newItems === null ? (before?.new_items ?? null) : (before?.new_items ?? 0) + r.newItems,
            dropped: (before?.dropped ?? 0) + dropped,
            skipped: (before?.skipped ?? 0) + r.skipped,
          };
          dataset.written = next;
          return next;
        };
        result = await executor({
          runId,
          apiId: claim.apiId,
          ownerId: claim.ownerId,
          strategyVersion: claim.strategyVersion,
          input: claim.input,
          signal: controller.signal,
          recordAttempt: async (attempt) => {
            await recordAttempt(pool, runId, jobId, attempt);
          },
          log: runLog.log,
          personal,
          excludeSubjects: (outputSchema, items) => filterExcludedItems(subjects, excluded, outputSchema, items),
          writeItems,
        });
        // Le dataset du run est celui que le worker a écrit, jamais un autre nommé par l'exécuteur.
        if (result.state === 'succeeded' && dataset.written !== null) result = { ...result, dataset_id: dataset.written.dataset_id };
      } catch (error) {
        result = controller.signal.aborted
          ? { state: 'failed', failure_class: 'transient', retryable: true, error_detail: entry.cause ?? 'aborted' }
          : { state: 'failed', failure_class: 'code_error', retryable: false, error_detail: errorDetail(error) };
      }
      if (entry.cause === 'expired') {
        result = { state: 'failed', failure_class: 'run_budget_exceeded', retryable: false, error_detail: 'job_expired' };
      }
      // Bail perdu ou arrêt : le run a déjà été annulé, repris ou remis en file ; rien n'est écrit.
      if (entry.cause === 'lease_lost' || entry.cause === 'shutdown') return;
      const closed = await finishRunAndNotify(pool, q, { runId, jobId, result }, { personal, subjectKey: subjects });
      if (result.state === 'failed') span.fail(result.failure_class);
      span.setAttribute('run.state', result.state);
      await runLog.log(result.state === 'failed' ? 'warn' : 'info', 'run_finished', {
        state: result.state,
        ...(result.state === 'failed' ? { failure_class: result.failure_class } : {}),
        closed,
      });
      log.info({ runId, state: result.state, closed }, 'run terminé');
    } finally {
      clearInterval(heartbeat);
      jobSignal.removeEventListener('abort', onJobAbort);
      running.delete(runId);
      personal.clear();
      resolveDone();
    }
  };

  await q.work<RunJobData>(RUN_QUEUE, { concurrency: config.concurrency, pollingIntervalSeconds: config.queuePollingSeconds }, async (job) => {
    const runId = job.data?.run_id;
    if (typeof runId !== 'string') {
      log.error({ jobId: job.id }, 'job de run sans run_id : ignoré');
      return;
    }
    await execute(runId, job.id, job.signal, typeof job.data._trace === 'string' ? job.data._trace : undefined);
  });

  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      draining = true;
      log.info({ inFlight: running.size }, 'arrêt : plus de nouveau job');
      clearInterval(sweepTimer);
      await scheduling?.stop();
      clearInterval(retentionTimer);
      await q.offWork(RUN_QUEUE).catch((error: unknown) => log.warn({ err: errorDetail(error) }, 'arrêt : offWork'));
      await beat();
      const all = () => Promise.all([...running.values()].map((r) => r.done));
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([all(), new Promise<void>((r) => (timer = setTimeout(r, config.shutdownTimeoutSeconds * 1000)))]);
      clearTimeout(timer);
      // Délai dépassé : remise en file (ou `failed` pour une API qui écrit), puis interruption.
      for (const entry of [...running.values()]) {
        const outcome = await requeueRun(pool, q, { runId: entry.runId, jobId: entry.jobId, detail: RUN_SHUTDOWN_DETAIL }).catch(
          (error: unknown) => {
            log.error({ runId: entry.runId, err: errorDetail(error) }, 'arrêt : remise en file impossible (le balayeur la fera)');
            return null;
          },
        );
        log.warn({ runId: entry.runId, outcome }, 'arrêt : run non fini');
        entry.cause = 'shutdown';
        entry.controller.abort(new Error('shutdown'));
      }
      await Promise.race([all(), new Promise<void>((r) => (timer = setTimeout(r, 2000)))]);
      clearTimeout(timer);
      clearInterval(beatTimer);
      await q.stop({ timeoutMs: 2000 }).catch((error: unknown) => log.warn({ err: errorDetail(error) }, 'arrêt : pg-boss'));
      await retentionRunning;
      await maintenancePool.end().catch(() => undefined);
      await removeWorkerBeat(pool, workerId).catch(() => undefined);
      await releaseLock?.().catch(() => undefined);
      await lockClient.end().catch(() => undefined);
      await pool.end().catch(() => undefined);
      await telemetry.shutdown().catch(() => undefined);
      log.info('worker arrêté');
    })());

  return { workerId, inFlight: () => running.size, sweep, stop };
}
