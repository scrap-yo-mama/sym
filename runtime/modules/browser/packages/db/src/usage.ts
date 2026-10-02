// SPDX-License-Identifier: AGPL-3.0-only
// Comptage en base (cdc/sym-browser 04d § 4.1, § 4.3, § 4.4 ; tâche 2.6, BINV5). Le nœud mesure, la base garde :
//   - recordUsage : clôture seule (rejeu de usage.wal, état final refusé), idempotente ; elle remplace une valeur
//     reconstruite, jamais une mesure (la clôture avec l'état final passe par transitionSession) ;
//   - recordUsageSnapshots : dernière mesure en cours de chaque session du nœud (toutes les 10 s) ;
//   - reconcileUsage : sous verrou consultatif, compare `usage_records` aux clôtures des journaux des nœuds joignables,
//     corrige à partir de ces journaux, clôt sur la dernière mesure reçue les sessions terminées sans clôture (nœud perdu,
//     fin écrite par la passerelle ; `source: reconstructed`), et garde le rapport (écart avant et après) ;
//   - queryUsage : agrégats de `GET /v1/usage` et de l'export CSV, sur la date de fin, période [from, to).
// Dates : ms entières depuis l'époque Unix, converties sans flottant (`'epoch' + n * 1 ms`) ; fin = début + durée.
import type { RecordUsageOutcome, UsageClosure } from '@sym-browser/core';
import type pg from 'pg';

type Queryable = Pick<pg.ClientBase, 'query'>;

/** Clé du verrou consultatif de la réconciliation : « symbusag » en ASCII. */
export const USAGE_RECONCILE_LOCK_KEY = '8320802056188420455';

const TERMINAL_STATES = ['ended', 'timed_out', 'failed'];
const at = (ms: string): string => `('epoch'::timestamptz + (${ms})::bigint * interval '1 millisecond')`;

/** Clôture seule : `inserted`, `replaced` (reconstruction remplacée), `unchanged` (déjà mesurée), `not_found`. */
export async function recordUsage(db: Queryable, closure: UsageClosure): Promise<RecordUsageOutcome> {
  const { rows } = await db.query<{ found: boolean; previous: string | null; written: boolean }>(
    `WITH s AS (SELECT id, tenant_id, api_key_id FROM sessions WHERE id = $1::uuid),
     prev AS (SELECT source FROM usage_records WHERE session_id = $1::uuid),
     up AS (
       INSERT INTO usage_records (session_id, tenant_id, api_key_id, node_id, started_at, ended_at, browser_ms, billed_seconds, bytes_in, bytes_out, source)
       SELECT s.id, s.tenant_id, s.api_key_id, $2, ${at('$3')}, ${at('$3::bigint + $4::bigint')}, $4, ($4::bigint + 999) / 1000, $5, $6, 'node' FROM s
       ON CONFLICT (session_id) DO UPDATE SET
         node_id = EXCLUDED.node_id, started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at, browser_ms = EXCLUDED.browser_ms,
         billed_seconds = EXCLUDED.billed_seconds, bytes_in = EXCLUDED.bytes_in, bytes_out = EXCLUDED.bytes_out, source = 'node', updated_at = now()
        WHERE usage_records.source = 'reconstructed'
       RETURNING 1)
     SELECT EXISTS (SELECT 1 FROM s) AS found, (SELECT source FROM prev) AS previous, EXISTS (SELECT 1 FROM up) AS written`,
    [closure.sessionId, closure.nodeId, closure.startedAt, closure.browserMs, closure.bytesIn, closure.bytesOut],
  );
  const row = rows[0];
  if (!row?.found) return 'not_found';
  if (!row.written) return 'unchanged';
  return row.previous === null ? 'inserted' : 'replaced';
}

const columns = (closures: readonly UsageClosure[]): unknown[] => [
  closures.map((c) => c.sessionId),
  closures.map((c) => c.nodeId),
  closures.map((c) => c.startedAt),
  closures.map((c) => c.browserMs),
  closures.map((c) => c.bytesIn),
  closures.map((c) => c.bytesOut),
];
const UNNEST = `unnest($1::uuid[], $2::text[], $3::bigint[], $4::bigint[], $5::bigint[], $6::bigint[]) AS c(session_id, node_id, started_ms, browser_ms, bytes_in, bytes_out)`;

