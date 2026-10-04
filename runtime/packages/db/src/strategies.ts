// SPDX-License-Identifier: AGPL-3.0-only
// Lectures et écritures des exécuteurs (tâche 1.6) : la cible d'un run (API + version de stratégie figée) et le dataset
// produit. Données d'utilisateur : lues et écrites sous `withActor` avec le propriétaire du run (RLS, INV12), jamais
// sous l'identité système. Les proxys de l'admin (`settings.proxies`) sont une configuration d'instance (identité système).
import type { Execution, Network, StrategyCompilable } from '@runtime/core';
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
    /** `apis.requires` (04b) : `session_domain` = domaine connecté par l'extension (mode tunnel, tâche 2.7). */
    readonly requires: { readonly session_domain?: string | null; readonly tunnel?: boolean };
    /** `apis.requires_session` : l'API exige la session (l'identité) de l'utilisateur (C2, 04 §3.2). */
    readonly requiresSession: boolean;
    /** `apis.instructed_mode` (2.13) : opt-in explicite de l'agent instruit (étapes confirmées, déclencheur de 0023). */
    readonly instructedMode: boolean;
    /** `apis.description` : demande du propriétaire, source de la stratégie pour la réparation (04 §5 étape 1). */
    readonly description: string;
  };
  readonly strategy: {
    /** `strategy_versions.state` : un brouillon (3.14) se teste avec son propre schéma de sortie, sans jamais toucher au statut. */
    readonly state?: 'draft' | 'current' | 'archived';
    readonly version: number;
    readonly execution: Execution;
    readonly network: Network;
    readonly spec: unknown;
    readonly scriptRef: string | null;
    readonly estCostUsd: number | null;
    /** 2.13 : compilable en E5 (`no` : seul l'agent instruit la rejoue) ; source des étapes (`intent`, `pre`, `post`). */
    readonly compilable: StrategyCompilable;
    readonly sourceSteps: unknown;
    /** Étapes instruites (agent instruit) : brutes, avec l'empreinte et la confirmation humaine (non fiables sinon). */
    readonly instructedSteps: unknown;
    readonly instructedConfirmation: { readonly by: string | null; readonly at: string | null; readonly sha256: string } | null;
  } | null;
};

/**
 * API et version de stratégie d'un run, lues comme le propriétaire (RLS). `null` : API invisible pour lui.
 * `caps.maxCostUsdPerRun` (`MAX_COST_USD_PER_RUN`, PA-02) borne `maxCostUsd` : les lignes déjà en base (importées,
 * antérieures au plafond, défaut 0,5 au-dessus d'un plafond plus bas) ne dépassent jamais le plafond d'instance.
 */
