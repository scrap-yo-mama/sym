// SPDX-License-Identifier: AGPL-3.0-only
// Purge en trois phases (14 § 9, 17 § 6), chacune idempotente et reprenable : l'état est dans les données.
//  1. Marquage (toutes les heures) : `deleted_at` sur les datasets expirés hors épinglage valide (l'API répond 410).
//  2. Suppression physique (chaque jour, fenêtre de 15 min) : partition mensuelle révolue sans aucune ligne conservée =
//     DETACH … CONCURRENTLY, revérification sous verrou des datasets, puis DROP (ou ré-attachement si un dataset a été
//     épinglé ou restauré entre-temps) ; sinon DELETE par lots (ctid). Un dataset est « fini » quand `item_count` et
//     `bytes` valent 0 : un arrêt au milieu laisse ces compteurs non nuls et la passe suivante reprend où elle en était.
//  3. Nettoyage (chaque jour) : charges d'enquête, `error_detail`, entrées de run, journaux, artefacts, runs terminés,
//     `dedup_keys`, `audit_events` au-delà de 12 mois. Les jobs pg-boss terminés suivent la rétention native de la file
//     (`deleteAfterSeconds`, `runQueueDefinition`).
// `runRetentionTick` (worker) enchaîne les phases selon leur fréquence, sous un verrou consultatif de session : jamais
// deux passes (ni deux DETACH CONCURRENTLY) à la fois sur l'instance. L'horloge est injectée (`now`, `clock`). Un item
// inchangé retrouvé ne repousse aucune échéance. Identité système (propriétaire des tables, hors RLS).
import pg from 'pg';
import { appendAudit } from '../audit.js';
import { ensureDatasetItemsPartitions, listDatasetItemsPartitions } from '../partitions.js';
import { DEFAULT_RETENTION_POLICY, type RetentionPolicy } from './policy.js';

type Queryable = Pick<pg.ClientBase, 'query'>;
/** Connexion de session (DETACH CONCURRENTLY, transactions) : un `pg.Pool` est remplacé par un client dédié. */
type SessionDb = pg.Pool | pg.ClientBase;

