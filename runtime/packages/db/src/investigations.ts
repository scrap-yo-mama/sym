// SPDX-License-Identifier: AGPL-3.0-only
// État de l'enquête (tâche 2.1, 04 §4, migration 0016) : `apis.investigation` entre deux runs de nature
// `investigation` (premier appel : étape 0, reconnaissance, schéma proposé ; après `validate_schema` : essais).
// Données d'utilisateur : tout passe par `withActor` avec le propriétaire (RLS, INV12). L'état ne porte aucune valeur du
// site (gisements = origine, chemin et NOMS de paramètres, chemins d'enregistrements, types, tailles : `StoredCandidate`) :
// l'échantillon vit dans `investigation_events`, l'exemple de sortie dans `runs.input`, tous deux couverts par la
// rétention et l'effacement (17 §6) ; les valeurs des requêtes de données sont relues par la reconnaissance de chaque run.
// L'état n'est jamais copié par un clone (`API_CLONE_EXCLUDED`). Une seule enquête à la fois par API.
import { assertSchemaAcceptable, SchemaError, type Execution, type InvestigationPhase, type JobQueue, type Network, type RunTrigger } from '@runtime/core';
import type { InvestigationProposal, StoredCandidate } from '@runtime/core/investigation';
import { INVESTIGATION_DEFAULTS } from '@runtime/core/investigation';
import type pg from 'pg';
import { withActor } from './rls.js';
import { createRun } from './runs.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

/** Demande d'enquête (`create_api`, 05 §4.1) et ses plafonds (04 §4). */
export type InvestigationRequest = {
  readonly url: string;
  readonly description: string;
  readonly auto_validate: boolean;
  readonly budget_usd: number;
  readonly timeout_s: number;
};

/** État persistant d'une enquête (`apis.investigation`). */
export type InvestigationState = {
  readonly request: InvestigationRequest;
  /** Gisements observés à la reconnaissance (aucune valeur du site). */
  readonly candidates?: readonly StoredCandidate[];
  readonly page?: { readonly url: string; readonly host: string; readonly document_bytes: number; readonly total_bytes: number; readonly mode: 'browser' | 'static' | 'tunnel' };
  readonly proposal?: InvestigationProposal;
  readonly proposed_schema?: Record<string, unknown>;
  readonly validated_schema?: Record<string, unknown>;
  readonly validated_by?: 'auto' | 'user';
  /** Coût cumulé de l'enquête (LLM d'enquête et essais de tous ses runs). */
  readonly spent_usd: number;
  /** Durée active cumulée (hors attente de la validation). */
  readonly elapsed_ms: number;
};

export class InvestigationStateError extends Error {
  readonly code: 'invalid_request' | 'not_awaiting_validation' | 'invalid_schema' | 'api_not_found' | 'investigation_in_progress';
  constructor(code: InvestigationStateError['code'], message: string) {
    super(message);
    this.name = 'InvestigationStateError';
    this.code = code;
  }
}

/** Demande normalisée : URL http(s) sans identifiants, description non vide (≤ 2000), plafonds bornés. */
export function normalizeInvestigationRequest(input: {
  url: string;
  description: string;
  auto_validate?: boolean;
  budget_usd?: number;
  timeout_s?: number;
}): InvestigationRequest {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new InvestigationStateError('invalid_request', 'URL illisible');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || url.href.length > 2048) {
    throw new InvestigationStateError('invalid_request', 'URL http(s) sans identifiants attendue');
  }
  const description = input.description.trim();
  if (description === '' || description.length > 2000) throw new InvestigationStateError('invalid_request', 'description de 1 à 2000 caractères attendue');
  const budget = input.budget_usd ?? INVESTIGATION_DEFAULTS.budgetUsd;
  const timeout = input.timeout_s ?? INVESTIGATION_DEFAULTS.timeoutSeconds;
  if (!Number.isFinite(budget) || budget < 0 || budget > 100) throw new InvestigationStateError('invalid_request', 'investigation_budget_usd entre 0 et 100 attendu');
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new InvestigationStateError('invalid_request', 'investigation_timeout_s entre 1 et 3600 attendu');
  url.hash = '';
  return { url: url.href, description, auto_validate: input.auto_validate === true, budget_usd: budget, timeout_s: timeout };
}

