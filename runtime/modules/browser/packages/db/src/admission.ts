// SPDX-License-Identifier: AGPL-3.0-only
// Admission des sessions (cdc/sym-browser 04b § 7, 04d § 4.2, tâche 2.4) : quotas de sessions simultanées, file FIFO
// bornée et choix du nœud.
// - La file est en base : sessions `pending` sans nœud (`node_id` NULL), ordre `created_at` puis `id`. N'importe quelle
//   passerelle la sert.
// - Toute décision (mise en file, placement) se prend sous un verrou consultatif de transaction : deux passerelles ne
//   placent jamais la même session ni plus de sessions qu'un nœud n'a d'unités. L'occupation d'un nœud est la somme des
//   poids (`slot_weight`, unités de 0.6) de ses sessions `pending` ou `running` : une fin de session rend ses unités sans
//   écriture de plus, et un battement en retard ne peut pas faire croire à des slots libres.
// - Placement : FIFO strict sur la capacité (une session qu'aucun nœud ne peut porter arrête le service de la file) ; une
//   session dont le client est à son quota de sessions simultanées attend sans bloquer les autres clients, et ses
//   suivantes attendent derrière elle (FIFO par client).
// - Nœud : parmi les `ready` de la région demandée (toutes si aucune) qui ont assez d'unités libres, le plus faible taux
//   d'occupation ; à égalité, le plus anciennement servi (`last_assigned_at`), puis l'identifiant.
// - Bornes : `queueMax` (file globale) et `queueMaxPerTenant` ne comptent que les sessions qui attendent vraiment ; une
//   demande placée tout de suite n'entre pas en file. File du client pleine alors qu'il est à son quota : `quota_exceeded`
//   (04 § 6 : sessions simultanées) ; sinon `capacity_exceeded`.
import type pg from 'pg';
import { getSessionView, insertSession, type NewSession, type SessionView } from './api.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

/** Clé du verrou consultatif d'admission : « symbadmi » en ASCII, distincte des autres clés du module. */
export const ADMISSION_LOCK_KEY = '8320802055851896169';

export type QueueLimits = { queueMax: number; queueMaxPerTenant: number };

/** 04b § 7 (« à valider, tâche 5.2 »). */
export const QUEUE_DEFAULTS: Readonly<QueueLimits> = Object.freeze({ queueMax: 50, queueMaxPerTenant: 10 });

export type EnqueueRequest = NewSession & { slotWeight: number };

export type Admitted = { sessionId: string; tenantId: string; nodeId: string; nodeUrl: string };

export type EnqueueOutcome =
  | { ok: true; session: SessionView; admitted: true; nodeId: string; nodeUrl: string; queuePosition: 0 }
  | { ok: true; session: SessionView; admitted: false; nodeId: null; nodeUrl: null; queuePosition: number; others: Admitted[] }
  | { ok: false; code: 'quota_exceeded'; quota: 'concurrent_sessions' }
  | { ok: false; code: 'capacity_exceeded'; limit: 'queue_max' | 'queue_max_per_tenant' }
  | { ok: false; code: 'session_id_taken' };

type QueuedRow = { id: string; tenant_id: string; region: string | null; slot_weight: number; max_concurrent_sessions: number };
type NodeRow = { id: string; url: string; region: string; slots_total: number; used: number; last_assigned_at: Date | null };