export const PURGE_BATCH_SIZE = 5000;
/** Fenêtre de la phase 2 (14 § 9 : lots dans une fenêtre de 15 min). */
export const PURGE_MAX_DURATION_MS = 15 * 60_000;
/** Verrou consultatif de session des passes de rétention (distinct de ceux des migrations et des secrets). */
export const RETENTION_LOCK_KEY = '8315178094305570147';
export const RETENTION_STATE_SETTING = 'retention_state';
const PARTITION_NAME = /^dataset_items_p(\d{4})(\d{2})$/;
const ACTIVE_STATES = ['queued', 'running', 'waiting_tunnel'];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function withSession<T>(db: SessionDb, fn: (client: pg.ClientBase) => Promise<T>): Promise<T> {
  if (!(db instanceof pg.Pool)) return fn(db);
  const client = await db.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Dataset protégé par un épinglage en cours de validité (raison et échéance obligatoires, 0009). */
const PINNED_VALID = (d: string, now: string) => `(${d}.pinned AND ${d}.pinned_until > ${now})`;

export type MarkResult = { marked: number };

/** Phase 1. Échéance = min(expires_at ou création + retention_days ou défaut, création + plafond d'instance). */
export async function markExpiredDatasets(
  db: Queryable,
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): Promise<MarkResult> {
  const { rowCount } = await db.query(
    `UPDATE datasets d
        SET deleted_at = $1
      WHERE d.deleted_at IS NULL AND NOT ${PINNED_VALID('d', '$1')}
        AND LEAST(
              coalesce(d.expires_at, d.created_at + make_interval(days => coalesce(d.retention_days, $2))),
              d.created_at + make_interval(days => $3)
            ) <= $1`,
    [now, policy.datasetsDays, policy.datasetsMaxDays],
  );
  return { marked: rowCount ?? 0 };
}

export type PhysicalPurgeOptions = {
  batchSize?: number;
  /** Borne le nombre de lots de cette passe (reprise par la passe suivante). */
  maxBatches?: number;
  /** Durée maximale de la passe (défaut 15 min), vérifiée entre deux lots et entre deux partitions. */
  maxDurationMs?: number;
  /** Horloge (ms) de l'échéance : injectable pour les tests. */
  clock?: () => number;
  /** Tests : appelé juste après le DETACH d'une partition, avant la revérification. */
  afterDetach?: (partition: string) => Promise<void>;
};
export type PhysicalPurgeResult = { partitionsDropped: string[]; itemsDeleted: number; datasetsPurged: number; complete: boolean };

/** Premier jour (UTC) du mois suivant la partition : borne haute exclue. */
function partitionUpperBound(name: string): Date | null {
  const m = PARTITION_NAME.exec(name);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
}

/**
 * DETACH CONCURRENTLY, puis, dans une transaction qui verrouille (FOR UPDATE) les datasets de la partition détachée :
 * DROP si tous sont encore purgeables, sinon ré-attachement (un épinglage ou une restauration est arrivé entre la
 * vérification et le DETACH). Renvoie le nombre d'items supprimés, ou `null` si la partition a été rattachée.
 */
async function detachAndDrop(db: pg.ClientBase, name: string, bounds: string, now: Date, opts: PhysicalPurgeOptions): Promise<number | null> {
  if (!PARTITION_NAME.test(name)) throw new Error(`partition invalide : ${name}`);
  await db.query(`ALTER TABLE dataset_items DETACH PARTITION ${name} CONCURRENTLY`);
  await opts.afterDetach?.(name);
  await db.query('BEGIN');
  try {
    const { rows } = await db.query<{ keep: boolean }>(
      `SELECT NOT (d.deleted_at IS NOT NULL AND NOT ${PINNED_VALID('d', '$1')}) AS keep
         FROM datasets d WHERE d.id IN (SELECT DISTINCT dataset_id FROM ${name}) FOR UPDATE OF d`,
      [now],
    );
    if (rows.some((r) => r.keep)) {
      await db.query(`ALTER TABLE dataset_items ATTACH PARTITION ${name} ${bounds}`);
      await db.query('COMMIT');
      return null;
    }
    const n = Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${name}`)).rows[0]!.n);
    await db.query(`DROP TABLE ${name}`);
    await db.query('COMMIT');
    return n;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/** Phase 2. `db` : pool ou connexion hors transaction (DETACH CONCURRENTLY). */
export async function purgeMarkedDatasets(db: SessionDb, now: Date, opts: PhysicalPurgeOptions = {}): Promise<PhysicalPurgeResult> {
  return withSession(db, async (client) => {
    const batchSize = opts.batchSize ?? PURGE_BATCH_SIZE;
    const clock = opts.clock ?? Date.now;
    const deadline = clock() + (opts.maxDurationMs ?? PURGE_MAX_DURATION_MS);
    let batchesLeft = opts.maxBatches ?? Number.POSITIVE_INFINITY;
    const result: PhysicalPurgeResult = { partitionsDropped: [], itemsDeleted: 0, datasetsPurged: 0, complete: true };
    const purgeable = `d.deleted_at IS NOT NULL AND NOT ${PINNED_VALID('d', '$1')}`;
    const stop = () => {
      if (batchesLeft > 0 && clock() < deadline) return false;
      result.complete = false;
      return true;
    };

    for (const part of await listDatasetItemsPartitions(client)) {
      const upper = partitionUpperBound(part.name);
      if (!upper) continue; // partition inconnue (par défaut, manuelle) : jamais touchée
      if (stop()) break;
      const past = upper.getTime() <= now.getTime();
      const keepsRows = async () =>
        (
          await client.query<{ keep: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM ${part.name} i JOIN datasets d ON d.id = i.dataset_id WHERE NOT (${purgeable})) AS keep`,
            [now],
          )
        ).rows[0]!.keep;
      const dropWhole = async () => {
        const n = await detachAndDrop(client, part.name, part.bounds, now, opts);
        if (n === null) return;
        result.partitionsDropped.push(part.name);
        result.itemsDeleted += n;
      };

      if (past && !(await keepsRows())) {
        await dropWhole();
        continue;
      }
      // Partition mixte (ou mois en cours) : DELETE par lots des seuls items de datasets purgeables.
      for (;;) {
        if (stop()) break;
        const { rowCount } = await client.query(
          `DELETE FROM ${part.name}
            WHERE ctid IN (SELECT i.ctid FROM ${part.name} i JOIN datasets d ON d.id = i.dataset_id WHERE ${purgeable} LIMIT $2)`,
          [now, batchSize],
        );
        if (!rowCount) break;
        batchesLeft -= 1;
        result.itemsDeleted += rowCount;
      }
      if (!result.complete) break;
      if (past && !(await keepsRows())) await dropWhole();
    }

    // Datasets dont plus aucun item ne subsiste : tombstone (410) à compteurs nuls = fin de la phase 2 pour eux.
    const { rowCount } = await client.query(
      `UPDATE datasets d SET item_count = 0, bytes = 0
        WHERE ${purgeable} AND (d.item_count <> 0 OR d.bytes <> 0)
          AND NOT EXISTS (SELECT 1 FROM dataset_items i WHERE i.dataset_id = d.id)`,
      [now],
    );
    result.datasetsPurged = rowCount ?? 0;
    return result;
  });
}