/**
 * Lance une enquête sur une API visible de l'acteur (côté web, transaction `withActor`) : état initial, phase
 * `access_check`, run de nature `investigation` et son job dans la MÊME transaction. `exampleOutput` va dans l'entrée
 * du run (rétention et effacement), jamais dans l'état de l'API. Une enquête dont un run est en file ou en cours refuse
 * d'être relancée (`investigation_in_progress`, 409) : deux runs écraseraient l'état l'un de l'autre et remettraient le
 * coût cumulé à 0 (contournement de `investigation_budget_usd`). L'API est verrouillée (`FOR UPDATE`) le temps du contrôle.
 */
export async function startInvestigation(
  tx: Queryable,
  queue: JobQueue,
  input: {
    apiId: string;
    ownerId: string;
    trigger: RunTrigger;
    request: Parameters<typeof normalizeInvestigationRequest>[0];
    exampleOutput?: unknown;
  },
): Promise<{ runId: string; jobId: string }> {
  const request = normalizeInvestigationRequest(input.request);
  const locked = await tx.query('SELECT 1 FROM apis WHERE id = $1 AND owner_id = $2 FOR UPDATE', [input.apiId, input.ownerId]);
  if (locked.rowCount !== 1) throw new InvestigationStateError('api_not_found', 'API introuvable pour ce propriétaire');
  const active = await tx.query(
    "SELECT 1 FROM runs WHERE api_id = $1 AND kind = 'investigation' AND state IN ('queued', 'running', 'waiting_tunnel') LIMIT 1",
    [input.apiId],
  );
  if ((active.rowCount ?? 0) > 0) throw new InvestigationStateError('investigation_in_progress', 'une enquête est déjà en file ou en cours sur cette API');
  const state: InvestigationState = { request, spent_usd: 0, elapsed_ms: 0 };
  const { rowCount } = await tx.query("UPDATE apis SET investigation = $2::jsonb, investigation_phase = 'access_check', updated_at = now() WHERE id = $1 AND owner_id = $3", [
    input.apiId,
    JSON.stringify(state),
    input.ownerId,
  ]);
  if (rowCount !== 1) throw new InvestigationStateError('api_not_found', 'API introuvable pour ce propriétaire');
  return createRun(tx, queue, {
    apiId: input.apiId,
    ownerId: input.ownerId,
    trigger: input.trigger,
    kind: 'investigation',
    ...(input.exampleOutput === undefined ? {} : { input: { example_output: input.exampleOutput } }),
  });
}

/**
 * `validate_schema` (05 §4.1) : l'appelant valide le schéma proposé, ou le corrige. Exige la phase
 * `awaiting_schema_validation` ; le schéma retenu est contrôlé (aucun `$ref` distant, bornes), la phase passe à
 * `testing` et un run d'enquête est mis en file dans la même transaction.
 */
export async function validateInvestigationSchema(
  tx: Queryable,
  queue: JobQueue,
  input: { apiId: string; ownerId: string; trigger: RunTrigger; outputSchema?: unknown },
): Promise<{ runId: string; jobId: string }> {
  const { rows } = await tx.query<{ investigation: InvestigationState | null; investigation_phase: InvestigationPhase | null }>(
    'SELECT investigation, investigation_phase FROM apis WHERE id = $1 AND owner_id = $2 FOR UPDATE',
    [input.apiId, input.ownerId],
  );
  const row = rows[0];
  if (row === undefined) throw new InvestigationStateError('api_not_found', 'API introuvable pour ce propriétaire');
  const state = row.investigation;
  if (row.investigation_phase !== 'awaiting_schema_validation' || state === null || state.proposed_schema === undefined) {
    throw new InvestigationStateError('not_awaiting_validation', 'aucun schéma proposé en attente de validation');
  }
  const schema = input.outputSchema ?? state.proposed_schema;
  try {
    assertSchemaAcceptable(schema);
  } catch (error) {
    if (error instanceof SchemaError) throw new InvestigationStateError('invalid_schema', error.message);
    throw error;
  }
  const next: InvestigationState = { ...state, validated_schema: schema as Record<string, unknown>, validated_by: 'user' };
  await tx.query("UPDATE apis SET investigation = $2::jsonb, investigation_phase = 'testing', updated_at = now() WHERE id = $1", [input.apiId, JSON.stringify(next)]);
  return createRun(tx, queue, { apiId: input.apiId, ownerId: input.ownerId, trigger: input.trigger, kind: 'investigation' });
}

