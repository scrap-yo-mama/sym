// SPDX-License-Identifier: AGPL-3.0-only
// Transitions de session persistées (cdc/sym-browser 04 § 5, tâche 1.2), table de routage (AD4), battement et détection
// de nœud mort (04b § 5 et § 6). Chaque écriture d'état est UNE instruction SQL conditionnelle : la ligne est verrouillée
// (`FOR UPDATE`), l'état courant doit être une source permise par la table de `@sym-browser/core`, et l'événement `state`
// est inséré dans la même instruction. Deux écrivains concurrents (nœud, balayeur, API) : un seul gagne, aucune transition
// hors table n'atteint la base.
import { sourcesFor, type ExtendOutcome, type SessionState, type SessionStore, type TransitionInput, type TransitionOutcome } from '@sym-browser/core';
import type pg from 'pg';

type Queryable = Pick<pg.ClientBase, 'query'>;

/** Clé du verrou consultatif du balayeur de nœuds : « symbnode » en ASCII, distincte de celle des migrations. */
export const NODE_SWEEP_LOCK_KEY = '8320802056070718565';

/** Nœud déclaré `down` au-delà de 3 battements manqués (5 s chacun, 04b § 6). */
export const NODE_LOST_AFTER_MS = 15_000;

const TERMINAL_STATES = ['ended', 'timed_out', 'failed'];

export async function transitionSession(db: Queryable, input: TransitionInput): Promise<TransitionOutcome> {
  const sources = sourcesFor(input.to, input.reason);
  const { rows } = await db.query<{ current: SessionState | null; previous: SessionState | null; state: SessionState | null; at: Date | null }>(
    `WITH cur AS (SELECT id, state FROM sessions WHERE id = $1::uuid FOR UPDATE),
     upd AS (
       UPDATE sessions s
          SET state = $2,
              end_reason = $3,
              node_id = CASE WHEN $2 = 'running' THEN coalesce($4, s.node_id) ELSE s.node_id END,
              started_at = CASE WHEN $2 = 'running' THEN clock_timestamp() ELSE s.started_at END,
              ended_at = CASE WHEN $2 = ANY($6::text[]) THEN clock_timestamp() ELSE s.ended_at END
         FROM cur
        WHERE s.id = cur.id AND cur.state = ANY($5::text[])
        RETURNING s.id, s.state, s.end_reason, cur.state AS previous, coalesce(s.ended_at, s.started_at) AS at),
     ev AS (
       INSERT INTO session_events (session_id, occurred_at, type, data)
       SELECT id, at, 'state',
              jsonb_build_object('state', state) || CASE WHEN end_reason IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('endReason', end_reason) END
         FROM upd)
     SELECT (SELECT state FROM cur) AS current, upd.previous, upd.state, upd.at
       FROM (SELECT 1) one LEFT JOIN upd ON true`,
    [input.sessionId, input.to, input.reason, input.nodeId ?? null, sources, TERMINAL_STATES],
  );
  const row = rows[0];
  if (!row?.current) return { ok: false, code: 'not_found' };
  if (!row.state || !row.previous || !row.at) return { ok: false, code: 'invalid_transition', current: row.current };
  const base = { ok: true as const, previous: row.previous, state: row.state, at: row.at.getTime() };
  return input.reason === null ? base : { ...base, endReason: input.reason };
}

/** `POST /v1/sessions/{id}/extend` : ajoute `seconds`, plafonné par `tenants.max_session_seconds` depuis la création. */
export async function extendSession(db: Queryable, input: { sessionId: string; seconds: number }): Promise<ExtendOutcome> {
  if (!Number.isInteger(input.seconds) || input.seconds <= 0) throw new RangeError(`seconds : entier positif attendu (reçu ${input.seconds})`);
  const { rows } = await db.query<{ state: SessionState; expires_at: Date; updated: boolean }>(
    `WITH cur AS (
       SELECT s.id, s.state, s.expires_at, s.created_at, t.max_session_seconds
         FROM sessions s JOIN tenants t ON t.id = s.tenant_id
        WHERE s.id = $1::uuid FOR UPDATE OF s),
     upd AS (
       UPDATE sessions s
          SET expires_at = greatest(cur.expires_at,
                least(cur.expires_at + make_interval(secs => $2), cur.created_at + make_interval(secs => cur.max_session_seconds)))
         FROM cur
        WHERE s.id = cur.id AND NOT (cur.state = ANY($3::text[]))
        RETURNING s.expires_at)
     SELECT cur.state, coalesce(upd.expires_at, cur.expires_at) AS expires_at, upd.expires_at IS NOT NULL AS updated
       FROM cur LEFT JOIN upd ON true`,
    [input.sessionId, input.seconds, TERMINAL_STATES],
  );
  const row = rows[0];
  if (!row) return { ok: false, code: 'not_found' };
  if (!row.updated) return { ok: false, code: 'invalid_state', current: row.state };
  return { ok: true, expiresAt: row.expires_at.getTime() };
}

export type RouteOutcome =
  | { ok: true; nodeId: string; nodeUrl: string }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'not_running'; state: SessionState }
  | { ok: false; code: 'node_unavailable' };

/**
 * Table de routage (AD4) : nœud propriétaire d'une session `running` du client `tenantId`, résolu par `sessions.node_id`.
 * La session d'un autre client n'existe pas pour lui (BINV7) ; un nœud `down` ne reçoit plus de relais.
 */