export type CleanupResult = Record<
  'investigation_payloads' | 'error_detail' | 'run_inputs' | 'run_logs' | 'run_artifacts' | 'tunnel_jobs' | 'runs' | 'dedup_keys' | 'audit_events',
  number
>;

/** Phase 3. Comptes par table (journal de purge). Les runs actifs ne sont jamais touchés. */
export async function cleanupExpiredRunData(
  db: Queryable,
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): Promise<CleanupResult> {
  const count = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rowCount ?? 0;
  const before = (days: number) => new Date(now.getTime() - days * DAY);
  const samples = before(policy.samplesDays);
  const logs = before(policy.logsDays);
  const artifacts = before(policy.artifactsDays);
  const runs = before(policy.runsDays);
  const out = {} as CleanupResult;

  // Échantillons d'enquête (17 § 6) : toute charge, quel que soit le kind ; le squelette technique (run, seq, kind, at)
  // reste jusqu'à la purge du run.
  out.investigation_payloads = await count(
    `UPDATE investigation_events SET payload = '{}'::jsonb WHERE at < $1 AND payload <> '{}'::jsonb`,
    [samples],
  );
  out.error_detail = await count(
    `UPDATE runs SET error_detail = NULL WHERE error_detail IS NOT NULL AND state <> ALL($2::text[]) AND coalesce(finished_at, created_at) < $1`,
    [samples, ACTIVE_STATES],
  );
  out.run_inputs = await count(
    `UPDATE runs SET input = NULL WHERE input IS NOT NULL AND state <> ALL($2::text[]) AND created_at < $1`,
    [samples, ACTIVE_STATES],
  );
  out.run_logs = await count(`DELETE FROM run_logs WHERE ts < $1`, [logs]);
  out.run_artifacts = await count(`DELETE FROM run_artifacts WHERE created_at < $1`, [artifacts]);
  out.tunnel_jobs = await count(`DELETE FROM tunnel_jobs WHERE state <> 'pending' AND updated_at < $1`, [logs]);
  // run_attempts, investigation_events, run_logs, run_artifacts, tunnel_jobs : ON DELETE CASCADE ; datasets.run_id et
  // status_events.run_id : ON DELETE SET NULL.
  out.runs = await count(`DELETE FROM runs WHERE state <> ALL($2::text[]) AND coalesce(finished_at, created_at) < $1`, [runs, ACTIVE_STATES]);
  out.dedup_keys = await count(`DELETE FROM dedup_keys WHERE last_seen < $1`, [runs]);
  out.audit_events = await count(`DELETE FROM audit_events WHERE at < $1`, [before(policy.auditDays)]);
  return out;
}