/** Vue de l'API pour l'exécuteur d'enquête (lue comme le propriétaire). */
export type InvestigationTarget = {
  readonly state: InvestigationState | null;
  readonly phase: InvestigationPhase | null;
  readonly status: string;
  readonly currentStrategyVersion: number | null;
};

export async function loadInvestigation(pool: pg.Pool, args: { apiId: string; ownerId: string }): Promise<InvestigationTarget | null> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const { rows } = await tx.query<{ investigation: InvestigationState | null; investigation_phase: InvestigationPhase | null; status: string; current_strategy_version: number | null }>(
      'SELECT investigation, investigation_phase, status, current_strategy_version FROM apis WHERE id = $1 AND owner_id = $2',
      [args.apiId, args.ownerId],
    );
    const row = rows[0];
    return row === undefined ? null : { state: row.investigation, phase: row.investigation_phase, status: row.status, currentStrategyVersion: row.current_strategy_version };
  });
}

/** Écrit l'état et la phase de l'enquête (comme le propriétaire). */
export async function saveInvestigationState(pool: pg.Pool, args: { apiId: string; ownerId: string; state: InvestigationState; phase: InvestigationPhase | null }): Promise<void> {
  await withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    await tx.query('UPDATE apis SET investigation = $3::jsonb, investigation_phase = $4, updated_at = now() WHERE id = $1 AND owner_id = $2', [
      args.apiId,
      args.ownerId,
      JSON.stringify(args.state),
      args.phase,
    ]);
  });
}

/**
 * Fin d'enquête conforme (04 §4, figure 1 G-H) : version de stratégie `created_by = investigation` (numéro suivant),
 * devenue courante, schéma de sortie VALIDÉ (contrat, INV1) et schéma d'entrée proposé posés sur l'API, phase `done`.
 * Le statut (transition 1, ou 21 pour une ré-enquête) est appliqué ensuite par la machine à états.
 */
export async function saveInvestigationStrategy(
  pool: pg.Pool,
  args: {
    apiId: string;
    ownerId: string;
    execution: Execution;
    network: Network;
    spec: unknown;
    estCostUsd: number | null;
    outputSchema: unknown;
    inputSchema: unknown;
    state: InvestigationState;
  },
): Promise<{ version: number }> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const locked = await tx.query<{ project_id: string; current_strategy_version: number | null }>('SELECT project_id, current_strategy_version FROM apis WHERE id = $1 AND owner_id = $2 FOR UPDATE', [
      args.apiId,
      args.ownerId,
    ]);
    const api = locked.rows[0];
    if (api === undefined) throw new InvestigationStateError('api_not_found', 'API introuvable pour ce propriétaire');
    const next = await tx.query<{ v: number }>('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM strategy_versions WHERE api_id = $1', [args.apiId]);
    const version = next.rows[0]!.v;
    await tx.query(
      `INSERT INTO strategy_versions (api_id, version, owner_id, project_id, execution, network, spec, est_cost_usd, created_by, parent_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'investigation', $9)`,
      [args.apiId, version, args.ownerId, api.project_id, args.execution, args.network, JSON.stringify(args.spec), args.estCostUsd, api.current_strategy_version],
    );
    await tx.query(
      `UPDATE apis SET current_strategy_version = $2, output_schema = $3::jsonb, input_schema = $4::jsonb, investigation = $5::jsonb,
         investigation_phase = 'done', updated_at = now()
       WHERE id = $1`,
      [args.apiId, version, JSON.stringify(args.outputSchema), JSON.stringify(args.inputSchema), JSON.stringify(args.state)],
    );
    return { version };
  });
}
