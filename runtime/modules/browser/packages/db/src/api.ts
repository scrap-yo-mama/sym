// SPDX-License-Identifier: AGPL-3.0-only
// Accès base de l'API REST des sessions (cdc/sym-browser 04 § 2 à § 9, tâche 2.2) : création (id réservable), lecture et
// liste limitées au client (BINV7 : la session d'un autre client n'existe pas pour lui), pagination par curseur stable,
// clés d'idempotence. Les transitions d'état passent par sessions.ts (table de la machine à états).
import { createHash } from 'node:crypto';
import type { EndReason, SessionState, SessionType } from '@sym/contracts/browser';
import type pg from 'pg';

type Queryable = Pick<pg.ClientBase, 'query'>;

/** Session telle que l'API la lit : ligne `sessions`, région du nœud porteur, usage clôturé (2.6) s'il existe. */
export type SessionView = {
  id: string;
  tenantId: string;
  type: SessionType;
  state: SessionState;
  endReason: EndReason | null;
  nodeRegion: string | null;
  metadata: Record<string, string>;
  createdAt: Date;
  expiresAt: Date;
  usage: { seconds: number; bytesIn: number; bytesOut: number } | null;
  /** Position de pagination : `created_at` en microsecondes depuis l'époque (précision de PostgreSQL), puis `id`. */
  position: { micros: string; id: string };
};

type Row = {
  id: string;
  tenant_id: string;
  type: SessionType;
  state: SessionState;
  end_reason: EndReason | null;
  node_region: string | null;
  metadata: Record<string, string>;
  created_at: Date;
  expires_at: Date;
  created_micros: string;
  billed_seconds: string | null;
  bytes_in: string | null;
  bytes_out: string | null;
};

const SELECT = `
  SELECT s.id, s.tenant_id, s.type, s.state, s.end_reason, n.region AS node_region, s.metadata, s.created_at, s.expires_at,
         ((extract(epoch FROM s.created_at) * 1000000)::numeric(20, 0))::text AS created_micros,
         u.billed_seconds::text AS billed_seconds, u.bytes_in::text AS bytes_in, u.bytes_out::text AS bytes_out
    FROM sessions s
    LEFT JOIN nodes n ON n.id = s.node_id
    LEFT JOIN usage_records u ON u.session_id = s.id`;

function view(row: Row): SessionView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    state: row.state,
    endReason: row.end_reason,
    nodeRegion: row.node_region,
    metadata: row.metadata,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usage: row.billed_seconds === null ? null : { seconds: Number(row.billed_seconds), bytesIn: Number(row.bytes_in), bytesOut: Number(row.bytes_out) },
    position: { micros: row.created_micros, id: row.id },
  };
}

export type NewSession = {
  id?: string;
  tenantId: string;
  apiKeyId: string;
  type: SessionType;
  region: string | null;
  timeoutSeconds: number;
  options: Record<string, unknown>;
  egressPolicy: Record<string, unknown>;
  metadata: Record<string, string>;
};

/**
 * Insère une session `pending`. `expires_at` = création + `timeoutSeconds`, plafonné par `tenants.max_session_seconds`.
 * Identifiant déjà pris (par ce client ou un autre) : `{ ok: false, code: 'session_id_taken' }`.
 */
export async function insertSession(db: Queryable, input: NewSession): Promise<{ ok: true; session: SessionView } | { ok: false; code: 'session_id_taken' }> {
  try {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO sessions (id, tenant_id, api_key_id, type, region, options, egress_policy, metadata, expires_at)
       SELECT coalesce($1::uuid, gen_random_uuid()), t.id, $3, $4, $5, $6, $7, $8,
              now() + make_interval(secs => least($9::int, t.max_session_seconds))
         FROM tenants t WHERE t.id = $2
       RETURNING id`,
      [input.id ?? null, input.tenantId, input.apiKeyId, input.type, input.region, input.options, input.egressPolicy, input.metadata, input.timeoutSeconds],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error(`client ${input.tenantId} introuvable`);
    const session = await getSessionView(db, { tenantId: input.tenantId, sessionId: id });
    if (!session) throw new Error(`session ${id} introuvable après insertion`);
    return { ok: true, session };
  } catch (error) {
    if ((error as { code?: string; constraint?: string }).code === '23505' && (error as { constraint?: string }).constraint === 'sessions_pkey') {
      return { ok: false, code: 'session_id_taken' };
    }
    throw error;
  }
}

export async function getSessionView(db: Queryable, input: { tenantId: string; sessionId: string }): Promise<SessionView | null> {
  const { rows } = await db.query<Row>(`${SELECT} WHERE s.id = $1::uuid AND s.tenant_id = $2::uuid`, [input.sessionId, input.tenantId]);
  return rows[0] ? view(rows[0]) : null;
}

export type ListFilter = {
  tenantId: string;
  limit: number;
  /** Dernière position de la page précédente (exclue). */
  after?: { micros: string; id: string };
  state?: SessionState;
  type?: SessionType;
  metadata?: Record<string, string>;
  createdAfter?: Date;
  createdBefore?: Date;
};

/**
 * Page de sessions du client, tri par `created_at` décroissant puis `id` (pagination par clé, 04 § 9) : une création
 * concurrente est plus récente que toute position déjà lue, elle ne décale donc jamais les pages suivantes.
 */
export async function listSessionViews(db: Queryable, filter: ListFilter): Promise<{ data: SessionView[]; hasMore: boolean }> {
  const where = ['s.tenant_id = $1::uuid'];
  const params: unknown[] = [filter.tenantId];
  const add = (sql: (p: string) => string, value: unknown): void => {
    params.push(value);
    where.push(sql(`$${params.length}`));
  };
  if (filter.state) add((p) => `s.state = ${p}`, filter.state);
  if (filter.type) add((p) => `s.type = ${p}`, filter.type);
  if (filter.metadata && Object.keys(filter.metadata).length > 0) add((p) => `s.metadata @> ${p}::jsonb`, JSON.stringify(filter.metadata));
  if (filter.createdAfter) add((p) => `s.created_at > ${p}`, filter.createdAfter);
  if (filter.createdBefore) add((p) => `s.created_at < ${p}`, filter.createdBefore);
  if (filter.after) {
    params.push(filter.after.micros, filter.after.id);
    const micros = `$${params.length - 1}`;
    const id = `$${params.length}`;
    // Comparaison en microsecondes entières (extract rend un numeric exact) : aucun arrondi flottant sur la position.
    where.push(`((extract(epoch FROM s.created_at) * 1000000)::numeric(20, 0), s.id) < (${micros}::numeric(20, 0), ${id}::uuid)`);
  }
  params.push(filter.limit + 1);
  const { rows } = await db.query<Row>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC, s.id DESC LIMIT $${params.length}`, params);
  const hasMore = rows.length > filter.limit;
  return { data: rows.slice(0, filter.limit).map(view), hasMore };
}