export async function routeSession(db: Queryable, input: { sessionId: string; tenantId: string }): Promise<RouteOutcome> {
  const { rows } = await db.query<{ state: SessionState; node_id: string | null; url: string | null; node_state: string | null }>(
    `SELECT s.state, s.node_id, n.url, n.state AS node_state
       FROM sessions s LEFT JOIN nodes n ON n.id = s.node_id
      WHERE s.id = $1::uuid AND s.tenant_id = $2::uuid`,
    [input.sessionId, input.tenantId],
  );
  const row = rows[0];
  if (!row) return { ok: false, code: 'not_found' };
  if (row.state !== 'running') return { ok: false, code: 'not_running', state: row.state };
  if (!row.node_id || !row.url || row.node_state === 'down') return { ok: false, code: 'node_unavailable' };
  return { ok: true, nodeId: row.node_id, nodeUrl: row.url };
}

export type NodeBeat = {
  nodeId: string;
  url: string;
  region: string;
  playwrightVersion: string;
  chromiumVersion: string;
  appVersion: string;
  slotsTotal: number;
  slotsFree: number;
  rssBytes: number | null;
  limitBytes: number | null;
};

/**
 * Enregistrement et battement du nœud (04b § 5) : upsert de la ligne `nodes`, horloge de la base. Un nœud `down` qui bat
 * à nouveau redevient `ready` et le sait (`recovered`) : il détruit alors ses sessions locales, déjà passées `failed`.
 * Un nœud `draining` le reste.
 */
export async function recordHeartbeat(db: Queryable, beat: NodeBeat): Promise<{ state: 'ready' | 'draining'; recovered: boolean }> {
  const { rows } = await db.query<{ state: 'ready' | 'draining'; recovered: boolean }>(
    `WITH prev AS (SELECT state FROM nodes WHERE id = $1),
     up AS (
     INSERT INTO nodes (id, url, region, playwright_version, chromium_version, app_version, slots_total, slots_free, rss_bytes, limit_bytes, state, last_beat_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ready', now())
     ON CONFLICT (id) DO UPDATE SET
       url = EXCLUDED.url, region = EXCLUDED.region, playwright_version = EXCLUDED.playwright_version,
       chromium_version = EXCLUDED.chromium_version, app_version = EXCLUDED.app_version,
       slots_total = EXCLUDED.slots_total, slots_free = EXCLUDED.slots_free, rss_bytes = EXCLUDED.rss_bytes,
       limit_bytes = EXCLUDED.limit_bytes, last_beat_at = now(),
       state = CASE WHEN nodes.state = 'down' THEN 'ready' ELSE nodes.state END
     RETURNING state)
     -- État d'avant le battement : instantané de l'instruction, antérieur à l'upsert.
     SELECT up.state, coalesce((SELECT state FROM prev) = 'down', false) AS recovered FROM up`,
    [beat.nodeId, beat.url, beat.region, beat.playwrightVersion, beat.chromiumVersion, beat.appVersion, beat.slotsTotal, beat.slotsFree, beat.rssBytes, beat.limitBytes],
  );
  const row = rows[0];
  if (!row) throw new Error(`battement du nœud ${beat.nodeId} non écrit`);
  return { state: row.state, recovered: row.recovered };
}

/**
 * Balayeur de la passerelle (toutes les 5 s, 04b § 6), sous verrou consultatif : un seul balayeur agit, les autres rendent
 * la main (`locked: false`). Tout nœud muet depuis plus de `staleAfterMs` passe `down`, ses slots sont libérés, et ses
 * sessions `pending` ou `running` passent `failed` raison `node_lost` avec leur événement `state` (une instruction).
 */
export async function sweepLostNodes(db: Queryable, options: { staleAfterMs?: number } = {}): Promise<{ locked: boolean; nodes: string[]; sessions: string[] }> {
  const staleAfterMs = options.staleAfterMs ?? NODE_LOST_AFTER_MS;
  const { rows } = await db.query<{ locked: boolean; nodes: string[]; sessions: string[] }>(
    `WITH lock AS (SELECT pg_try_advisory_xact_lock($1::bigint) AS got),
     lost AS (
       UPDATE nodes SET state = 'down', slots_free = slots_total
        WHERE (SELECT got FROM lock) AND state <> 'down' AND last_beat_at < now() - make_interval(secs => $2::double precision / 1000)
        RETURNING id),
     failed AS (
       UPDATE sessions SET state = 'failed', end_reason = 'node_lost', ended_at = clock_timestamp()
        WHERE node_id IN (SELECT id FROM lost) AND state = ANY($3::text[])
        RETURNING id, ended_at),
     ev AS (
       INSERT INTO session_events (session_id, occurred_at, type, data)
       SELECT id, ended_at, 'state', jsonb_build_object('state', 'failed', 'endReason', 'node_lost') FROM failed)
     SELECT (SELECT got FROM lock) AS locked,
            coalesce((SELECT array_agg(id ORDER BY id) FROM lost), '{}') AS nodes,
            coalesce((SELECT array_agg(id::text ORDER BY id) FROM failed), '{}') AS sessions`,
    [NODE_SWEEP_LOCK_KEY, staleAfterMs, sourcesFor('failed', 'node_lost')],
  );
  const row = rows[0];
  return { locked: row?.locked === true, nodes: row?.nodes ?? [], sessions: row?.sessions ?? [] };
}

/** `SessionStore` du nœud sur PostgreSQL (accès direct à la base, 04b § 5). */
export function createPgSessionStore(db: Queryable): SessionStore {
  return {
    transition: (input) => transitionSession(db, input),
    extend: (input) => extendSession(db, input),
  };
}

