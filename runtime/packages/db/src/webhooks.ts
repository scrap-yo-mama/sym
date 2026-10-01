// SPDX-License-Identifier: AGPL-3.0-only
// Webhooks sortants Standard Webhooks (tâche 2.5, 08 § 5, O7) : cibles, secrets, émission, livraison, journal.
// - Secret `whsec_` par cible : généré, rendu UNE fois, chiffré au repos (INV8, `secrets`, AAD liée à la ligne). La
//   rotation garde l'ancien secret valide un temps (deux signatures dans l'en-tête).
// - URL : refus précoce à l'enregistrement par la garde SSRF (INV10) ; l'envoi la recontrôle à la connexion
//   (`deliverWebhook` : aucune redirection suivie).
// - Livraison : 5 tentatives (immédiat, 5 s, 5 min, 30 min, 2 h) par pg-boss, une ligne `webhook_deliveries` par
//   tentative (journal : code, durée, extrait tronqué), `webhook-id` stable, `dispatch-id` par (événement, cible).
//   Un refus SSRF ou une redirection n'est jamais rejoué. Cible `disabled` après 5 jours d'échecs continus.
// - Charge mince (INV5) : jamais d'item. `api.status_changed` vers `bloquee` porte `retryable: false`.
// Identité : système (worker). Les fonctions d'enregistrement prennent le client que l'appelant choisit (REST : sous RLS).
import { randomUUID } from 'node:crypto';
import {
  classifyDelivery,
  generateWebhookSecret,
  isWebhookEvent,
  WEBHOOK_DISABLE_AFTER_MS,
  WEBHOOK_EVENTS,
  type JobQueue,
  type QueryClient,
  type QueueDefinition,
  type WebhookEventName,
  type WebhookPayload,
} from '@runtime/core';
import { assertWebhookUrlAllowed, sendWebhookAttempt, type SsrfGuard } from '@runtime/core/net';
import type pg from 'pg';
import { SecretUnreadableError, type secretStore } from './secrets.js';

type Queryable = Pick<pg.ClientBase, 'query'>;
export type SecretStore = ReturnType<typeof secretStore>;

export const WEBHOOK_DELIVERY_QUEUE = 'webhook-delivery';
/** pg-boss ne rejoue pas : le barème est le nôtre (une ligne et un job par tentative). */
export function webhookDeliveryQueueDefinition(): QueueDefinition {
  return { name: WEBHOOK_DELIVERY_QUEUE, expireInSeconds: 60, heartbeatSeconds: 30, retryLimit: 0, policy: 'standard' };
}

export type WebhookDeliveryJob = { dispatch_id: string; attempt: number };

/** Délai de grâce par défaut de l'ancien secret après une rotation (h). */
export const ROTATION_GRACE_HOURS = 24;

export class WebhookConfigError extends Error {
  override name = 'WebhookConfigError';
}

// ---------------------------------------------------------------------------------------------------------------
// Cibles
// ---------------------------------------------------------------------------------------------------------------

export type CreatedSubscription = { id: string; /** Rendu une seule fois ; jamais relisible. */ secret: string };

/**
 * Enregistre une cible. L'URL passe par la garde SSRF (refus : `SsrfBlockedError`, rien n'est écrit). Événements : liste
 * non vide dans le vocabulaire fermé. Le secret est chiffré avant l'écriture et rendu une fois.
 */