/** Au moins un nœud `ready` dans la région demandée (toutes régions si `null`) : sinon 503 `no_node` (04 § 3). */
export async function readyNodeExists(db: Queryable, region: string | null): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM nodes WHERE state = 'ready' AND ($1::text IS NULL OR region = $1)) AS ok",
    [region],
  );
  return rows[0]?.ok === true;
}

export type IdempotentOperation = 'createSession' | 'extendSession';

/** Empreinte d'une demande : cible et corps sous forme canonique (clés triées). */
export function requestHash(target: string, body: unknown): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]))
        : value;
  return createHash('sha256').update(JSON.stringify([target, canonical(body ?? null)])).digest('hex');
}

export type IdempotencyClaim =
  | { kind: 'claimed' }
  | { kind: 'replay'; status: number; body: Record<string, unknown> }
  | { kind: 'conflict' };

/** Durée de garde d'une clé (04 § 9). */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;

/**
 * Réserve une clé : neuve (ou expirée) → `claimed` ; même empreinte et réponse gardée → `replay` ; empreinte différente,
 * ou même empreinte encore en cours de traitement → `conflict`.
 */
export async function claimIdempotencyKey(db: Queryable, input: { tenantId: string; operation: IdempotentOperation; key: string; hash: string }): Promise<IdempotencyClaim> {
  // Clé expirée (plus de 24 h) : retirée d'abord, dans sa propre instruction (une instruction ne voit pas ses propres suppressions).
  await db.query('DELETE FROM idempotency_keys WHERE tenant_id = $1 AND operation = $2 AND key = $3 AND created_at < now() - make_interval(secs => $4)', [
    input.tenantId,
    input.operation,
    input.key,
    IDEMPOTENCY_TTL_SECONDS,
  ]);
  const { rows } = await db.query<{ inserted: boolean; request_hash: string; response_status: number | null; response_body: Record<string, unknown> | null }>(
    `WITH ins AS (
       INSERT INTO idempotency_keys (tenant_id, operation, key, request_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, operation, key) DO NOTHING
       RETURNING request_hash)
     SELECT true AS inserted, request_hash, NULL::int AS response_status, NULL::jsonb AS response_body FROM ins
     UNION ALL
     SELECT false, request_hash, response_status, response_body FROM idempotency_keys
      WHERE tenant_id = $1 AND operation = $2 AND key = $3 AND NOT EXISTS (SELECT 1 FROM ins)`,
    [input.tenantId, input.operation, input.key, input.hash],
  );
  const row = rows[0];
  if (!row) return { kind: 'claimed' };
  if (row.inserted) return { kind: 'claimed' };
  if (row.request_hash !== input.hash || row.response_status === null || row.response_body === null) return { kind: 'conflict' };
  return { kind: 'replay', status: row.response_status, body: row.response_body };
}

/** Réponse 2xx gardée pour la clé réservée. */
export async function completeIdempotencyKey(db: Queryable, input: { tenantId: string; operation: IdempotentOperation; key: string; status: number; body: unknown }): Promise<void> {
  await db.query('UPDATE idempotency_keys SET response_status = $4, response_body = $5 WHERE tenant_id = $1 AND operation = $2 AND key = $3', [
    input.tenantId,
    input.operation,
    input.key,
    input.status,
    JSON.stringify(input.body),
  ]);
}

/** Échec : la réservation est retirée, la clé redevient utilisable. */
export async function releaseIdempotencyKey(db: Queryable, input: { tenantId: string; operation: IdempotentOperation; key: string }): Promise<void> {
  await db.query('DELETE FROM idempotency_keys WHERE tenant_id = $1 AND operation = $2 AND key = $3 AND response_status IS NULL', [input.tenantId, input.operation, input.key]);
}
