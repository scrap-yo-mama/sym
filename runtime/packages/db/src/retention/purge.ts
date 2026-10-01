// Purge en trois phases (14 § 9, 17 § 6), chacune idempotente et reprenable : l'état est dans les données.
//  1. Marquage : `deleted_at` sur les datasets expirés et non épinglés (l'API répond 410).
//  2. Suppression physique : partition mensuelle révolue sans aucune ligne conservée = DETACH … CONCURRENTLY puis DROP ;
//     sinon DELETE par lots (ctid) dans la partition. Un dataset est « fini » quand `item_count` et `bytes` valent 0 :
//     un arrêt au milieu laisse ces compteurs non nuls et la passe suivante reprend où elle en était.
//  3. Nettoyage : échantillons, `error_detail`, entrées de run, journaux, artefacts, runs terminés, `dedup_keys`.
// L'horloge est injectée (`now`). Un item inchangé retrouvé ne repousse aucune échéance : aucune des échéances ne lit
// `dedup_keys.last_seen` ni ne dépend d'une relecture des items. Identité système (propriétaire des tables, hors RLS).
import type pg from 'pg';
import { appendAudit } from '../audit.js';
import { dropDatasetItemsPartition, listDatasetItemsPartitions } from '../partitions.js';
import { DEFAULT_RETENTION_POLICY, type RetentionPolicy } from './policy.js';

type Queryable = Pick<pg.ClientBase, 'query'>;
export const PURGE_BATCH_SIZE = 5000;
const PARTITION_NAME = /^dataset_items_p(\d{4})(\d{2})$/;
const ACTIVE_STATES = ['queued', 'running', 'waiting_tunnel'];


export type MarkResult = { marked: number };

/** Phase 1. Échéance = min(expires_at ou création + retention_days ou défaut, création + plafond d'instance). */
export async function markExpiredDatasets(
  db: Queryable,
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): Promise<MarkResult> {
  const { rowCount } = await db.query(
    `UPDATE datasets
        SET deleted_at = $1
      WHERE deleted_at IS NULL AND NOT pinned
        AND LEAST(
              coalesce(expires_at, created_at + make_interval(days => coalesce(retention_days, $2))),
              created_at + make_interval(days => $3)
            ) <= $1`,
    [now, policy.datasetsDays, policy.datasetsMaxDays],
  );
  return { marked: rowCount ?? 0 };
}

export type PhysicalPurgeOptions = {
  batchSize?: number;
  /** Borne le nombre de lots de cette passe (reprise par la passe suivante). */
  maxBatches?: number;
};
export type PhysicalPurgeResult = { partitionsDropped: string[]; itemsDeleted: number; datasetsPurged: number; complete: boolean };

/** Premier jour (UTC) du mois suivant la partition : borne haute exclue. */
function partitionUpperBound(name: string): Date | null {
  const m = PARTITION_NAME.exec(name);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
}

/** Phase 2. `db` : connexion hors transaction (DETACH CONCURRENTLY). */
export async function purgeMarkedDatasets(db: Queryable, now: Date, opts: PhysicalPurgeOptions = {}): Promise<PhysicalPurgeResult> {
  const batchSize = opts.batchSize ?? PURGE_BATCH_SIZE;
  let batchesLeft = opts.maxBatches ?? Number.POSITIVE_INFINITY;
  const result: PhysicalPurgeResult = { partitionsDropped: [], itemsDeleted: 0, datasetsPurged: 0, complete: true };
  const purgeable = 'd.deleted_at IS NOT NULL AND NOT d.pinned';

  for (const part of await listDatasetItemsPartitions(db)) {
    const upper = partitionUpperBound(part.name);
    if (!upper) continue; // partition inconnue (par défaut, manuelle) : jamais touchée
    const past = upper.getTime() <= now.getTime();
    const keepsRows = async () =>
      (
        await db.query<{ keep: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM ${part.name} i JOIN datasets d ON d.id = i.dataset_id WHERE NOT (${purgeable})) AS keep`,
        )
      ).rows[0]!.keep;

    if (!(await keepsRows()) && past) {
      const n = (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${part.name}`)).rows[0]!.n;
      await dropDatasetItemsPartition(db, part.name);
      result.partitionsDropped.push(part.name);
      result.itemsDeleted += Number(n);
      continue;
    }
    // Partition mixte (ou mois en cours) : DELETE par lots des seuls items de datasets purgeables.
    for (;;) {
      if (batchesLeft <= 0) {
        result.complete = false;
        break;
      }
      const { rowCount } = await db.query(
        `DELETE FROM ${part.name}
          WHERE ctid IN (SELECT i.ctid FROM ${part.name} i JOIN datasets d ON d.id = i.dataset_id WHERE ${purgeable} LIMIT $1)`,
        [batchSize],
      );
      if (!rowCount) break;
      batchesLeft -= 1;
      result.itemsDeleted += rowCount;
    }
    if (past && result.complete && !(await keepsRows())) {
      await dropDatasetItemsPartition(db, part.name);
      result.partitionsDropped.push(part.name);
    }
  }

  // Datasets dont plus aucun item ne subsiste : tombstone (410) à compteurs nuls = fin de la phase 2 pour eux.
  const { rowCount } = await db.query(
    `UPDATE datasets d SET item_count = 0, bytes = 0
      WHERE ${purgeable} AND (d.item_count <> 0 OR d.bytes <> 0)
        AND NOT EXISTS (SELECT 1 FROM dataset_items i WHERE i.dataset_id = d.id)`,
  );
  result.datasetsPurged = rowCount ?? 0;
  return result;
}

export type CleanupResult = Record<
  'sample_events' | 'error_detail' | 'run_inputs' | 'run_logs' | 'run_artifacts' | 'tunnel_jobs' | 'runs' | 'dedup_keys',
  number
>;

/** Phase 3. Comptes par table (journal de purge). Les runs actifs ne sont jamais touchés. */
export async function cleanupExpiredRunData(
  db: Queryable,
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): Promise<CleanupResult> {
  const count = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rowCount ?? 0;
  const before = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const samples = before(policy.samplesDays);
  const logs = before(policy.logsDays);
  const artifacts = before(policy.artifactsDays);
  const runs = before(policy.runsDays);
  const out = {} as CleanupResult;

  out.sample_events = await count(`DELETE FROM investigation_events WHERE kind = 'sample' AND at < $1`, [samples]);
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
  return out;
}

export type RetentionReport = { at: string; phase1: MarkResult; phase2: PhysicalPurgeResult; phase3: CleanupResult };

/**
 * Passe complète (marquage, suppression, nettoyage), journalisée par table dans `audit_events` (action `retention.purge`,
 * acteur système, comptes seulement, aucune donnée de contenu). `pool` : connexions hors transaction.
 */
export async function runRetention(
  pool: pg.Pool,
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
  opts: PhysicalPurgeOptions = {},
): Promise<RetentionReport> {
  const phase1 = await markExpiredDatasets(pool, now, policy);
  const phase2 = await purgeMarkedDatasets(pool, now, opts);
  const phase3 = await cleanupExpiredRunData(pool, now, policy);
  const report: RetentionReport = { at: now.toISOString(), phase1, phase2, phase3 };
  await appendAudit(pool, {
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
}