/** Un passage de service de la file, dans la transaction et sous le verrou de l'appelant. */
async function admitPass(db: Queryable): Promise<Admitted[]> {
  const queue = (
    await db.query<QueuedRow>(
      `SELECT s.id, s.tenant_id, s.region, s.slot_weight, t.max_concurrent_sessions
         FROM sessions s JOIN tenants t ON t.id = s.tenant_id
        WHERE s.state = 'pending' AND s.node_id IS NULL
        ORDER BY s.created_at, s.id`,
    )
  ).rows;
  if (queue.length === 0) return [];
  const active = new Map(
    (
      await db.query<{ tenant_id: string; n: number }>(
        `SELECT tenant_id, count(*)::int AS n FROM sessions
          WHERE state = 'running' OR (state = 'pending' AND node_id IS NOT NULL)
          GROUP BY tenant_id`,
      )
    ).rows.map((r) => [r.tenant_id, r.n]),
  );
  const nodes = (
    await db.query<NodeRow>(
      `SELECT n.id, n.url, n.region, n.slots_total, n.last_assigned_at,
              coalesce((SELECT sum(s.slot_weight) FROM sessions s WHERE s.node_id = n.id AND s.state IN ('pending', 'running')), 0)::int AS used
         FROM nodes n WHERE n.state = 'ready' AND n.slots_total > 0`,
    )
  ).rows;

  const admitted: Admitted[] = [];
  const waitingTenants = new Set<string>();
  for (const s of queue) {
    if (waitingTenants.has(s.tenant_id)) continue;
    if ((active.get(s.tenant_id) ?? 0) >= s.max_concurrent_sessions) {
      waitingTenants.add(s.tenant_id);
      continue;
    }
    const candidates = nodes
      .filter((n) => (s.region === null || n.region === s.region) && n.slots_total - n.used >= s.slot_weight)
      .sort(
        (a, b) =>
          a.used / a.slots_total - b.used / b.slots_total ||
          (a.last_assigned_at?.getTime() ?? -Infinity) - (b.last_assigned_at?.getTime() ?? -Infinity) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    const node = candidates[0];
    if (!node) break; // FIFO strict sur la capacité.
    await db.query("UPDATE sessions SET node_id = $2 WHERE id = $1 AND state = 'pending' AND node_id IS NULL", [s.id, node.id]);
    const { rows } = await db.query<{ at: Date }>(
      'UPDATE nodes SET last_assigned_at = clock_timestamp(), slots_free = greatest(slots_free - $2, 0) WHERE id = $1 RETURNING last_assigned_at AS at',
      [node.id, s.slot_weight],
    );
    node.used += s.slot_weight;
    node.last_assigned_at = rows[0]?.at ?? new Date();
    active.set(s.tenant_id, (active.get(s.tenant_id) ?? 0) + 1);
    admitted.push({ sessionId: s.id, tenantId: s.tenant_id, nodeId: node.id, nodeUrl: node.url });
  }
  return admitted;
}

async function inAdmission<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [ADMISSION_LOCK_KEY]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Écrit la session `pending` et la place tout de suite si un nœud et le quota du client le permettent ; sinon elle reste
 * en file, si les bornes l'acceptent (sinon rien n'est écrit). Sert aussi la file existante (sessions plus anciennes).
 */
