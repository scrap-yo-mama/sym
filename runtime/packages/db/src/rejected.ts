// SPDX-License-Identifier: AGPL-3.0-only
// Quarantaine des items non conformes (tâche 2.3, D-49, migration 0017) et lectures de la réparation :
// - écriture de la quarantaine d'un run sous l'identité de l'APPELANT du run (RLS : `owner_id = runs.owner_id`) ;
// - service de lecture : l'appelant du run lit agrégats et échantillon ; le propriétaire d'une API partagée ne lit que les
//   agrégats (`total_rejected`, `by_reason`) et obtient « introuvable » (404) sur l'échantillon ; tout autre utilisateur,
//   rien (404 uniforme, INV12) ; l'admin passe par `admin_rejected_metadata` (métadonnées, INV5) ;
// - sorties saines récentes (items livrés des derniers runs réussis) : référence de la réparation (04 §5 étape 2) ;
// - historique de volume (items EXTRAITS = livrés + écartés) pour `volume_anomaly` (04 §6) ;
// - version vN+1 issue d'une réparation (`created_by = repair`, patch et version parente).
import type { Execution, Network, QuarantineSummary, RejectionReason } from '@runtime/core';
import type pg from 'pg';
import { withActor, type DbActor } from './rls.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

/** Écrit (ou remplace) la quarantaine d'un run, comme l'appelant du run. Sans rejet, rien n'est écrit. */
export async function saveRejectedItems(
  pool: pg.Pool,
  args: { runId: string; apiId: string; ownerId: string; projectId: string; summary: QuarantineSummary },
): Promise<void> {
  if (args.summary.total_rejected <= 0) return;
  await withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    await tx.query(
      `INSERT INTO run_rejected_items (run_id, api_id, owner_id, project_id, total_rejected, by_reason, sample)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
       ON CONFLICT (run_id) DO UPDATE SET total_rejected = EXCLUDED.total_rejected, by_reason = EXCLUDED.by_reason, sample = EXCLUDED.sample`,
      [args.runId, args.apiId, args.ownerId, args.projectId, args.summary.total_rejected, JSON.stringify(args.summary.by_reason), JSON.stringify(args.summary.sample.slice(0, 5))],
    );
  });
}

/** Retire la quarantaine d'un run (sortie réparée sans rejet : la quarantaine de diagnostic de la casse ne vaut plus). */
export async function deleteRejectedItems(pool: pg.Pool, args: { runId: string; ownerId: string }): Promise<void> {
  await withActor(pool, { userId: args.ownerId, role: 'member' }, (tx) => tx.query('DELETE FROM run_rejected_items WHERE run_id = $1', [args.runId]));
}

export type RejectedAggregates = { readonly count: number; readonly by_reason: { keyword: string; path: string; count: number }[] };

const toAggregates = (total: number, reasons: unknown): RejectedAggregates => ({
  count: total,
  by_reason: (Array.isArray(reasons) ? (reasons as RejectionReason[]) : []).map((r) => ({ keyword: r.keyword, path: r.instance_path, count: r.count })),
});

/**
 * Agrégats sans valeur de la quarantaine d'un run (enveloppe `RunResult.rejected`, 05 §4.1) dans la transaction de
 * l'acteur : appelant du run ou propriétaire de l'API ; `null` sans rejet ou hors de portée.
 */
export async function readRejectedAggregates(db: Queryable, runId: string): Promise<RejectedAggregates | null> {
  const { rows } = await db.query<{ total_rejected: number; by_reason: unknown }>('SELECT total_rejected, by_reason FROM run_rejected_aggregates WHERE run_id = $1', [runId]);
  const row = rows[0];
  return row === undefined ? null : toAggregates(row.total_rejected, row.by_reason);
}

export type RejectedRead =
  | { readonly access: 'caller'; readonly count: number; readonly by_reason: RejectedAggregates['by_reason']; readonly sample: unknown[] }
  | { readonly access: 'api_owner'; readonly count: number; readonly by_reason: RejectedAggregates['by_reason'] };

/**
 * Service de lecture de la quarantaine (2.3) : l'appelant du run lit l'échantillon masqué ; le propriétaire d'une API
 * partagée, les agrégats seuls ; sinon `null` (404 uniforme : run inconnu, d'un autre, ou sans rejet).
 */
export async function readRejectedItems(pool: pg.Pool, actor: DbActor, runId: string): Promise<RejectedRead | null> {
  return withActor(pool, actor, async (tx) => {
    const own = await tx.query<{ total_rejected: number; by_reason: unknown; sample: unknown }>('SELECT total_rejected, by_reason, sample FROM run_rejected_items WHERE run_id = $1', [runId]);
    const row = own.rows[0];
    if (row !== undefined) {
      const agg = toAggregates(row.total_rejected, row.by_reason);
      return { access: 'caller', count: agg.count, by_reason: agg.by_reason, sample: Array.isArray(row.sample) ? row.sample : [] };
    }
    const agg = await readRejectedAggregates(tx, runId);
    return agg === null ? null : { access: 'api_owner', count: agg.count, by_reason: agg.by_reason };
  });
}

