// SPDX-License-Identifier: AGPL-3.0-only
// Événements de session et webhooks (cdc/sym-browser 03 § 5 et § 6, 04 § 2, tâche 2.5, migration 0003). Écriture des
// événements (puits du nœud), lecture par client avec reprise après un identifiant (SSE `Last-Event-ID`), décodage des
// notifications `symb_session_events`, réglage du webhook d'un client, file des livraisons (réservation `SKIP LOCKED` sous
// bail, relance planifiée, état final). Toute lecture passe par le client propriétaire de la session (BINV7).
import type { SessionEventInput, SessionEventSink, StoredSessionEventType } from '@sym-browser/core';
import type pg from 'pg';

type Queryable = Pick<pg.ClientBase, 'query'>;

/** Canal des notifications d'événements (charge JSON, voir `parseSessionEventNotification`). */
export const SESSION_EVENTS_CHANNEL = 'symb_session_events';
/** Canal qui réveille les passerelles quand une livraison de webhook est mise en file. */
export const WEBHOOKS_CHANNEL = 'symb_webhooks';

/** Événement stocké ; `id` : identifiant croissant (`bigint`) en chaîne décimale, ordre total d'une session. */
export type StoredSessionEvent = {
  id: string;
  sessionId: string;
  tenantId: string;
  type: StoredSessionEventType;
  at: Date;
  data: Record<string, unknown>;
};

/** Notification décodée ; sans `data` quand la charge dépassait la limite de `pg_notify` (`truncated`). */
export type SessionEventNotification = Omit<StoredSessionEvent, 'data'> & { data?: Record<string, unknown>; truncated?: true };

const DECIMAL_ID = /^\d{1,19}$/;

export async function appendSessionEvent(db: Queryable, event: SessionEventInput): Promise<{ id: string }> {
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO session_events (session_id, occurred_at, type, data) VALUES ($1::uuid, coalesce($2::timestamptz, now()), $3, $4::jsonb) RETURNING id::text AS id',
    [event.sessionId, event.at ?? null, event.type, JSON.stringify(event.data)],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('événement non écrit');
  return { id: row.id };
}

/** Puits PostgreSQL des événements du nœud (`SessionEventSink` du noyau). */
export function createPgSessionEventSink(db: Queryable): SessionEventSink {
  return {
    append: async (event) => {
      await appendSessionEvent(db, event);
    },
  };
}

type EventRow = { id: string; session_id: string; tenant_id: string; type: StoredSessionEventType; occurred_at: Date; data: Record<string, unknown> };
const toEvent = (row: EventRow): StoredSessionEvent => ({ id: row.id, sessionId: row.session_id, tenantId: row.tenant_id, type: row.type, at: row.occurred_at, data: row.data });

/**
 * Événements d'un client (toutes ses sessions, ou une seule), strictement après `afterId`, dans l'ordre des identifiants.
 * La session d'un autre client ne rend rien.
 */
export async function listSessionEvents(db: Queryable, input: { tenantId: string; sessionId?: string; afterId?: string; limit?: number }): Promise<StoredSessionEvent[]> {
  if (input.afterId !== undefined && !DECIMAL_ID.test(input.afterId)) throw new RangeError('afterId : entier décimal attendu');
  const { rows } = await db.query<EventRow>(
    `SELECT e.id::text AS id, e.session_id, s.tenant_id, e.type, e.occurred_at, e.data
       FROM session_events e JOIN sessions s ON s.id = e.session_id
      WHERE s.tenant_id = $1::uuid
        AND ($2::uuid IS NULL OR e.session_id = $2::uuid)
        AND ($3::bigint IS NULL OR e.id > $3::bigint)
      ORDER BY e.id
      LIMIT $4`,
    [input.tenantId, input.sessionId ?? null, input.afterId ?? null, input.limit ?? 1_000],
  );
  return rows.map(toEvent);
}

/** Événement d'un client par identifiant (notification `truncated`). */
export async function getSessionEvent(db: Queryable, input: { tenantId: string; id: string }): Promise<StoredSessionEvent | null> {
  if (!DECIMAL_ID.test(input.id)) return null;
  const { rows } = await db.query<EventRow>(
    `SELECT e.id::text AS id, e.session_id, s.tenant_id, e.type, e.occurred_at, e.data
       FROM session_events e JOIN sessions s ON s.id = e.session_id
      WHERE e.id = $2::bigint AND s.tenant_id = $1::uuid`,
    [input.tenantId, input.id],
  );
  return rows[0] === undefined ? null : toEvent(rows[0]);
}

/** Décode une notification de `symb_session_events` ; lève `SyntaxError` sur une charge illisible. */
export function parseSessionEventNotification(payload: string): SessionEventNotification {
  const raw = JSON.parse(payload) as { id?: unknown; sessionId?: unknown; tenantId?: unknown; type?: unknown; at?: unknown; data?: unknown; truncated?: unknown };
  if (typeof raw.id !== 'string' || !DECIMAL_ID.test(raw.id) || typeof raw.sessionId !== 'string' || typeof raw.tenantId !== 'string' || typeof raw.type !== 'string' || typeof raw.at !== 'string') {
    throw new SyntaxError('notification d’événement illisible');
  }
  const base = { id: raw.id, sessionId: raw.sessionId, tenantId: raw.tenantId, type: raw.type as StoredSessionEventType, at: new Date(raw.at) };
  if (raw.truncated === true) return { ...base, truncated: true };
  return { ...base, data: (raw.data ?? {}) as Record<string, unknown> };
}

export type TenantWebhook = { url: string | null; secretEncrypted: string | null };