/** Instantanés du nœud : la mesure la plus longue de chaque session est gardée ; sessions inconnues ignorées. */
export async function recordUsageSnapshots(db: Queryable, nodeId: string, snapshots: readonly UsageClosure[]): Promise<void> {
  if (snapshots.length === 0) return;
  await db.query(
    `INSERT INTO usage_snapshots (session_id, node_id, started_at, browser_ms, bytes_in, bytes_out, measured_at)
     SELECT c.session_id, $7, ${at('c.started_ms')}, c.browser_ms, c.bytes_in, c.bytes_out, now()
       FROM ${UNNEST} JOIN sessions s ON s.id = c.session_id
     ON CONFLICT (session_id) DO UPDATE SET
       node_id = EXCLUDED.node_id, started_at = EXCLUDED.started_at, browser_ms = EXCLUDED.browser_ms,
       bytes_in = EXCLUDED.bytes_in, bytes_out = EXCLUDED.bytes_out, measured_at = EXCLUDED.measured_at
      WHERE EXCLUDED.browser_ms >= usage_snapshots.browser_ms`,
    [...columns(snapshots), nodeId],
  );
}

export type UsageReconciliation = {
  ranAt: Date;
  /** Clôtures lues dans les journaux des nœuds joignables (une par session). */
  closures: number;
  inserted: number;
  replaced: number;
  reconstructed: number;
  /** Écart avant correction, contre les journaux : Σ |secondes facturées − ceil(durée mesurée)|, Σ |octets − octets mesurés|. */
  driftSeconds: number;
  driftBytes: number;
  /** Écart après correction (0 attendu). */
  remainingDriftSeconds: number;
  remainingDriftBytes: number;
};

/** Écart de `usage_records` contre les clôtures (sessions connues seulement). */
const DRIFT = `
  SELECT coalesce(sum(abs(coalesce(u.billed_seconds, 0) - (c.browser_ms + 999) / 1000)), 0)::text AS seconds,
         coalesce(sum(abs(coalesce(u.bytes_in, 0) - c.bytes_in) + abs(coalesce(u.bytes_out, 0) - c.bytes_out)), 0)::text AS bytes
    FROM ${UNNEST} JOIN sessions s ON s.id = c.session_id LEFT JOIN usage_records u ON u.session_id = c.session_id`;

/**
 * Réconciliation (04d § 4.4) sous verrou consultatif (une seule passerelle à la fois). `closures` : contenu des usage.wal
 * des nœuds joignables ; pour une même session, la dernière clôture du journal fait foi.
 */