/**
 * Échantillon de la quarantaine (`get_items(rejected: true)`, 05 §4.1) : à l'appelant du run seul ; `null` = 404 pour
 * tout autre, y compris le propriétaire de l'API partagée (qui garde les agrégats par `readRejectedItems`).
 */
export async function readRejectedSample(pool: pg.Pool, actor: DbActor, runId: string): Promise<unknown[] | null> {
  const read = await readRejectedItems(pool, actor, runId);
  return read?.access === 'caller' ? read.sample : null;
}

/** Items livrés des derniers runs réussis de l'API (référence de la réparation), lus comme le propriétaire. */
export async function readHealthyItems(pool: pg.Pool, args: { apiId: string; ownerId: string; excludeRunId?: string; runs?: number; limit?: number }): Promise<unknown[]> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const { rows } = await tx.query<{ item: unknown }>(
      `WITH recent AS (
         SELECT id FROM runs
          WHERE api_id = $1 AND state = 'succeeded' AND kind = 'run' AND dataset_id IS NOT NULL AND id <> coalesce($2::uuid, '00000000-0000-0000-0000-000000000000')
          ORDER BY finished_at DESC NULLS LAST LIMIT $3)
       SELECT i.item FROM dataset_items i JOIN recent r ON r.id = i.run_id ORDER BY i.created_at DESC, i.seq LIMIT $4`,
      [args.apiId, args.excludeRunId ?? null, args.runs ?? 3, args.limit ?? 200],
    );
    return rows.map((r) => r.item);
  });
}

/**
 * Volumes EXTRAITS (livrés + écartés, D-49) des derniers runs réussis à même entrée, hors runs déjà signalés en
 * `volume_anomaly` : base de la médiane de 04 §6.
 */
export async function readVolumeHistory(pool: pg.Pool, args: { apiId: string; ownerId: string; input: unknown; excludeRunId: string; limit?: number }): Promise<number[]> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const { rows } = await tx.query<{ n: number }>(
      `SELECT (items + items_rejected) AS n FROM runs
        WHERE api_id = $1 AND state = 'succeeded' AND kind = 'run' AND id <> $2
          AND coalesce(input, 'null'::jsonb) = coalesce($3::jsonb, 'null'::jsonb)
          AND NOT ('volume_anomaly' = ANY(degraded_reasons))
        ORDER BY finished_at DESC NULLS LAST LIMIT $4`,
      [args.apiId, args.excludeRunId, args.input === undefined ? null : JSON.stringify(args.input), args.limit ?? 20],
    );
    return rows.map((r) => Number(r.n));
  });
}

/**
 * Version vN+1 issue d'une réparation (04 §5 étape 4) : `created_by = repair`, patch RFC 6902 et version parente ;
 * courante SEULEMENT si l'API est toujours sur la version réparée (aucune autre réparation ni enquête ne l'a changée).
 * `output_schema` n'est jamais touché ici. Écrite comme le propriétaire.
 */
export async function saveRepairedStrategy(
  pool: pg.Pool,
  args: { apiId: string; ownerId: string; parentVersion: number; execution: Execution; network: Network; spec: unknown; patch: unknown[] | null; estCostUsd: number | null },
): Promise<{ version: number; promoted: boolean }> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const locked = await tx.query<{ current_strategy_version: number | null; project_id: string }>('SELECT current_strategy_version, project_id FROM apis WHERE id = $1 AND owner_id = $2 FOR UPDATE', [
      args.apiId,
      args.ownerId,
    ]);
    const current = locked.rows[0];
    if (current === undefined) throw new Error('API introuvable pour le propriétaire');
    const next = await tx.query<{ v: number }>('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM strategy_versions WHERE api_id = $1', [args.apiId]);
    const version = next.rows[0]!.v;
    await tx.query(
      `INSERT INTO strategy_versions (api_id, version, owner_id, project_id, execution, network, spec, est_cost_usd, created_by, parent_version, patch)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'repair', $9, $10::jsonb)`,
      [args.apiId, version, args.ownerId, current.project_id, args.execution, args.network, JSON.stringify(args.spec), args.estCostUsd, args.parentVersion, args.patch === null ? null : JSON.stringify(args.patch)],
    );
    const promoted = current.current_strategy_version === args.parentVersion;
    if (promoted) await tx.query('UPDATE apis SET current_strategy_version = $2 WHERE id = $1', [args.apiId, version]);
    return { version, promoted };
  });
}

/** Version courante de l'API (lecture comme le propriétaire) : un run qui a attendu le bail rejoue vN+1. */
export async function readCurrentStrategyVersion(pool: pg.Pool, args: { apiId: string; ownerId: string }): Promise<number | null> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const { rows } = await tx.query<{ v: number | null }>('SELECT current_strategy_version AS v FROM apis WHERE id = $1', [args.apiId]);
    return rows[0]?.v ?? null;
  });
}