export async function getTenantWebhook(db: Queryable, tenantId: string): Promise<TenantWebhook | null> {
  const { rows } = await db.query<{ webhook_url: string | null; webhook_secret_encrypted: string | null }>(
    'SELECT webhook_url, webhook_secret_encrypted FROM tenants WHERE id = $1::uuid',
    [tenantId],
  );
  const row = rows[0];
  return row === undefined ? null : { url: row.webhook_url, secretEncrypted: row.webhook_secret_encrypted };
}

/** Règle (ou efface, `url: null`) le webhook d'un client ; `false` si le client n'existe pas. */
export async function setTenantWebhook(db: Queryable, input: { tenantId: string; url: string | null; secretEncrypted: string | null }): Promise<boolean> {
  const { rowCount } = await db.query('UPDATE tenants SET webhook_url = $2, webhook_secret_encrypted = $3 WHERE id = $1::uuid', [input.tenantId, input.url, input.secretEncrypted]);
  return (rowCount ?? 0) > 0;
}

export type WebhookDeliveryType = 'session.ended' | 'recording.ready';

export type WebhookDelivery = {
  id: string;
  tenantId: string;
  sessionId: string;
  type: WebhookDeliveryType;
  url: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  nextAttemptAt: Date;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
};

/** Livraison réservée pour un envoi, avec l'événement qui l'a produite. `attempts` compte la tentative en cours. */
export type ClaimedWebhookDelivery = WebhookDelivery & { event: StoredSessionEvent };

type DeliveryRow = {
  id: string;
  tenant_id: string;
  session_id: string;
  type: WebhookDeliveryType;
  url: string;
  status: WebhookDelivery['status'];
  attempts: number;
  next_attempt_at: Date;
  last_status: number | null;
  last_error: string | null;
  created_at: Date;
  delivered_at: Date | null;
};

const toDelivery = (row: DeliveryRow): WebhookDelivery => ({
  id: row.id,
  tenantId: row.tenant_id,
  sessionId: row.session_id,
  type: row.type,
  url: row.url,
  status: row.status,
  attempts: row.attempts,
  nextAttemptAt: row.next_attempt_at,
  lastStatus: row.last_status,
  lastError: row.last_error,
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
});

/**
 * Réserve jusqu'à `limit` livraisons dues (`pending`, échéance passée, bail libre) pour `lockMs`, en une instruction :
 * deux passerelles ne réservent jamais la même (`FOR UPDATE SKIP LOCKED`). Incrémente `attempts`.
 */
export async function claimWebhookDeliveries(db: Queryable, input: { limit: number; lockMs: number }): Promise<ClaimedWebhookDelivery[]> {
  const { rows } = await db.query<DeliveryRow & { event_id: string; event_type: StoredSessionEventType; occurred_at: Date; data: Record<string, unknown> }>(
    `WITH due AS (
       SELECT id FROM webhook_deliveries
        WHERE status = 'pending' AND next_attempt_at <= clock_timestamp() AND (locked_until IS NULL OR locked_until <= clock_timestamp())
        ORDER BY next_attempt_at, id
        LIMIT $1
        FOR UPDATE SKIP LOCKED),
     claimed AS (
       UPDATE webhook_deliveries d
          SET attempts = d.attempts + 1, locked_until = clock_timestamp() + make_interval(secs => $2::double precision / 1000)
         FROM due WHERE d.id = due.id
       RETURNING d.*)
     SELECT c.*, e.id::text AS event_id, e.type AS event_type, e.occurred_at, e.data
       FROM claimed c JOIN session_events e ON e.id = c.event_id
      ORDER BY c.next_attempt_at, c.id`,
    [input.limit, input.lockMs],
  );
  return rows.map((row) => ({
    ...toDelivery(row),
    event: { id: row.event_id, sessionId: row.session_id, tenantId: row.tenant_id, type: row.event_type, at: row.occurred_at, data: row.data },
  }));
}

export type WebhookOutcome =
  | { kind: 'delivered'; httpStatus: number }
  | { kind: 'retry'; at: Date; httpStatus: number | null; error: string }
  | { kind: 'failed'; httpStatus: number | null; error: string };

/** Issue d'une tentative ; sans effet sur une livraison déjà close (`delivered` ou `failed`). */
export async function completeWebhookDelivery(db: Queryable, input: { id: string; outcome: WebhookOutcome }): Promise<void> {
  const { outcome } = input;
  await db.query(
    `UPDATE webhook_deliveries
        SET status = $2,
            next_attempt_at = coalesce($3::timestamptz, next_attempt_at),
            locked_until = NULL,
            last_status = $4,
            last_error = $5,
            delivered_at = CASE WHEN $2 = 'delivered' THEN clock_timestamp() ELSE NULL END
      WHERE id = $1 AND status = 'pending'`,
    [
      input.id,
      outcome.kind === 'retry' ? 'pending' : outcome.kind,
      outcome.kind === 'retry' ? outcome.at : null,
      outcome.httpStatus,
      outcome.kind === 'delivered' ? null : outcome.error,
    ],
  );
}

/** Livraisons d'un client (une session ou toutes), par date de mise en file (journal, tests, console). */
export async function listWebhookDeliveries(db: Queryable, input: { tenantId: string; sessionId?: string }): Promise<WebhookDelivery[]> {
  const { rows } = await db.query<DeliveryRow>(
    `SELECT * FROM webhook_deliveries WHERE tenant_id = $1::uuid AND ($2::uuid IS NULL OR session_id = $2::uuid) ORDER BY event_id`,
    [input.tenantId, input.sessionId ?? null],
  );
  return rows.map(toDelivery);
}