export async function reconcileUsage(pool: pg.Pool, input: { closures: readonly UsageClosure[] }): Promise<UsageReconciliation> {
  const closures = [...new Map(input.closures.map((c) => [c.sessionId, c])).values()];
  const params = columns(closures);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [USAGE_RECONCILE_LOCK_KEY]);
    const before = (await client.query<{ seconds: string; bytes: string }>(DRIFT, params)).rows[0];

    // Corrections à partir des journaux : clôture absente, reconstruite, ou différente de la mesure.
    const fixed = await client.query<{ inserted: string; replaced: string }>(
      `WITH j AS (
         SELECT c.*, s.tenant_id, s.api_key_id, u.source AS cur_source, u.browser_ms AS cur_ms, u.bytes_in AS cur_in, u.bytes_out AS cur_out
           FROM ${UNNEST} JOIN sessions s ON s.id = c.session_id LEFT JOIN usage_records u ON u.session_id = c.session_id),
       w AS (
         INSERT INTO usage_records (session_id, tenant_id, api_key_id, node_id, started_at, ended_at, browser_ms, billed_seconds, bytes_in, bytes_out, source)
         SELECT session_id, tenant_id, api_key_id, node_id, ${at('started_ms')}, ${at('started_ms + browser_ms')}, browser_ms, (browser_ms + 999) / 1000, bytes_in, bytes_out, 'node'
           FROM j
          WHERE cur_source IS DISTINCT FROM 'node' OR (cur_ms, cur_in, cur_out) IS DISTINCT FROM (browser_ms, bytes_in, bytes_out)
         ON CONFLICT (session_id) DO UPDATE SET
           node_id = EXCLUDED.node_id, started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at, browser_ms = EXCLUDED.browser_ms,
           billed_seconds = EXCLUDED.billed_seconds, bytes_in = EXCLUDED.bytes_in, bytes_out = EXCLUDED.bytes_out, source = 'node', updated_at = now()
         RETURNING session_id)
       SELECT count(*) FILTER (WHERE j.cur_source IS NULL)::text AS inserted, count(*) FILTER (WHERE j.cur_source IS NOT NULL)::text AS replaced
         FROM j JOIN w ON w.session_id = j.session_id`,
      params,
    );

    // Sessions terminées, démarrées, sans clôture : closes sur la dernière mesure reçue (instantané), sinon sur leurs dates
    // (fin bornée au dernier battement d'un nœud perdu).
    const rebuilt = await client.query(
      `WITH lost AS (
         SELECT s.id, s.tenant_id, s.api_key_id, coalesce(sn.node_id, s.node_id) AS node_id, coalesce(sn.started_at, s.started_at) AS started_at,
                coalesce(sn.browser_ms, greatest(0, floor(extract(epoch FROM
                  (CASE WHEN n.state = 'down' THEN least(s.ended_at, n.last_beat_at) ELSE s.ended_at END) - s.started_at) * 1000))::bigint) AS browser_ms,
                coalesce(sn.bytes_in, 0) AS bytes_in, coalesce(sn.bytes_out, 0) AS bytes_out
           FROM sessions s
           LEFT JOIN usage_records u ON u.session_id = s.id
           LEFT JOIN usage_snapshots sn ON sn.session_id = s.id
           LEFT JOIN nodes n ON n.id = s.node_id
          WHERE u.session_id IS NULL AND s.state = ANY($1::text[]) AND s.started_at IS NOT NULL AND coalesce(sn.node_id, s.node_id) IS NOT NULL)
       INSERT INTO usage_records (session_id, tenant_id, api_key_id, node_id, started_at, ended_at, browser_ms, billed_seconds, bytes_in, bytes_out, source)
       SELECT id, tenant_id, api_key_id, node_id, started_at, started_at + browser_ms * interval '1 millisecond', browser_ms, (browser_ms + 999) / 1000,
              bytes_in, bytes_out, 'reconstructed'
         FROM lost
       ON CONFLICT (session_id) DO NOTHING`,
      [TERMINAL_STATES],
    );
    // Les instantanés des sessions clôturées par leur nœud ne servent plus.
    await client.query("DELETE FROM usage_snapshots sn USING usage_records u WHERE u.session_id = sn.session_id AND u.source = 'node'");

    const after = (await client.query<{ seconds: string; bytes: string }>(DRIFT, params)).rows[0];
    const report: Omit<UsageReconciliation, 'ranAt'> = {
      closures: closures.length,
      inserted: Number(fixed.rows[0]?.inserted ?? 0),
      replaced: Number(fixed.rows[0]?.replaced ?? 0),
      reconstructed: rebuilt.rowCount ?? 0,
      driftSeconds: Number(before?.seconds ?? 0),
      driftBytes: Number(before?.bytes ?? 0),
      remainingDriftSeconds: Number(after?.seconds ?? 0),
      remainingDriftBytes: Number(after?.bytes ?? 0),
    };
    const saved = await client.query<{ ran_at: Date }>(
      `INSERT INTO usage_reconciliations (closures, inserted, replaced, reconstructed, drift_seconds, drift_bytes, remaining_drift_seconds, remaining_drift_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ran_at`,
      [report.closures, report.inserted, report.replaced, report.reconstructed, report.driftSeconds, report.driftBytes, report.remainingDriftSeconds, report.remainingDriftBytes],
    );
    await client.query('COMMIT');
    return { ranAt: saved.rows[0]?.ran_at ?? new Date(), ...report };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Dernier rapport de réconciliation (écran Consommation), ou `null`. */
