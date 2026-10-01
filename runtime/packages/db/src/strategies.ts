// SPDX-License-Identifier: AGPL-3.0-only
// Lectures et écritures des exécuteurs (tâche 1.6) : la cible d'un run (API + version de stratégie figée) et le dataset
// produit. Données d'utilisateur : lues et écrites sous `withActor` avec le propriétaire du run (RLS, INV12), jamais
// sous l'identité système. Les proxys de l'admin (`settings.proxies`) sont une configuration d'instance (identité système).
import type { Execution, Network } from '@runtime/core';
import type pg from 'pg';
import { ensureDatasetItemsPartitions } from './partitions.js';
import { withActor } from './rls.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

export type RunTarget = {
  readonly api: {
    readonly id: string;
    readonly projectId: string;
    readonly outputSchema: unknown;
    readonly networkPolicy: unknown;
    readonly domainPacing: { min_delay_ms?: number; max_requests_per_run?: number; max_wait_ms?: number };
    readonly maxCostUsd: number;
    readonly allowWriteActions: boolean;
  };
  readonly strategy: {
    readonly version: number;
    readonly execution: Execution;
    readonly network: Network;
    readonly spec: unknown;
    readonly scriptRef: string | null;
    readonly estCostUsd: number | null;
  } | null;
};

/** API et version de stratégie d'un run, lues comme le propriétaire (RLS). `null` : API invisible pour lui. */
export async function loadRunTarget(pool: pg.Pool, args: { apiId: string; ownerId: string; version: number | null }): Promise<RunTarget | null> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      project_id: string;
      output_schema: unknown;
      network_policy: unknown;
      domain_pacing: RunTarget['api']['domainPacing'];
      max_cost_usd: string;
      allow_write_actions: boolean;
    }>(
      `SELECT id, project_id, output_schema, network_policy, domain_pacing, max_cost_usd, allow_write_actions
       FROM apis WHERE id = $1 AND owner_id = $2`,
      [args.apiId, args.ownerId],
    );
    const api = rows[0];
    if (api === undefined) return null;
    let strategy: RunTarget['strategy'] = null;
    if (args.version !== null) {
      const sv = await tx.query<{ version: number; execution: Execution; network: Network; spec: unknown; script_ref: string | null; est_cost_usd: string | null }>(
        'SELECT version, execution, network, spec, script_ref, est_cost_usd FROM strategy_versions WHERE api_id = $1 AND version = $2',
        [args.apiId, args.version],
      );
      const s = sv.rows[0];
      if (s !== undefined) {
        strategy = {
          version: s.version,
          execution: s.execution,
          network: s.network,
          spec: s.spec,
          scriptRef: s.script_ref,
          estCostUsd: s.est_cost_usd === null ? null : Number(s.est_cost_usd),
        };
      }
    }
    return {
      api: {
        id: api.id,
        projectId: api.project_id,
        outputSchema: api.output_schema,
        networkPolicy: api.network_policy,
        domainPacing: api.domain_pacing ?? {},
        maxCostUsd: Number(api.max_cost_usd),
        allowWriteActions: api.allow_write_actions,
      },
      strategy,
    };
  });
}

/** Proxys définis par l'admin (`settings.proxies`, JSON brut ; validé par `parseProxyDefinitions`). */
export async function readProxySettings(db: Queryable): Promise<unknown> {
  const { rows } = await db.query<{ value: unknown }>("SELECT value FROM settings WHERE key = 'proxies'");
  return rows[0]?.value ?? [];
}

/**
 * Contact de l'instance saisi à l'assistant de premier démarrage (réglage `instance_contact`, 17 §5), lu par le worker
 * pour le User-Agent du robot ; `undefined` s'il n'est pas posé (repli : `INSTANCE_CONTACT`).
 */
export async function readInstanceContactSetting(db: Queryable): Promise<unknown> {
  const { rows } = await db.query<{ value: unknown }>("SELECT value FROM settings WHERE key = 'instance_contact'");
  return rows[0]?.value;
}

const ITEMS_PER_INSERT = 500;

/**
 * Dataset d'un run : une ligne `datasets` et ses `dataset_items` (seq 0..n-1), écrits comme le propriétaire, dans une
 * seule transaction. Les partitions mensuelles sont garanties avant (identité système, 14 §9).
 */
export async function saveRunDataset(
  pool: pg.Pool,
  args: { runId: string; apiId: string; ownerId: string; projectId: string; items: readonly unknown[] },
): Promise<{ datasetId: string; bytes: number }> {
  await ensureDatasetItemsPartitions(pool);
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO datasets (api_id, run_id, owner_id, project_id) VALUES ($1, $2, $3, $4) RETURNING id',
      [args.apiId, args.runId, args.ownerId, args.projectId],
    );
    const datasetId = (rows[0] as { id: string }).id;
    let bytes = 0;
    for (let start = 0; start < args.items.length; start += ITEMS_PER_INSERT) {
      const chunk = args.items.slice(start, start + ITEMS_PER_INSERT).map((item) => JSON.stringify(item));
      const sizes = chunk.map((json) => Buffer.byteLength(json));
      bytes += sizes.reduce((a, b) => a + b, 0);
      await tx.query(
        `INSERT INTO dataset_items (dataset_id, seq, run_id, owner_id, project_id, item, size_bytes)
         SELECT $1, $2 + s.ord - 1, $3, $4, $5, s.item::jsonb, s.size
         FROM unnest($6::text[], $7::int[]) WITH ORDINALITY AS s(item, size, ord)`,
        [datasetId, start, args.runId, args.ownerId, args.projectId, chunk, sizes],
      );
    }
    await tx.query('UPDATE datasets SET item_count = $2, bytes = $3 WHERE id = $1', [datasetId, args.items.length, bytes]);
    return { datasetId, bytes };
  });
}