export type RetentionReport = { at: string; phase1: MarkResult; phase2: PhysicalPurgeResult; phase3: CleanupResult };

/**
 * Passe complète (marquage, suppression, nettoyage), journalisée par table dans `audit_events` (action `retention.purge`,
 * acteur système, comptes seulement, aucune donnée de contenu). `db` : pool ou connexion hors transaction.
 */
export async function runRetention(
  db: SessionDb,
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
  opts: PhysicalPurgeOptions = {},
): Promise<RetentionReport> {
  return withSession(db, async (client) => {
    const phase1 = await markExpiredDatasets(client, now, policy);
    const phase2 = await purgeMarkedDatasets(client, now, opts);
    const phase3 = await cleanupExpiredRunData(client, now, policy);
    const report: RetentionReport = { at: now.toISOString(), phase1, phase2, phase3 };
    await appendAudit(client, {
      actorUserId: null,
      actorVia: 'system',
      action: 'retention.purge',
      targetType: 'instance',
      outcome: 'success',
      meta: {
        datasets_marked: phase1.marked,
        datasets_purged: phase2.datasetsPurged,
        items_deleted: phase2.itemsDeleted,
        partitions_dropped: phase2.partitionsDropped,
        complete: phase2.complete,
        ...Object.fromEntries(Object.entries(phase3).map(([k, v]) => [`rows_${k}`, v])),
      },
    });
    return report;
  });
}

export type RetentionTickResult = { skipped: boolean; hourly: boolean; daily: boolean; report?: RetentionReport; marked?: number };
type RetentionState = { hourly_at?: string; daily_at?: string };

/**
 * Passe planifiée (appelée régulièrement par chaque worker) : marquage si la dernière date d'au moins une heure ;
 * `ensure_partitions`, suppression et nettoyage si la dernière passe complète date d'au moins un jour. Verrou
 * consultatif de session : si une autre instance tient la passe, celle-ci est sautée. État : `settings.retention_state`.
 */
export async function runRetentionTick(
  pool: pg.Pool,
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
  opts: PhysicalPurgeOptions = {},
): Promise<RetentionTickResult> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS ok', [RETENTION_LOCK_KEY]);
    if (!rows[0]?.ok) return { skipped: true, hourly: false, daily: false };
    try {
      const state =
        (await client.query<{ value: RetentionState }>('SELECT value FROM settings WHERE key = $1', [RETENTION_STATE_SETTING])).rows[0]?.value ?? {};
      const since = (iso: string | undefined) => (iso ? now.getTime() - new Date(iso).getTime() : Number.POSITIVE_INFINITY);
      const daily = since(state.daily_at) >= DAY;
      const hourly = daily || since(state.hourly_at) >= HOUR;
      const result: RetentionTickResult = { skipped: false, hourly, daily };
      if (daily) {
        await ensureDatasetItemsPartitions(client, now);
        result.report = await runRetention(client, now, policy, opts);
        state.daily_at = now.toISOString();
        state.hourly_at = now.toISOString();
      } else if (hourly) {
        result.marked = (await markExpiredDatasets(client, now, policy)).marked;
        if (result.marked > 0) {
          await appendAudit(client, {
            actorUserId: null,
            actorVia: 'system',
            action: 'retention.mark',
            targetType: 'instance',
            outcome: 'success',
            meta: { datasets_marked: result.marked },
          });
        }
        state.hourly_at = now.toISOString();
      }
      if (hourly) {
        await client.query(
          `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [RETENTION_STATE_SETTING, JSON.stringify(state)],
        );
      }
      return result;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [RETENTION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