export async function createWebhookSubscription(
  db: Queryable,
  store: SecretStore,
  guard: SsrfGuard,
  input: { ownerId: string; url: string; events: readonly string[]; projectId?: string },
): Promise<CreatedSubscription> {
  const events = [...new Set(input.events)];
  if (events.length === 0 || !events.every(isWebhookEvent)) {
    throw new WebhookConfigError(`events : liste non vide parmi ${WEBHOOK_EVENTS.join(', ')} attendue`);
  }
  const url = await assertWebhookUrlAllowed(input.url, guard);
  const secret = generateWebhookSecret();
  const id = randomUUID();
  const secretId = await store.put({ ownerId: input.ownerId, kind: 'webhook_secret', label: `webhook ${url.host}`, value: secret, ...(input.projectId ? { projectId: input.projectId } : {}) });
  await db.query(
    `INSERT INTO webhook_subscriptions (id, owner_id, project_id, url, events, secret_id)
     VALUES ($1, $2, coalesce($3::uuid, '00000000-0000-0000-0000-000000000001'), $4, $5, $6)`,
    [id, input.ownerId, input.projectId ?? null, url.toString(), events, secretId],
  );
  return { id, secret };
}

/**
 * Rotation : un nouveau secret devient courant, l'ancien reste valide `graceHours` (deux signatures dans l'en-tête, le
 * récepteur bascule sans coupure). Une seconde rotation avant la fin remplace l'ancien « ancien ». Rend le nouveau secret.
 */
export async function rotateWebhookSecret(
  db: Queryable,
  store: SecretStore,
  input: { subscriptionId: string; graceHours?: number; now?: Date },
): Promise<{ secret: string }> {
  const { rows } = await db.query<{ owner_id: string; url: string }>('SELECT owner_id, url FROM webhook_subscriptions WHERE id = $1 FOR UPDATE', [input.subscriptionId]);
  const sub = rows[0];
  if (!sub) throw new WebhookConfigError(`cible ${input.subscriptionId} introuvable`);
  const secret = generateWebhookSecret();
  const secretId = await store.put({ ownerId: sub.owner_id, kind: 'webhook_secret', label: `webhook ${new URL(sub.url).host}`, value: secret });
  const expires = new Date((input.now ?? new Date()).getTime() + (input.graceHours ?? ROTATION_GRACE_HOURS) * 3_600_000);
  await db.query(
    `UPDATE webhook_subscriptions SET previous_secret_id = secret_id, previous_secret_expires_at = $2, secret_id = $3, updated_at = now() WHERE id = $1`,
    [input.subscriptionId, expires, secretId],
  );
  return { secret };
}

/** Réactive une cible désactivée (après correction côté récepteur). */
export async function enableWebhookSubscription(db: Queryable, subscriptionId: string): Promise<void> {
  await db.query(
    "UPDATE webhook_subscriptions SET status = 'active', disabled_at = NULL, failing_since = NULL, updated_at = now() WHERE id = $1",
    [subscriptionId],
  );
}

export type DeliveryLogRow = {
  event: string;
  dispatch_id: string;
  attempt: number;
  status: 'pending' | 'succeeded' | 'failed';
  http_status: number | null;
  duration_ms: number | null;
  response_excerpt: string | null;
  error_code: string | null;
  created_at: Date;
  finished_at: Date | null;
};

