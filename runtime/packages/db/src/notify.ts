// SPDX-License-Identifier: AGPL-3.0-only
// Émission des événements et alertes (tâche 2.5, 08 § 5) : branchée sur la fin d'un run et sur une transition de statut,
// dans la transaction de l'appelant (livraison et job écrits au même COMMIT que le fait qu'ils annoncent).
// - `run.succeeded` / `run.failed` : aux cibles du propriétaire du RUN (INV12 : jamais celles d'un autre utilisateur) ;
// - `items.new` : planification à `dedup_key` (sans condition sur `alert_on`), après une première exécution de référence ;
//   le nombre vient du dataset (`datasets.new_items`, clés jamais vues pour l'API : `appendRunItems`, rendu définitif à la
//   clôture par `commitRunDedupKeys` qui inscrit les clés du run réussi), jamais du total du run ;
// - `api.status_changed` : aux cibles du propriétaire de l'API ; l'alerte d'instance par défaut (e-mail ou cible webhook)
//   ne concerne que les transitions actionnables d'une API sans règle propre.
// Charges minces (INV5) : identifiants, compteurs, URL du dataset ; jamais d'item. Aucune relance de run n'en découle.
import {
  alertCauseForTransition,
  itemsNewPayload,
  parseScheduleRules,
  runFailedPayload,
  runSucceededPayload,
  statusChangedPayload,
  type ApiStatus,
  type FailureClass,
  type JobQueue,
  type PersonalValueRegistry,
  type RunResult,
} from '@runtime/core';
import type pg from 'pg';
import { loadAlertSettings, queueAlert, queueStatusAlerts, type StatusTransition } from './alerts.js';
import { commitRunDedupKeys } from './datasets.js';
import { finishRun } from './runs.js';
import { applyStatusTransition, type ApplyStatusInput, type ApplyStatusResult } from './status.js';
import { emitWebhookEvent } from './webhooks.js';

type Queryable = Pick<pg.ClientBase, 'query'>;
type Ctx = { now?: () => Date };

type RunFacts = {
  id: string;
  api_id: string;
  owner_id: string;
  state: string;
  outcome: string | null;
  failure_class: FailureClass | null;
  retryable: boolean | null;
  items: number;
  dataset_id: string | null;
  schedule_id: string | null;
  slug: string;
  api_status: ApiStatus;
  api_owner_id: string;
  schedule_rules: unknown;
  /** `datasets.new_items` du dataset du run (null : pas de dataset). */
  dataset_new_items: number | null;
};

/** Événements et alertes d'un run terminé (`succeeded` ou `failed`) ; sans effet pour tout autre état. */
export async function notifyRunFinished(tx: Queryable, queue: JobQueue, runId: string, ctx: Ctx = {}): Promise<{ events: string[] }> {
  const now = (ctx.now ?? (() => new Date()))();
  const { rows } = await tx.query<RunFacts>(
    `SELECT r.id, r.api_id, r.owner_id, r.state, r.outcome, r.failure_class, r.retryable, r.items, r.dataset_id, r.schedule_id,
            a.slug, a.status AS api_status, a.owner_id AS api_owner_id, s.rules AS schedule_rules, d.new_items AS dataset_new_items
     FROM runs r JOIN apis a ON a.id = r.api_id LEFT JOIN schedules s ON s.id = r.schedule_id
       LEFT JOIN datasets d ON d.id = r.dataset_id
     WHERE r.id = $1`,
    [runId],
  );
  const run = rows[0];
  const events: string[] = [];
  if (!run || (run.state !== 'succeeded' && run.state !== 'failed')) return { events };
  const settings = await loadAlertSettings(tx);
  const base = { api: run.slug, api_id: run.api_id, run_id: run.id, status: run.api_status };
  const baseUrl = settings?.base_url ?? null;

  if (run.state === 'failed') {
    await emitWebhookEvent(tx, queue, {
      event: 'run.failed',
      payload: runFailedPayload(now, { ...base, failure_class: run.failure_class, retryable: run.retryable }),
      ownerIds: [run.owner_id],
      now,
    });
    events.push('run.failed');
    if (run.schedule_id !== null) {
      await queueAlert(tx, queue, { api: { id: run.api_id, owner_id: run.api_owner_id, slug: run.slug }, cause: 'run_failed', since: now, runId: run.id });
    }
    return { events };
  }

  // Nouveaux items : dès que la planification a une `dedup_key` (08 § 5 : `dedup_key` + `diff` suffisent ; `alert_on` ne
  // règle que les alertes), comptés à l'écriture du dataset contre les clés déjà vues pour l'API (`datasets.new_items`), et
  // après une exécution de référence (la première établit la base : tout y est « nouveau », rien n'est à signaler).
  // `items.new` part alors aux seules cibles du propriétaire abonnées à cet événement.
  let newItems: number | undefined;
  const rules = run.schedule_id === null ? null : parseScheduleRules(run.schedule_rules);
  if (rules?.ok && rules.rules.dedup_key !== null) {
    const baseline = await tx.query("SELECT 1 FROM runs WHERE schedule_id = $1 AND id <> $2 AND state = 'succeeded' LIMIT 1", [run.schedule_id, run.id]);
    newItems = (baseline.rowCount ?? 0) > 0 ? (run.dataset_new_items ?? 0) : 0;
  }
  await emitWebhookEvent(tx, queue, {
    event: 'run.succeeded',
    payload: runSucceededPayload(now, { ...base, outcome: run.outcome ?? 'clean', items: run.items, ...(newItems === undefined ? {} : { new_items: newItems }), dataset_id: run.dataset_id, base_url: baseUrl }),
    ownerIds: [run.owner_id],
    now,
  });
  events.push('run.succeeded');
  if (newItems !== undefined && newItems > 0) {
    await emitWebhookEvent(tx, queue, {
      event: 'items.new',
      payload: itemsNewPayload(now, { api: run.slug, api_id: run.api_id, run_id: run.id, new_items: newItems, items: run.items, dataset_id: run.dataset_id, base_url: baseUrl }),
      ownerIds: [run.owner_id],
      now,
    });
    events.push('items.new');
  }
  return { events };
}