export async function enqueueSession(pool: pg.Pool, request: EnqueueRequest, limits: QueueLimits): Promise<EnqueueOutcome> {
  return inAdmission(pool, async (db) => {
    const before = await admitPass(db);
    await db.query('SAVEPOINT enqueue');
    const inserted = await insertSession(db, request);
    if (!inserted.ok) {
      await db.query('ROLLBACK TO SAVEPOINT enqueue');
      return { ok: false, code: 'session_id_taken' };
    }
    const after = await admitPass(db);
    const others = [...before, ...after.filter((a) => a.sessionId !== inserted.session.id)];
    const mine = after.find((a) => a.sessionId === inserted.session.id);
    if (mine) {
      const session = (await getSessionView(db, { tenantId: request.tenantId, sessionId: mine.sessionId })) ?? inserted.session;
      return { ok: true, session, admitted: true, nodeId: mine.nodeId, nodeUrl: mine.nodeUrl, queuePosition: 0 };
    }
    const { rows } = await db.query<{ total: number; tenant: number; active: number; max: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE s.tenant_id = $1)::int AS tenant,
              (SELECT count(*)::int FROM sessions a WHERE a.tenant_id = $1 AND (a.state = 'running' OR (a.state = 'pending' AND a.node_id IS NOT NULL))) AS active,
              (SELECT max_concurrent_sessions FROM tenants WHERE id = $1) AS max
         FROM sessions s WHERE s.state = 'pending' AND s.node_id IS NULL AND s.id <> $2`,
      [request.tenantId, inserted.session.id],
    );
    const q = rows[0]!;
    if (q.tenant >= limits.queueMaxPerTenant) {
      await db.query('ROLLBACK TO SAVEPOINT enqueue');
      return q.active >= q.max ? { ok: false, code: 'quota_exceeded', quota: 'concurrent_sessions' } : { ok: false, code: 'capacity_exceeded', limit: 'queue_max_per_tenant' };
    }
    if (q.total >= limits.queueMax) {
      await db.query('ROLLBACK TO SAVEPOINT enqueue');
      return { ok: false, code: 'capacity_exceeded', limit: 'queue_max' };
    }
    return { ok: true, session: inserted.session, admitted: false, nodeId: null, nodeUrl: null, queuePosition: q.tenant + 1, others };
  });
}

/** Un passage de service de la file (à la libération de slots, ou périodiquement) : sessions placées. */
export async function admitQueued(pool: pg.Pool): Promise<Admitted[]> {
  return inAdmission(pool, admitPass);
}

/** Nœud attribué aux sessions données (placées par une autre passerelle) : `sessionId → nœud`. */
export async function assignedNodes(db: Queryable, sessionIds: readonly string[]): Promise<Map<string, { nodeId: string; nodeUrl: string } | null>> {
  const out = new Map<string, { nodeId: string; nodeUrl: string } | null>();
  if (sessionIds.length === 0) return out;
  const { rows } = await db.query<{ id: string; state: string; node_id: string | null; url: string | null }>(
    'SELECT s.id, s.state, s.node_id, n.url FROM sessions s LEFT JOIN nodes n ON n.id = s.node_id WHERE s.id = ANY($1::uuid[])',
    [sessionIds],
  );
  for (const r of rows) {
    if (r.node_id !== null && r.url !== null) out.set(r.id, { nodeId: r.node_id, nodeUrl: r.url });
    else if (r.state !== 'pending') out.set(r.id, null); // sortie de la file sans nœud (fin imposée)
  }
  return out;
}

/** File expirée (`QUEUE_TIMEOUT_MS`) : `failed` raison `quota`, seulement si la session attend encore (vrai alors). */
export async function abandonQueuedSession(db: Queryable, sessionId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `WITH upd AS (
       UPDATE sessions SET state = 'failed', end_reason = 'quota', ended_at = clock_timestamp()
        WHERE id = $1::uuid AND state = 'pending' AND node_id IS NULL
        RETURNING id, ended_at)
     INSERT INTO session_events (session_id, occurred_at, type, data)
     SELECT id, ended_at, 'state', jsonb_build_object('state', 'failed', 'endReason', 'quota') FROM upd`,
    [sessionId],
  );
  return rowCount === 1;
}

export type TenantLimits = { maxConcurrentSessions: number; monthlyMinutes: number; monthlyBytes: number; maxSessionSeconds: number };

/** Consommation du mois civil en cours (UTC) d'après les usages clôturés (`usage_records`, 04d § 4.1), et quotas du client. */
export async function monthlyUsage(db: Queryable, tenantId: string): Promise<{ seconds: number; bytes: number; limits: TenantLimits }> {
  const { rows } = await db.query<{ seconds: string; bytes: string; max_concurrent_sessions: number; monthly_minutes: string; monthly_bytes: string; max_session_seconds: number }>(
    `SELECT coalesce(sum(u.billed_seconds), 0)::text AS seconds, coalesce(sum(u.bytes_in + u.bytes_out), 0)::text AS bytes,
            t.max_concurrent_sessions, t.monthly_minutes::text, t.monthly_bytes::text, t.max_session_seconds
       FROM tenants t
       LEFT JOIN usage_records u ON u.tenant_id = t.id AND u.ended_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      WHERE t.id = $1::uuid
      GROUP BY t.id`,
    [tenantId],
  );
  const r = rows[0];
  if (!r) throw new Error(`client ${tenantId} introuvable`);
  return {
    seconds: Number(r.seconds),
    bytes: Number(r.bytes),
    limits: { maxConcurrentSessions: r.max_concurrent_sessions, monthlyMinutes: Number(r.monthly_minutes), monthlyBytes: Number(r.monthly_bytes), maxSessionSeconds: r.max_session_seconds },
  };
}