/** Journal de livraison d'une cible (tentative, code, durée, extrait tronqué), le plus récent d'abord. */
export async function listDeliveries(db: Queryable, subscriptionId: string, limit = 50): Promise<DeliveryLogRow[]> {
  const { rows } = await db.query<DeliveryLogRow>(
    `SELECT event, dispatch_id, attempt, status, http_status, duration_ms, response_excerpt, error_code, created_at, finished_at
     FROM webhook_deliveries WHERE subscription_id = $1 ORDER BY id DESC LIMIT $2`,
    [subscriptionId, limit],
  );
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------
// Émission
// ---------------------------------------------------------------------------------------------------------------

export type EmitInput = {
  event: WebhookEventName;
  payload: WebhookPayload;
  /** Cibles de ces propriétaires abonnées à l'événement. */
  ownerIds?: readonly string[];
  /** Cibles désignées (alerte d'instance par défaut) : livrées même si l'événement n'est pas dans leur liste. */
  subscriptionIds?: readonly string[];
  /** `webhook-id` : un événement, un identifiant, pour toutes ses cibles. */
  eventId?: string;
  now?: Date;
};

/**
 * Écrit une livraison (tentative 1) et son job par cible, dans la transaction de l'appelant : pas de livraison fantôme
 * si l'événement est annulé, pas d'événement perdu s'il est validé. Rend le nombre de cibles atteintes.
 */
export async function emitWebhookEvent(tx: Queryable, queue: JobQueue, input: EmitInput): Promise<{ eventId: string; deliveries: string[] }> {
  const eventId = input.eventId ?? randomUUID();
  const { rows } = await tx.query<{ id: string; owner_id: string; project_id: string }>(
    `SELECT id, owner_id, project_id FROM webhook_subscriptions
     WHERE status = 'active'
       AND ((owner_id = ANY($1::uuid[]) AND $2 = ANY(events)) OR id = ANY($3::uuid[]))`,
    [input.ownerIds ?? [], input.event, input.subscriptionIds ?? []],
  );
  const deliveries: string[] = [];
  for (const sub of rows) {
    const dispatchId = randomUUID();
    await tx.query(
      `INSERT INTO webhook_deliveries (subscription_id, owner_id, project_id, event, dispatch_id, attempt, status, next_attempt_at, event_id, payload)
       VALUES ($1, $2, $3, $4, $5, 1, 'pending', $6, $7, $8::jsonb)`,
      [sub.id, sub.owner_id, sub.project_id, input.event, dispatchId, input.now ?? new Date(), eventId, JSON.stringify(input.payload)],
    );
    await queue.enqueue(WEBHOOK_DELIVERY_QUEUE, { dispatch_id: dispatchId, attempt: 1 } satisfies WebhookDeliveryJob, { tx: tx as QueryClient });
    deliveries.push(dispatchId);
  }
  return { eventId, deliveries };
}

/** « Renvoyer » : une tentative de plus pour la même livraison (même `webhook-id`, signature et horodatage frais). */
export async function redeliverWebhook(tx: Queryable, queue: JobQueue, dispatchId: string, now: Date = new Date()): Promise<number> {
  const { rows } = await tx.query<{ attempt: number; subscription_id: string; owner_id: string; project_id: string; event: string; event_id: string; payload: unknown }>(
    `SELECT attempt, subscription_id, owner_id, project_id, event, event_id, payload FROM webhook_deliveries
     WHERE dispatch_id = $1 ORDER BY attempt DESC LIMIT 1`,
    [dispatchId],
  );
  const last = rows[0];
  if (!last) throw new WebhookConfigError(`livraison ${dispatchId} introuvable`);
  const attempt = last.attempt + 1;
  await tx.query(
    `INSERT INTO webhook_deliveries (subscription_id, owner_id, project_id, event, dispatch_id, attempt, status, next_attempt_at, event_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9::jsonb)`,
    [last.subscription_id, last.owner_id, last.project_id, last.event, dispatchId, attempt, now, last.event_id, JSON.stringify(last.payload)],
  );
  await queue.enqueue(WEBHOOK_DELIVERY_QUEUE, { dispatch_id: dispatchId, attempt } satisfies WebhookDeliveryJob, { tx: tx as QueryClient });
  return attempt;
}

// ---------------------------------------------------------------------------------------------------------------
// Livraison
// ---------------------------------------------------------------------------------------------------------------

export type DeliveryContext = {
  pool: pg.Pool;
  queue: JobQueue;
  store: SecretStore;
  guard: SsrfGuard;
  now?: () => Date;
  timeoutMs?: number;
  /** Détail des refus de la garde, réservé au journal admin. */
  onSsrfBlocked?: (detail: { subscriptionId: string; reason: string; host: string }) => void;
};

export type DeliveryResult =
  | { outcome: 'delivered'; httpStatus: number }
  | { outcome: 'retry'; errorCode: string; delaySeconds: number }
  | { outcome: 'failed'; errorCode: string }
  | { outcome: 'skipped'; reason: 'already_done' | 'subscription_disabled' | 'subscription_missing' };

type DeliveryRow = {
  id: number;
  subscription_id: string;
  owner_id: string;
  project_id: string;
  event: string;
  event_id: string;
  payload: unknown;
  status: string;
  url: string;
  sub_status: 'active' | 'disabled';
  secret_id: string | null;
  previous_secret_id: string | null;
  previous_secret_expires_at: Date | null;
  failing_since: Date | null;
};

async function inTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Une tentative de livraison : envoi signé sous garde, classement, journal, prochaine tentative au barème. */
export async function deliverWebhookAttempt(ctx: DeliveryContext, job: WebhookDeliveryJob): Promise<DeliveryResult> {
  const now = ctx.now ?? (() => new Date());
  const { rows } = await ctx.pool.query<DeliveryRow>(
    `SELECT d.id, d.subscription_id, d.owner_id, d.project_id, d.event, d.event_id, d.payload, d.status,
            s.url, s.status AS sub_status, s.secret_id, s.previous_secret_id, s.previous_secret_expires_at, s.failing_since
     FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id
     WHERE d.dispatch_id = $1 AND d.attempt = $2`,
    [job.dispatch_id, job.attempt],
  );
  const row = rows[0];
  if (!row) return { outcome: 'skipped', reason: 'subscription_missing' };
  if (row.status !== 'pending') return { outcome: 'skipped', reason: 'already_done' };
  if (row.sub_status !== 'active') {
    await ctx.pool.query("UPDATE webhook_deliveries SET status = 'failed', error_code = 'subscription_disabled', finished_at = now() WHERE id = $1", [row.id]);
    return { outcome: 'skipped', reason: 'subscription_disabled' };
  }

  const secrets: string[] = [];
  try {
    if (row.secret_id === null) throw new WebhookConfigError('secret manquant');
    secrets.push((await ctx.store.get(row.secret_id)).reveal());
    if (row.previous_secret_id !== null && (row.previous_secret_expires_at === null || row.previous_secret_expires_at > now())) {
      secrets.push((await ctx.store.get(row.previous_secret_id)).reveal());
    }
  } catch (error) {
    // Secret illisible ou absent : rien à signer, rien ne sert de rejouer (à ressaisir dans les réglages).
    const code = error instanceof SecretUnreadableError ? 'secret_unreadable' : 'secret_missing';
    await ctx.pool.query("UPDATE webhook_deliveries SET status = 'failed', error_code = $2, finished_at = now() WHERE id = $1", [row.id, code]);
    return { outcome: 'failed', errorCode: code };
  }

  const attempt = await sendWebhookAttempt({
    url: row.url,
    messageId: `evt_${row.event_id}`,
    dispatchId: job.dispatch_id,
    payload: row.payload,
    secrets,
    guard: ctx.guard,
    now: now(),
    ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}),
  });
  if (attempt.ssrf) ctx.onSsrfBlocked?.({ subscriptionId: row.subscription_id, reason: attempt.ssrf.reason, host: attempt.ssrf.host });
  const verdict = classifyDelivery(job.attempt, { httpStatus: attempt.httpStatus, error: attempt.error });

  return inTransaction(ctx.pool, async (tx) => {
    const finished = now();
    await tx.query(
      `UPDATE webhook_deliveries SET status = $2, http_status = $3, duration_ms = $4, response_excerpt = $5, error_code = $6, finished_at = $7
       WHERE id = $1`,
      [row.id, verdict.verdict === 'delivered' ? 'succeeded' : 'failed', attempt.httpStatus, attempt.durationMs, attempt.excerpt, verdict.errorCode, finished],
    );
    if (verdict.verdict === 'delivered') {
      await tx.query('UPDATE webhook_subscriptions SET failing_since = NULL, last_success_at = $2 WHERE id = $1', [row.subscription_id, finished]);
      return { outcome: 'delivered', httpStatus: attempt.httpStatus ?? 0 } as const;
    }
    const failingSince = row.failing_since ?? finished;
    const disable = finished.getTime() - failingSince.getTime() >= WEBHOOK_DISABLE_AFTER_MS;
    await tx.query(
      `UPDATE webhook_subscriptions SET failing_since = $2,
         status = CASE WHEN $3 THEN 'disabled' ELSE status END, disabled_at = CASE WHEN $3 THEN $4 ELSE disabled_at END
       WHERE id = $1`,
      [row.subscription_id, failingSince, disable, finished],
    );
    if (verdict.verdict === 'retry' && verdict.delaySeconds !== null && !disable) {
      const next = job.attempt + 1;
      await tx.query(
        `INSERT INTO webhook_deliveries (subscription_id, owner_id, project_id, event, dispatch_id, attempt, status, next_attempt_at, event_id, payload)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9::jsonb)`,
        [row.subscription_id, row.owner_id, row.project_id, row.event, job.dispatch_id, next, new Date(finished.getTime() + verdict.delaySeconds * 1000), row.event_id, JSON.stringify(row.payload)],
      );
      await ctx.queue.enqueue(WEBHOOK_DELIVERY_QUEUE, { dispatch_id: job.dispatch_id, attempt: next } satisfies WebhookDeliveryJob, {
        tx: tx as QueryClient,
        startAfterSeconds: verdict.delaySeconds,
      });
      return { outcome: 'retry', errorCode: verdict.errorCode ?? 'unknown', delaySeconds: verdict.delaySeconds } as const;
    }
    return { outcome: 'failed', errorCode: verdict.errorCode ?? 'unknown' } as const;
  });
}