/**
 * Clôt le run et annonce sa fin dans la MÊME transaction : un crash entre les deux ne laisse ni run clos sans événement,
 * ni événement sans run clos. `false` : le run n'était plus à ce job (rien n'est écrit, rien n'est annoncé).
 * Un run réussi inscrit au même COMMIT les clés de déduplication de son dataset (`commitRunDedupKeys`, `subjectKey` : clé
 * des sujets) : un run en échec n'en inscrit aucune, ses nouveautés restent nouvelles pour le run suivant.
 */
export async function finishRunAndNotify(
  pool: pg.Pool,
  queue: JobQueue,
  input: { runId: string; jobId: string; result: RunResult; now?: () => Date },
  opts: { personal?: PersonalValueRegistry; subjectKey?: Buffer } = {},
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const closed = await finishRun(client, input.runId, input.jobId, input.result, opts.personal ? { personal: opts.personal } : {});
    if (closed) {
      if (input.result.state === 'succeeded') await commitRunDedupKeys(client, input.runId, opts.subjectKey);
      await notifyRunFinished(client, queue, input.runId, input.now ? { now: input.now } : {});
    }
    await client.query('COMMIT');
    return closed;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Annonce des transitions de statut (à passer à `applyStatusTransition` via `afterTransition`, ou à appeler dans la
 * transaction qui les écrit) : `api.status_changed` à chaque transition, alertes actionnables regroupées.
 * `api.status_changed` vers `bloquee` porte `retryable: false` et ne déclenche AUCUN run ni ré-enquête.
 */
export async function notifyStatusChange(
  tx: Queryable,
  queue: JobQueue,
  input: { apiId: string; runId?: string | null; transitions: readonly StatusTransition[] },
  ctx: Ctx = {},
): Promise<{ deliveries: number; alerts: number }> {
  const now = (ctx.now ?? (() => new Date()))();
  const { rows } = await tx.query<{ id: string; owner_id: string; slug: string }>('SELECT id, owner_id, slug FROM apis WHERE id = $1', [input.apiId]);
  const api = rows[0];
  if (!api || input.transitions.length === 0) return { deliveries: 0, alerts: 0 };
  const settings = await loadAlertSettings(tx);
  const own = await tx.query("SELECT 1 FROM webhook_subscriptions WHERE owner_id = $1 AND status = 'active' AND 'api.status_changed' = ANY(events) LIMIT 1", [api.owner_id]);
  const hasOwnRule = (own.rowCount ?? 0) > 0;
  let deliveries = 0;
  for (const t of input.transitions) {
    const actionable = alertCauseForTransition(t.to) !== null;
    const defaultTarget = settings?.webhook_subscription_id ?? null;
    const useDefault = actionable && !hasOwnRule && defaultTarget !== null;
    const { deliveries: made } = await emitWebhookEvent(tx, queue, {
      event: 'api.status_changed',
      payload: statusChangedPayload(t.at, { api: api.slug, api_id: api.id, from: t.from, to: t.to, reason: t.reason, run_id: input.runId ?? null }),
      ownerIds: [api.owner_id],
      ...(useDefault ? { subscriptionIds: [defaultTarget] } : {}),
      now,
    });
    deliveries += made.length;
  }
  const alerts = await queueStatusAlerts(tx, queue, { api, runId: input.runId ?? null, transitions: input.transitions });
  return { deliveries, alerts };
}

/** Lignes `status_events` (ou événements de `applyStatusTransition`) au format des alertes. */
export function toStatusTransitions(events: readonly { from_status: ApiStatus | null; to_status: ApiStatus; reason: string | null; at: Date }[]): StatusTransition[] {
  return events.map((e) => ({ from: e.from_status, to: e.to_status, reason: e.reason, at: e.at }));
}

/**
 * `applyStatusTransition` + annonce des transitions (webhooks, alertes) au même COMMIT : le point d'entrée des exécuteurs
 * (enquête, réparation, runs) pour changer le statut d'une API.
 */
export function applyStatusAndNotify(pool: pg.Pool, queue: JobQueue, input: Omit<ApplyStatusInput, 'afterTransition'>, ctx: Ctx = {}): Promise<ApplyStatusResult> {
  return applyStatusTransition(pool, {
    ...input,
    afterTransition: async (client, events) => {
      await notifyStatusChange(client, queue, { apiId: input.apiId, runId: input.runId ?? null, transitions: toStatusTransitions(events) }, ctx);
    },
  });
}