export async function loadRunTarget(pool: pg.Pool, args: { apiId: string; ownerId: string; version: number | null; caps?: { readonly maxCostUsdPerRun: number } }): Promise<RunTarget | null> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      project_id: string;
      output_schema: unknown;
      network_policy: unknown;
      domain_pacing: RunTarget['api']['domainPacing'];
      max_cost_usd: string;
      allow_write_actions: boolean;
      requires: RunTarget['api']['requires'] | null;
      requires_session: boolean;
      instructed_mode: boolean;
      description: string;
    }>(
      `SELECT id, project_id, output_schema, network_policy, domain_pacing, max_cost_usd, allow_write_actions, requires, requires_session, instructed_mode, description
       FROM apis WHERE id = $1 AND owner_id = $2`,
      [args.apiId, args.ownerId],
    );
    const api = rows[0];
    if (api === undefined) return null;
    let strategy: RunTarget['strategy'] = null;
    let draftSchema: unknown = undefined;
    if (args.version !== null) {
      const sv = await tx.query<{ state: 'draft' | 'current' | 'archived'; draft_schema: unknown; version: number; execution: Execution; network: Network; spec: unknown; script_ref: string | null; est_cost_usd: string | null; compilable: StrategyCompilable; source_steps: unknown; instructed_steps: unknown; instructed_steps_confirmed: { by?: string | null; at?: string | null; sha256?: string } | null }>(
        'SELECT state, output_schema AS draft_schema, version, execution, network, spec, script_ref, est_cost_usd, compilable, source_steps, instructed_steps, instructed_steps_confirmed FROM strategy_versions WHERE api_id = $1 AND version = $2',
        [args.apiId, args.version],
      );
      const s = sv.rows[0];
      if (s !== undefined) {
        strategy = {
          state: s.state,
          version: s.version,
          execution: s.execution,
          network: s.network,
          spec: s.spec,
          scriptRef: s.script_ref,
          estCostUsd: s.est_cost_usd === null ? null : Number(s.est_cost_usd),
          compilable: s.compilable,
          sourceSteps: s.source_steps,
          instructedSteps: s.instructed_steps,
          instructedConfirmation:
            s.instructed_steps_confirmed === null ? null : { by: s.instructed_steps_confirmed.by ?? null, at: s.instructed_steps_confirmed.at ?? null, sha256: s.instructed_steps_confirmed.sha256 ?? '' },
        };
        if (s.state === 'draft' && s.draft_schema !== null && s.draft_schema !== undefined) draftSchema = s.draft_schema;
      }
    }
    return {
      api: {
        id: api.id,
        projectId: api.project_id,
        outputSchema: draftSchema === undefined ? api.output_schema : draftSchema,
        networkPolicy: api.network_policy,
        domainPacing: api.domain_pacing ?? {},
        maxCostUsd: Math.min(Number(api.max_cost_usd), args.caps?.maxCostUsdPerRun ?? Number.POSITIVE_INFINITY),
        allowWriteActions: api.allow_write_actions,
        requires: api.requires ?? {},
        requiresSession: api.requires_session,
        instructedMode: api.instructed_mode,
        description: api.description,
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

/** Réglages LLM de l'instance (`settings.llm`, JSON brut ; clés référencées par identifiant de secret, 08 §7). */
export async function readLlmSettings(db: Queryable): Promise<unknown> {
  const { rows } = await db.query<{ value: unknown }>("SELECT value FROM settings WHERE key = 'llm'");
  return rows[0]?.value ?? null;
}

/**
 * Stratégie E5 compilée depuis une trace E6 réussie et vérifiée par rejeu sans LLM (tâche 2.4, 04 §3.1) : nouvelle
 * version `hybrid` (`created_by = investigation`, parent = la version E6), retenue comme courante SEULEMENT si l'API est
 * toujours sur cette version E6 (aucune réparation ni enquête concurrente ne l'a changée). Écrit comme le propriétaire.
 */
export async function saveCompiledStrategy(
  pool: pg.Pool,
  args: { apiId: string; ownerId: string; parentVersion: number; network: Network; spec: unknown; estCostUsd: number; sourceSteps?: unknown },
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
      `INSERT INTO strategy_versions (api_id, version, owner_id, project_id, execution, network, spec, est_cost_usd, created_by, parent_version, compilable, source_steps)
       VALUES ($1, $2, $3, $4, 'hybrid', $5, $6, $7, 'investigation', $8, 'yes', $9)`,
      [args.apiId, version, args.ownerId, current.project_id, args.network, JSON.stringify(args.spec), args.estCostUsd, args.parentVersion, args.sourceSteps === undefined ? null : JSON.stringify(args.sourceSteps)],
    );
    const promoted = current.current_strategy_version === args.parentVersion;
    // Une version compilée (rejouée sans LLM) devient courante : le mode « agent instruit » n'a plus lieu d'être (2.13).
    if (promoted) await tx.query('UPDATE apis SET current_strategy_version = $2, instructed_mode = false WHERE id = $1', [args.apiId, version]);
    return { version, promoted };
  });
}

/**
 * Contact de l'instance saisi à l'assistant de premier démarrage (réglage `instance_contact`, 17 §5), lu par le worker
 * pour le User-Agent du robot ; `undefined` s'il n'est pas posé (repli : `INSTANCE_CONTACT`).
 */
export async function readInstanceContactSetting(db: Queryable): Promise<unknown> {
  const { rows } = await db.query<{ value: unknown }>("SELECT value FROM settings WHERE key = 'instance_contact'");
  return rows[0]?.value;
}

/**
 * Réglage admin `identify_instance` (17 §5) : `true`, ou `{ enabled: true }`, ajoute le jeton produit au User-Agent et
 * l'en-tête `From` ; `undefined` s'il n'est pas posé (repli : `IDENTIFY_INSTANCE`, puis désactivé).
 */
export async function readIdentifyInstanceSetting(db: Queryable): Promise<unknown> {
  const { rows } = await db.query<{ value: unknown }>("SELECT value FROM settings WHERE key = 'identify_instance'");
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