/** « Tester » une cible : une charge `webhook.test` signée, une seule tentative, journalisée ; renseigne `tested_at`. */
export async function testWebhookSubscription(ctx: DeliveryContext, subscriptionId: string): Promise<{ httpStatus: number | null; errorCode: string | null }> {
  const now = ctx.now ?? (() => new Date());
  const { rows } = await ctx.pool.query<{ owner_id: string; project_id: string; url: string; secret_id: string | null }>(
    'SELECT owner_id, project_id, url, secret_id FROM webhook_subscriptions WHERE id = $1',
    [subscriptionId],
  );
  const sub = rows[0];
  if (!sub?.secret_id) throw new WebhookConfigError('cible ou secret introuvable');
  const secret = (await ctx.store.get(sub.secret_id)).reveal();
  const dispatchId = randomUUID();
  const eventId = randomUUID();
  const payload = { type: 'webhook.test', timestamp: now().toISOString(), data: { subscription_id: subscriptionId } };
  const attempt = await sendWebhookAttempt({ url: sub.url, messageId: `evt_${eventId}`, dispatchId, payload, secrets: [secret], guard: ctx.guard, now: now(), ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}) });
  const verdict = classifyDelivery(1, { httpStatus: attempt.httpStatus, error: attempt.error });
  await ctx.pool.query(
    `INSERT INTO webhook_deliveries (subscription_id, owner_id, project_id, event, dispatch_id, attempt, status, http_status, duration_ms, response_excerpt, error_code, finished_at, event_id, payload)
     VALUES ($1, $2, $3, 'webhook.test', $4, 1, $5, $6, $7, $8, $9, now(), $10, $11::jsonb)`,
    [subscriptionId, sub.owner_id, sub.project_id, dispatchId, verdict.verdict === 'delivered' ? 'succeeded' : 'failed', attempt.httpStatus, attempt.durationMs, attempt.excerpt, verdict.errorCode, eventId, JSON.stringify(payload)],
  );
  if (verdict.verdict === 'delivered') await ctx.pool.query('UPDATE webhook_subscriptions SET tested_at = now() WHERE id = $1', [subscriptionId]);
  return { httpStatus: attempt.httpStatus, errorCode: verdict.errorCode };
}