export async function lastUsageReconciliation(db: Queryable): Promise<UsageReconciliation | null> {
  const { rows } = await db.query<Record<string, string | Date>>(
    `SELECT ran_at, closures, inserted, replaced, reconstructed, drift_seconds::text, drift_bytes::text, remaining_drift_seconds::text, remaining_drift_bytes::text
       FROM usage_reconciliations ORDER BY id DESC LIMIT 1`,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    ranAt: r['ran_at'] as Date,
    closures: Number(r['closures']),
    inserted: Number(r['inserted']),
    replaced: Number(r['replaced']),
    reconstructed: Number(r['reconstructed']),
    driftSeconds: Number(r['drift_seconds']),
    driftBytes: Number(r['drift_bytes']),
    remainingDriftSeconds: Number(r['remaining_drift_seconds']),
    remainingDriftBytes: Number(r['remaining_drift_bytes']),
  };
}

export type UsageGroup = 'key' | 'day' | 'session';

export type UsageQuery = {
  tenantId: string;
  /** Période [from, to) sur la date de fin de session. */
  from: Date;
  to: Date;
  /** La clé fait toujours partie du regroupement (une ligne porte sa clé) ; `day` en UTC. */
  groupBy: readonly UsageGroup[];
  apiKeyId?: string;
};

export type UsageTotals = { sessions: number; billedSeconds: number; bytesIn: number; bytesOut: number };
export type UsageRow = UsageTotals & { apiKeyId: string; apiKeyPrefix: string; day?: string; sessionId?: string };

/** Agrégats de l'API d'usage (04d § 4.3) : lignes triées par jour, clé, session ; totaux = somme des lignes. */
export async function queryUsage(db: Queryable, query: UsageQuery): Promise<{ items: UsageRow[]; totals: UsageTotals }> {
  const byDay = query.groupBy.includes('day');
  const bySession = query.groupBy.includes('session');
  const keys = ['u.api_key_id', 'k.key_prefix', ...(byDay ? ["to_char(u.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')"] : []), ...(bySession ? ['u.session_id'] : [])];
  const { rows } = await db.query<{ api_key_id: string; key_prefix: string; day?: string; session_id?: string; sessions: string; billed: string; bytes_in: string; bytes_out: string }>(
    `SELECT u.api_key_id, k.key_prefix,
            ${byDay ? "to_char(u.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day," : ''}
            ${bySession ? 'u.session_id,' : ''}
            count(*)::text AS sessions, sum(u.billed_seconds)::text AS billed, sum(u.bytes_in)::text AS bytes_in, sum(u.bytes_out)::text AS bytes_out
       FROM usage_records u JOIN api_keys k ON k.id = u.api_key_id AND k.tenant_id = u.tenant_id
      WHERE u.tenant_id = $1::uuid AND u.ended_at >= $2 AND u.ended_at < $3 AND ($4::uuid IS NULL OR u.api_key_id = $4::uuid)
      GROUP BY ${keys.join(', ')}
      ORDER BY ${[...(byDay ? ['3'] : []), 'u.api_key_id', ...(bySession ? ['u.session_id'] : [])].join(', ')}`,
    [query.tenantId, query.from, query.to, query.apiKeyId ?? null],
  );
  const items = rows.map(
    (r): UsageRow => ({
      apiKeyId: r.api_key_id,
      apiKeyPrefix: r.key_prefix,
      ...(byDay ? { day: r.day ?? '' } : {}),
      ...(bySession ? { sessionId: r.session_id ?? '' } : {}),
      sessions: Number(r.sessions),
      billedSeconds: Number(r.billed),
      bytesIn: Number(r.bytes_in),
      bytesOut: Number(r.bytes_out),
    }),
  );
  const totals = items.reduce<UsageTotals>(
    (acc, i) => ({ sessions: acc.sessions + i.sessions, billedSeconds: acc.billedSeconds + i.billedSeconds, bytesIn: acc.bytesIn + i.bytesIn, bytesOut: acc.bytesOut + i.bytesOut }),
    { sessions: 0, billedSeconds: 0, bytesIn: 0, bytesOut: 0 },
  );
  return { items, totals };
}
