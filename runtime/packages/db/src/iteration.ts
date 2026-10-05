// SPDX-License-Identifier: AGPL-3.0-only
// Itération par MCP (tâche 3.14, 19 §6, 19b §1) : brouillons d'API, test, promotion, retour de version, reprise.
//
// Un brouillon est une VERSION NON COURANTE (`strategy_versions.state = 'draft'`, un seul par API). La version en service ne
// bouge que par la promotion, le retour, la réparation, la ré-enquête ou la recompilation ; à chaque déplacement du pointeur,
// le déclencheur `apis_mark_current_version` (0027) marque le brouillon `base_stale`, quel que soit l'écrivain. Le statut passe
// par la machine à états (INV3) : la transition 22 (`erreur` → `warning`) est écrite dans la MÊME transaction que le déplacement
// du pointeur ; sur `sain` ou `warning`, une promotion n'est pas une transition (statut inchangé).
//
// Droits : toute écriture se fait sous `withActor` (RLS, propriétaire seul, INV12) ; seule la promotion et le retour passent
// par l'identité système (la machine à états écrit `apis` et `status_events`), avec le propriétaire en prédicat explicite.
import {
  appendFeedback,
  buildFeedback,
  classifySchemaChange,
  compileSchema,
  crossesSchemaVersion,
  diffHash,
  diffItems,
  diffSummaryParts,
  DRAFT_TTL_DAYS,
  estimateCost,
  identityKeyFields,
  jsonSha256,
  noiseFieldsOf,
  nextSchemaVersion,
  personalTopFields,
  PROMOTION_MIN_SAMPLES,
  releasedSchemaVersion,
  VERSIONS_KEEP,
  type DiffSummaryParts,
  type Estimate,
  type FeedbackEntry,
  type FeedbackKind,
  type ItemsDiff,
  type JobQueue,
  type SchemaChange,
  type SchemaChangeLevel,
  type WideningWarning,
} from '@runtime/core';
import type pg from 'pg';
import { createRun } from './runs.js';
import { applyStatusAndNotify } from './notify.js';
import { withActor } from './rls.js';

type Json = Record<string, unknown>;
type Tx = pg.PoolClient;

/** Codes d'erreur métier de l'itération : la couche de présentation (REST, MCP) leur donne un statut et une marche à suivre. */
export type IterationErrorCode =
  | 'not_found'
  | 'no_current_version'
  | 'api_blocked'
  | 'api_busy'
  | 'refine_in_progress'
  | 'nothing_to_refine'
  | 'invalid_schema'
  | 'no_draft'
  | 'draft_expired'
  | 'base_stale'
  | 'not_tested'
  | 'diff_hash_mismatch'
  | 'not_conform'
  | 'too_few_samples'
  | 'replay_not_llm_free'
  | 'cost_increase_requires_accept'
  | 'version_not_revertable'
  | 'already_current'
  | 'no_previous_version'
  | 'status_not_promotable';

export class IterationError extends Error {
  override name = 'IterationError';
  readonly code: IterationErrorCode;
  constructor(code: IterationErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

const BLOCKED_STATUSES = new Set(['bloquee', 'action_requise']);
const BUSY_STATUSES = new Set(['enquete', 'reparation']);
/** Exécutions déclaratives : leur rejeu compilé ne coûte aucun appel LLM ; l'agent (E6) en coûte à chaque run. */
const DECLARATIVE = new Set(['fetch', 'fetch_in_page', 'playwright', 'agent_fetch', 'hybrid']);
const ITEMS_READ_MAX = 5_000;
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

type ApiState = {
  id: string;
  slug: string;
  owner_id: string;
  status: string;
  current_strategy_version: number | null;
  draft_strategy_version: number | null;
  output_schema: Json;
  output_schema_version: string;
  max_cost_usd: string | null;
  iteration_budget_usd: string | null;
};

const API_COLUMNS = 'id, slug, owner_id, status, current_strategy_version, draft_strategy_version, output_schema, output_schema_version, max_cost_usd, iteration_budget_usd';

type VersionRow = {
  api_id: string;
  version: number;
  state: 'draft' | 'current' | 'archived';
  execution: string;
  network: string;
  spec: unknown;
  script_ref: string | null;
  est_cost_usd: string | null;
  compilable: string;
  source: Json | null;
  source_steps: unknown;
  created_by: string;
  parent_version: number | null;
  was_current: boolean;
  base_version: number | null;
  base_stale: boolean;
  expires_at: Date | null;
  output_schema: Json | null;
  output_schema_version: string;
  last_test: LastTest | null;
  archive_reason: string | null;
  created_at: Date;
};

const VERSION_COLUMNS =
  'api_id, version, state, execution, network, spec, script_ref, est_cost_usd, compilable, source, source_steps, created_by, parent_version, was_current, base_version, base_stale, expires_at, output_schema, output_schema_version, last_test, archive_reason, created_at';

/** Dernier test d'un brouillon (écrit par `recordDraftTest`) : ce que la promotion contrôle. */
export type LastTest = {
  run_id: string;
  reference_run_id: string | null;
  tested_at: string;
  input_hash: string;
  state: string;
  ok: boolean;
  items: number;
  items_rejected: number;
  cost_usd: number | null;
  llm_usd: number | null;
  llm_free: boolean;
  replay_cost_usd: number | null;
  reference_cost_usd: number | null;
  base_version: number;
  schema_version: string;
  reference: 'run' | 'none';
  diff: ItemsDiff | null;
  diff_hash: string | null;
  summary: DiffSummaryParts | null;
};

async function readApi(tx: Tx, args: { slug?: string; apiId?: string; ownerId: string; lock?: 'nowait' | 'wait' }): Promise<ApiState> {
  const where = args.apiId !== undefined ? 'id = $1 AND owner_id = $2' : 'slug = $1 AND owner_id = $2';
  const suffix = args.lock === 'nowait' ? ' FOR UPDATE NOWAIT' : args.lock === 'wait' ? ' FOR UPDATE' : '';
  const { rows } = await tx.query<ApiState>(`SELECT ${API_COLUMNS} FROM apis WHERE ${where}${suffix}`, [args.apiId ?? args.slug, args.ownerId]);
  const row = rows[0];
  if (row === undefined) throw new IterationError('not_found');
  return row;
}

async function readVersion(tx: Tx, apiId: string, version: number, lock = false): Promise<VersionRow | null> {
  const { rows } = await tx.query<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM strategy_versions WHERE api_id = $1 AND version = $2${lock ? ' FOR UPDATE' : ''}`, [apiId, version]);
  return rows[0] ?? null;
}

/** Le brouillon de l'API, périmé archivé au passage (`expired`) ; null s'il n'y en a pas. */
async function readDraftRow(tx: Tx, api: ApiState, now: Date, lock = false): Promise<VersionRow | null> {
  const { rows } = await tx.query<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM strategy_versions WHERE api_id = $1 AND state = 'draft'${lock ? ' FOR UPDATE' : ''}`, [api.id]);
  const draft = rows[0];
  if (draft === undefined) return null;
  if (draft.expires_at !== null && draft.expires_at.getTime() <= now.getTime()) {
    await tx.query("UPDATE strategy_versions SET state = 'archived', archive_reason = 'expired', expires_at = NULL WHERE api_id = $1 AND version = $2", [api.id, draft.version]);
    await tx.query('UPDATE apis SET draft_strategy_version = NULL WHERE id = $1', [api.id]);
    return null;
  }
  return draft;
}

const feedbackOf = (v: Pick<VersionRow, 'source'>): FeedbackEntry[] => (isRecord(v.source) && Array.isArray(v.source['feedback']) ? (v.source['feedback'] as FeedbackEntry[]) : []);

const assertIterable = (api: ApiState): void => {
  if (api.current_strategy_version === null) throw new IterationError('no_current_version');
  if (BLOCKED_STATUSES.has(api.status)) throw new IterationError('api_blocked');
  if (BUSY_STATUSES.has(api.status)) throw new IterationError('api_busy');
};

const columnsOf = (schema: unknown): string[] | null => (isRecord(schema) && isRecord(schema['properties']) ? Object.keys(schema['properties']) : null);

// ---------------------------------------------------------------------------------------------------------------
// Affinage : un brouillon à côté de la version en service
// ---------------------------------------------------------------------------------------------------------------

export type RefineInput = {
  apiId: string;
  ownerId: string;
  authorId: string;
  origin: 'mcp' | 'ui';
  /** Retour de l'utilisateur (texte non fiable, 2 000 caractères au plus). */
  feedback?: { text: string; kind?: FeedbackKind; field?: string | null };
  /** Étendue : toute l'API, ou une étape (`step:<id>`). */
  scope?: string;
  /** Nouveau schéma de sortie complet (jamais modifié en place : il vit dans le brouillon jusqu'à la promotion). */
  outputSchema?: Json;
  trigger?: 'mcp' | 'rest' | 'ui';
  now?: Date;
  ttlDays?: number;
};

export type RefineResult = {
  draft_version: number;
  base_version: number;
  replaced_version: number | null;
  output_schema_version: string;
  schema_level: SchemaChangeLevel;
  schema_changes: readonly SchemaChange[];
  widening_warnings: readonly WideningWarning[];
  feedback_count: number;
  run_id: string;
  expires_at: string;
};

const STEP_SCOPE = /^step:[A-Za-z0-9_-]{1,40}$/;

/**
 * Crée le brouillon (ou le remplace : l'ancien est archivé `superseded`). Le brouillon repart de la version en service, ou de
 * l'ancien brouillon quand il y en a un (les affinages s'accumulent). Aucune requête vers un site, aucun statut touché : le
 * run `draft_refine` (INV4) est tracé sans coût propre. Un seul affinage à la fois par API (`refine_in_progress`).
 */
export async function refineDraft(pool: pg.Pool, input: RefineInput): Promise<RefineResult> {
  const now = input.now ?? new Date();
  if (input.scope !== undefined && input.scope !== 'api' && !STEP_SCOPE.test(input.scope)) throw new IterationError('nothing_to_refine', 'scope illisible');
  const built =
    input.feedback === undefined
      ? null
      : buildFeedback({
          text: input.feedback.text,
          ...(input.feedback.kind === undefined ? (input.scope?.startsWith('step:') === true ? { kind: 'step' as const } : {}) : { kind: input.feedback.kind }),
          field: input.feedback.field ?? (input.scope?.startsWith('step:') === true ? input.scope.slice(5) : null),
          origin: input.origin,
          authorId: input.authorId,
          at: now,
        });
  if (built === null && input.outputSchema === undefined) throw new IterationError('nothing_to_refine');
  if (input.outputSchema !== undefined) {
    try {
      compileSchema(input.outputSchema);
    } catch {
      throw new IterationError('invalid_schema');
    }
  }
  return withActor(pool, { userId: input.ownerId, role: 'member' }, async (tx) => {
    let api: ApiState;
    try {
      api = await readApi(tx, { apiId: input.apiId, ownerId: input.ownerId, lock: 'nowait' });
    } catch (error) {
      // 55P03 : un autre affinage tient la ligne.
      if ((error as { code?: string }).code === '55P03') throw new IterationError('refine_in_progress');
      throw error;
    }
    assertIterable(api);
    const baseVersion = api.current_strategy_version as number;
    const previous = await readDraftRow(tx, api, now, true);
    const start = previous ?? (await readVersion(tx, api.id, baseVersion));
    if (start === null) throw new IterationError('no_current_version');
    const feedback = built === null ? feedbackOf(start) : appendFeedback(feedbackOf(start), built.entry);
    const draftSchema = input.outputSchema ?? (previous?.output_schema ?? null);
    const classification: { level: SchemaChangeLevel; changes: readonly SchemaChange[] } = draftSchema === null ? { level: 'none', changes: [] } : classifySchemaChange(api.output_schema, draftSchema);
    const rank = (await tx.query<{ n: string }>("SELECT count(*)::text AS n FROM strategy_versions WHERE api_id = $1 AND created_by = 'refine'", [api.id])).rows[0]!.n;
    const schemaVersion = nextSchemaVersion(api.output_schema_version, classification.level, Number(rank) + 1);
    const version = (await tx.query<{ v: number }>('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM strategy_versions WHERE api_id = $1', [api.id])).rows[0]!.v;
    const expires = new Date(now.getTime() + (input.ttlDays ?? DRAFT_TTL_DAYS) * 86_400_000);
    const source: Json = { ...(isRecord(start.source) ? start.source : {}), feedback };
    if (previous !== null) await tx.query("UPDATE strategy_versions SET state = 'archived', archive_reason = 'superseded', expires_at = NULL WHERE api_id = $1 AND version = $2", [api.id, previous.version]);
    await tx.query(
      `INSERT INTO strategy_versions
         (api_id, version, owner_id, project_id, execution, network, spec, script_ref, est_cost_usd, created_by, parent_version, compilable, source, source_steps,
          state, base_version, base_stale, expires_at, output_schema, output_schema_version)
       SELECT api_id, $2, owner_id, project_id, execution, network, spec, script_ref, est_cost_usd, 'refine', $3, compilable, $4::jsonb, source_steps,
              'draft', $5, false, $6, $7::jsonb, $8
       FROM strategy_versions WHERE api_id = $1 AND version = $9`,
      [api.id, version, start.version, JSON.stringify(source), baseVersion, expires, draftSchema === null ? null : JSON.stringify(draftSchema), schemaVersion, start.version],
    );
    await tx.query('UPDATE apis SET draft_strategy_version = $2, updated_at = now() WHERE id = $1', [api.id, version]);
    // Run tracé (INV4), sans transition ni coût propre : l'affinage n'appelle aucun modèle dans cette version du serveur.
    const run = await tx.query<{ id: string }>(
      `INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, outcome, strategy_version, items, started_at, finished_at, duration_ms, cost_llm_usd, cost_proxy_usd, kind)
       VALUES ($1, $2, $2, 'draft_refine', 'succeeded', 'clean', $3, 0, now(), now(), 0, 0, 0, 'run') RETURNING id`,
      [api.id, input.ownerId, version],
    );
    await pruneVersions(tx, api.id);
    return {
      draft_version: version,
      base_version: baseVersion,
      replaced_version: previous?.version ?? null,
      output_schema_version: schemaVersion,
      schema_level: classification.level,
      schema_changes: classification.changes,
      widening_warnings: built?.widening_warnings ?? [],
      feedback_count: feedback.length,
      run_id: run.rows[0]!.id,
      expires_at: expires.toISOString(),
    };
  });
}

/** Rétention (`VERSIONS_KEEP`) : les versions archivées jamais courantes au-delà des 10 plus récentes sortent ; toute version ayant été courante reste. */
async function pruneVersions(tx: Tx, apiId: string): Promise<void> {
  await tx.query(
    `DELETE FROM strategy_versions WHERE api_id = $1 AND state = 'archived' AND NOT was_current AND version NOT IN (
       SELECT version FROM strategy_versions WHERE api_id = $1 ORDER BY version DESC LIMIT $2)`,
    [apiId, VERSIONS_KEEP],
  );
}

/** Jeter le brouillon : archivé `discarded` ; la version en service ne bouge pas. */
export async function discardDraft(pool: pg.Pool, args: { apiId: string; ownerId: string; now?: Date }): Promise<{ archived_version: number }> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const apiRow = await readApi(tx, { apiId: args.apiId, ownerId: args.ownerId, lock: 'wait' });
    const draft = await readDraftRow(tx, apiRow, args.now ?? new Date(), true);
    if (draft === null) throw new IterationError('no_draft');
    await tx.query("UPDATE strategy_versions SET state = 'archived', archive_reason = 'discarded', expires_at = NULL WHERE api_id = $1 AND version = $2", [apiRow.id, draft.version]);
    await tx.query('UPDATE apis SET draft_strategy_version = NULL, updated_at = now() WHERE id = $1', [apiRow.id]);
    return { archived_version: draft.version };
  });
}

/** Brouillons périmés de toutes les API : archivés `expired` (passage de maintenance, identité système). */
export async function expireDrafts(pool: pg.Pool, now: Date = new Date()): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ api_id: string }>(
      "UPDATE strategy_versions SET state = 'archived', archive_reason = 'expired', expires_at = NULL WHERE state = 'draft' AND expires_at <= $1 RETURNING api_id",
      [now],
    );
    if (rows.length > 0) await client.query('UPDATE apis SET draft_strategy_version = NULL WHERE id = ANY($1::uuid[])', [rows.map((r) => r.api_id)]);
    await client.query('COMMIT');
    return rows.length;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Test : un run `draft_test` rejoue la stratégie du brouillon, sans toucher au statut
// ---------------------------------------------------------------------------------------------------------------

/** Moyenne des coûts réels des derniers runs de la version en service sur cette entrée (ou toutes), du plus récent au plus ancien. */
async function costHistory(tx: Tx, apiId: string, version: number, limit = 10): Promise<number[]> {
  const { rows } = await tx.query<{ c: string | null }>(
    `SELECT (cost_llm_usd + cost_proxy_usd)::text AS c FROM runs
     WHERE api_id = $1 AND strategy_version = $2 AND state = 'succeeded' AND trigger <> 'draft_refine' AND cost_llm_usd IS NOT NULL
     ORDER BY created_at DESC LIMIT $3`,
    [apiId, version, limit],
  );
  return rows.flatMap((r) => (r.c === null ? [] : [Number(r.c)]));
}

export type TestPlan = {
  draft_version: number;
  base_version: number;
  estimate: Estimate;
  /** Run de référence (version en service, même entrée, récent) : réutilisé, sinon `needs_reference`. */
  reference_run_id: string | null;
  needs_reference: boolean;
};

async function findReferenceRun(tx: Tx, apiId: string, version: number, input: unknown): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM runs WHERE api_id = $1 AND strategy_version = $2 AND state = 'succeeded' AND input IS NOT DISTINCT FROM $3::jsonb
       AND trigger <> 'draft_refine' AND created_at > now() - interval '7 days' ORDER BY created_at DESC LIMIT 1`,
    [apiId, version, input === undefined ? null : JSON.stringify(input)],
  );
  return rows[0]?.id ?? null;
}

/**
 * Plan d'un test : l'estimation du coût (par le code), et si un run de référence de la version en service existe déjà pour cette
 * entrée. Aucune écriture.
 */
export async function planDraftTest(pool: pg.Pool, args: { apiId: string; ownerId: string; input: unknown; confirmAboveUsd?: number; now?: Date }): Promise<TestPlan> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const apiRow = await readApi(tx, { apiId: args.apiId, ownerId: args.ownerId });
    assertIterable(apiRow);
    const draft = await readDraftRow(tx, apiRow, args.now ?? new Date());
    if (draft === null) throw new IterationError('no_draft');
    const base = apiRow.current_strategy_version as number;
    const reference = await findReferenceRun(tx, apiRow.id, base, args.input);
    const current = await readVersion(tx, apiRow.id, base);
    const history = await costHistory(tx, apiRow.id, base);
    const one = estimateCost({
      history,
      strategyEstUsd: draft.est_cost_usd === null ? null : Number(draft.est_cost_usd),
      currentEstUsd: current === null || current.est_cost_usd === null ? null : Number(current.est_cost_usd),
      maxCostUsd: apiRow.max_cost_usd === null ? null : Number(apiRow.max_cost_usd),
      iterationBudgetUsd: apiRow.iteration_budget_usd === null ? null : Number(apiRow.iteration_budget_usd),
      ...(args.confirmAboveUsd === undefined ? {} : { confirmAboveUsd: args.confirmAboveUsd }),
    });
    // Sans référence, un second run (version en service) est lancé : ses bornes s'ajoutent.
    const estimate: Estimate = reference === null ? { ...one, low_usd: round6(one.low_usd * 2), high_usd: round6(one.high_usd * 2), above_cap: one.high_usd * 2 > one.cap_usd, needs_confirmation: one.high_usd * 2 > (args.confirmAboveUsd ?? 0.1) } : one;
    return { draft_version: draft.version, base_version: base, estimate, reference_run_id: reference, needs_reference: reference === null };
  });
}

/**
 * Lance le test : un run `draft_test` sur la version du brouillon, et, sans référence récente, un run `draft_test` sur la
 * version en service (même entrée) pour que le diff compare des sorties du MÊME moment. Dans la transaction de l'appelant
 * (qui a réservé ses créneaux de run, plafonds et budget compris). Aucun des deux ne change le statut.
 */
export async function startDraftTest(
  tx: Tx,
  queue: JobQueue,
  args: { apiId: string; ownerId: string; input: unknown; trigger: 'mcp' | 'rest' | 'ui'; plan: TestPlan; reserve: () => Promise<void> },
): Promise<{ draft_run_id: string; reference_run_id: string | null; started_reference: boolean }> {
  await args.reserve();
  const draftRun = await createRun(tx, queue, { apiId: args.apiId, ownerId: args.ownerId, trigger: 'draft_test', input: args.input });
  await tx.query('UPDATE runs SET strategy_version = $2 WHERE id = $1', [draftRun.runId, args.plan.draft_version]);
  let reference = args.plan.reference_run_id;
  let started = false;
  if (reference === null) {
    await args.reserve();
    const run = await createRun(tx, queue, { apiId: args.apiId, ownerId: args.ownerId, trigger: 'draft_test', input: args.input });
    await tx.query('UPDATE runs SET strategy_version = $2 WHERE id = $1', [run.runId, args.plan.base_version]);
    reference = run.runId;
    started = true;
  }
  return { draft_run_id: draftRun.runId, reference_run_id: reference, started_reference: started };
}

type RunFacts = { id: string; state: string; outcome: string | null; items: number; items_rejected: number; cost_llm_usd: string | null; cost_proxy_usd: string; input: unknown; strategy_version: number | null };

async function readRunFacts(tx: Tx, runId: string): Promise<RunFacts | null> {
  const { rows } = await tx.query<RunFacts>('SELECT id, state, outcome, items, items_rejected, cost_llm_usd, cost_proxy_usd, input, strategy_version FROM runs WHERE id = $1', [runId]);
  return rows[0] ?? null;
}

async function readItems(tx: Tx, runId: string): Promise<Json[]> {
  const { rows } = await tx.query<{ item: Json }>(
    'SELECT di.item FROM datasets d JOIN dataset_items di ON di.dataset_id = d.id WHERE d.run_id = $1 AND d.deleted_at IS NULL ORDER BY di.seq LIMIT $2',
    [runId, ITEMS_READ_MAX],
  );
  return rows.map((r) => r.item);
}

/** Deux derniers runs sains de la version en service sur la même entrée : la référence de bruit (r3 R10). */
async function noiseReference(tx: Tx, apiId: string, version: number, input: unknown, keyFields: readonly string[]): Promise<string[]> {
  if (keyFields.length === 0) return [];
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM runs WHERE api_id = $1 AND strategy_version = $2 AND state = 'succeeded' AND outcome = 'clean' AND input IS NOT DISTINCT FROM $3::jsonb
       AND trigger <> 'draft_refine' ORDER BY created_at DESC LIMIT 2`,
    [apiId, version, input === undefined ? null : JSON.stringify(input)],
  );
  if (rows.length < 2) return [];
  return noiseFieldsOf(await readItems(tx, rows[0]!.id), await readItems(tx, rows[1]!.id), keyFields);
}

const usdOf = (llm: string | null, proxy: string): { total: number | null; llm: number | null } =>
  llm === null ? { total: null, llm: null } : { total: round6(Number(llm) + Number(proxy)), llm: Number(llm) };

/**
 * Enregistre le résultat d'un test sur le brouillon (une fois les runs terminés) : conformité, coût, rejeu sans LLM, diff contre
 * la version en service, empreinte du diff. Le test REVALIDE la base : `base_stale` retombe, `base_version` suit la version en
 * service. Rend le test enregistré, ou null si l'un des runs n'est pas fini.
 */
export async function recordDraftTest(pool: pg.Pool, args: { apiId: string; ownerId: string; draftRunId: string; referenceRunId: string | null; now?: Date }): Promise<LastTest | null> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const apiRow = await readApi(tx, { apiId: args.apiId, ownerId: args.ownerId, lock: 'wait' });
    const draftRun = await readRunFacts(tx, args.draftRunId);
    if (draftRun === null) throw new IterationError('not_found');
    const draft = draftRun.strategy_version === null ? null : await readVersion(tx, apiRow.id, draftRun.strategy_version, true);
    if (draft === null || draft.state !== 'draft') throw new IterationError('no_draft');
    const terminal = (s: string) => ['succeeded', 'failed', 'cancelled'].includes(s) || s.startsWith('skipped');
    if (!terminal(draftRun.state)) return null;
    const referenceRun = args.referenceRunId === null ? null : await readRunFacts(tx, args.referenceRunId);
    if (referenceRun !== null && !terminal(referenceRun.state)) return null;
    const base = apiRow.current_strategy_version as number;
    const draftSchema = draft.output_schema ?? apiRow.output_schema;
    const keyFields = identityKeyFields(draftSchema);
    const ok = draftRun.state === 'succeeded' && draftRun.items_rejected === 0 && draftRun.items > 0;
    const cost = usdOf(draftRun.cost_llm_usd, draftRun.cost_proxy_usd);
    const refCost = referenceRun === null ? null : usdOf(referenceRun.cost_llm_usd, referenceRun.cost_proxy_usd).total;
    let diff: ItemsDiff | null = null;
    let hash: string | null = null;
    let summary: DiffSummaryParts | null = null;
    if (draftRun.state === 'succeeded' && referenceRun !== null && referenceRun.state === 'succeeded') {
      const noise = await noiseReference(tx, apiRow.id, base, draftRun.input, keyFields);
      diff = diffItems(await readItems(tx, referenceRun.id), await readItems(tx, draftRun.id), { keyFields, noiseFields: noise, personalFields: personalTopFields(draftSchema) });
      summary = diffSummaryParts(diff);
      hash = diffHash(diff, {
        draftVersion: draft.version,
        baseVersion: base,
        schemaVersion: draft.output_schema_version,
        specSha256: jsonSha256({ spec: draft.spec, execution: draft.execution, network: draft.network, schema: draftSchema }),
      });
    }
    const test: LastTest = {
      run_id: draftRun.id,
      reference_run_id: referenceRun?.id ?? null,
      tested_at: (args.now ?? new Date()).toISOString(),
      input_hash: jsonSha256(draftRun.input ?? null),
      state: draftRun.state,
      ok,
      items: draftRun.items,
      items_rejected: draftRun.items_rejected,
      cost_usd: cost.total,
      llm_usd: cost.llm,
      // Rejeu compilé sans appel de modèle : coût LLM nul sur un run déclaratif (19 §6).
      llm_free: cost.llm !== null && cost.llm === 0,
      replay_cost_usd: cost.total,
      reference_cost_usd: refCost,
      base_version: base,
      schema_version: draft.output_schema_version,
      reference: referenceRun === null ? 'none' : 'run',
      diff,
      diff_hash: hash,
      summary,
    };
    await tx.query('UPDATE strategy_versions SET last_test = $3::jsonb, base_version = $4, base_stale = false WHERE api_id = $1 AND version = $2', [apiRow.id, draft.version, JSON.stringify(test), base]);
    return test;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Reprise : ce qu'une nouvelle conversation doit savoir (propriétaire seul)
// ---------------------------------------------------------------------------------------------------------------

export type NextStep = 'refine' | 'test' | 'promote' | 'retest' | 'blocked';

export type IterationVersionSummary = {
  version: number;
  state: 'draft' | 'current' | 'archived';
  was_current: boolean;
  created_by: string;
  output_schema_version: string;
  archive_reason: string | null;
  created_at: string;
};

export type IterationView = {
  slug: string;
  status: string;
  current_version: number | null;
  output_schema_version: string;
  draft: null | {
    version: number;
    base_version: number;
    base_stale: boolean;
    output_schema_version: string;
    schema_level: SchemaChangeLevel;
    schema_changes: readonly SchemaChange[];
    expires_at: string | null;
    feedback: { at: string; kind: string; field: string | null; origin: string; text: string }[];
    tested: boolean;
    last_test: LastTest | null;
  };
  versions: IterationVersionSummary[];
  next_step: NextStep;
};

export async function readIterationView(pool: pg.Pool, args: { slug: string; ownerId: string; now?: Date }): Promise<IterationView | null> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    let apiRow: ApiState;
    try {
      apiRow = await readApi(tx, { slug: args.slug, ownerId: args.ownerId });
    } catch (error) {
      if (error instanceof IterationError && error.code === 'not_found') return null;
      throw error;
    }
    const draft = await readDraftRow(tx, apiRow, args.now ?? new Date());
    const versions = await tx.query<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM strategy_versions WHERE api_id = $1 ORDER BY version DESC LIMIT 10`, [apiRow.id]);
    const level = draft !== null && draft.output_schema !== null ? classifySchemaChange(apiRow.output_schema, draft.output_schema) : { level: 'none' as const, changes: [] as readonly SchemaChange[] };
    const tested = draft !== null && draft.last_test !== null;
    let next: NextStep = 'refine';
    if (BLOCKED_STATUSES.has(apiRow.status)) next = 'blocked';
    else if (draft !== null) next = draft.base_stale ? 'retest' : !tested ? 'test' : draft.last_test?.ok === true ? 'promote' : 'refine';
    return {
      slug: apiRow.slug,
      status: apiRow.status,
      current_version: apiRow.current_strategy_version,
      output_schema_version: apiRow.output_schema_version,
      draft:
        draft === null
          ? null
          : {
              version: draft.version,
              base_version: draft.base_version ?? (apiRow.current_strategy_version as number),
              base_stale: draft.base_stale,
              output_schema_version: draft.output_schema_version,
              schema_level: level.level,
              schema_changes: level.changes,
              expires_at: draft.expires_at?.toISOString() ?? null,
              feedback: feedbackOf(draft).map((f) => ({ at: f.at, kind: f.kind, field: f.field, origin: f.origin, text: f.text })),
              tested,
              last_test: draft.last_test,
            },
      versions: versions.rows.map((v) => ({
        version: v.version,
        state: v.state,
        was_current: v.was_current,
        created_by: v.created_by,
        output_schema_version: v.output_schema_version,
        archive_reason: v.archive_reason,
        created_at: v.created_at.toISOString(),
      })),
      next_step: next,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Promotion et retour de version : le pointeur et la transition 22 dans la même transaction
// ---------------------------------------------------------------------------------------------------------------

export type Impacted = { kind: 'view_column' | 'schedule_dedup_key'; ref: string; field: string };

/** Champs retirés ou retypés par les changements : ceux que des consommateurs lisent peut-être. */
const breakingFields = (changes: readonly SchemaChange[]): string[] =>
  [...new Set(changes.filter((c) => c.level === 'major' && ['field_removed', 'type_changed', 'required_removed'].includes(c.kind)).map((c) => c.path.split('.')[0]!.replace(/\[\]$/, '')))].filter((f) => f !== '');

/** Usages connus de ces champs : colonnes de la vue de l'API, clé de déduplication d'une planification. */
async function impactedBy(tx: Tx, apiId: string, fields: readonly string[]): Promise<Impacted[]> {
  if (fields.length === 0) return [];
  const out: Impacted[] = [];
  const views = await tx.query<{ columns: string[] | null }>("SELECT views -> 'columns' AS columns FROM apis WHERE id = $1", [apiId]);
  for (const col of views.rows[0]?.columns ?? []) if (fields.includes(String(col))) out.push({ kind: 'view_column', ref: 'views.columns', field: String(col) });
  const schedules = await tx.query<{ id: string; k: string | null }>("SELECT id, rules ->> 'dedup_key' AS k FROM schedules WHERE api_id = $1 AND rules ->> 'dedup_key' IS NOT NULL", [apiId]);
  for (const s of schedules.rows) {
    const top = String(s.k).replace(/^item\./, '').split('.')[0]!;
    if (fields.includes(top)) out.push({ kind: 'schedule_dedup_key', ref: s.id, field: top });
  }
  return out.slice(0, 20);
}

export type PromotionPlan = {
  draft_version: number;
  base_version: number;
  level: SchemaChangeLevel;
  changes: readonly SchemaChange[];
  schema_version_from: string;
  schema_version_to: string;
  impacted: Impacted[];
  /** Tout est en ordre côté brouillon (testé, conforme, base à jour) : sinon `ready_error`. */
  ready_error: IterationErrorCode | null;
  diff_hash: string | null;
  summary: DiffSummaryParts | null;
  estimate_delta_usd: number | null;
};

/** Ce que la promotion engage, sans rien écrire : niveau du changement (porte de promotion), usages touchés, état du brouillon. */
export async function planPromotion(pool: pg.Pool, args: { apiId: string; ownerId: string; now?: Date }): Promise<PromotionPlan> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const apiRow = await readApi(tx, { apiId: args.apiId, ownerId: args.ownerId });
    assertIterable(apiRow);
    const draft = await readDraftRow(tx, apiRow, args.now ?? new Date());
    if (draft === null) throw new IterationError('no_draft');
    const classification = draft.output_schema === null ? { level: 'none' as const, changes: [] as readonly SchemaChange[] } : classifySchemaChange(apiRow.output_schema, draft.output_schema);
    const readiness = readinessOf(draft, apiRow, { acceptCostIncrease: true });
    return {
      draft_version: draft.version,
      base_version: draft.base_version ?? (apiRow.current_strategy_version as number),
      level: classification.level,
      changes: classification.changes,
      schema_version_from: apiRow.output_schema_version,
      schema_version_to: releasedSchemaVersion(draft.output_schema_version),
      impacted: await impactedBy(tx, apiRow.id, breakingFields(classification.changes)),
      ready_error: readiness,
      diff_hash: draft.last_test?.diff_hash ?? null,
      summary: draft.last_test?.summary ?? null,
      estimate_delta_usd: draft.last_test === null || draft.last_test.replay_cost_usd === null || draft.last_test.reference_cost_usd === null ? null : round6(draft.last_test.replay_cost_usd - draft.last_test.reference_cost_usd),
    };
  });
}

/** Contrôles du code avant toute promotion (19 §6) ; `null` : prête. Les mêmes sont rejoués sous verrou à l'application. */
function readinessOf(draft: VersionRow, api: ApiState, opts: { acceptCostIncrease: boolean; diffHash?: string }): IterationErrorCode | null {
  const base = api.current_strategy_version;
  if (draft.base_stale || draft.base_version !== base) return 'base_stale';
  const test = draft.last_test;
  if (test === null) return 'not_tested';
  if (test.base_version !== base) return 'base_stale';
  if (opts.diffHash !== undefined && (test.diff_hash === null || test.diff_hash !== opts.diffHash)) return 'diff_hash_mismatch';
  if (test.diff_hash === null) return 'not_tested';
  if (!test.ok || test.items_rejected > 0) return 'not_conform';
  if (test.items < PROMOTION_MIN_SAMPLES) return 'too_few_samples';
  if (DECLARATIVE.has(draft.execution) && !test.llm_free) return 'replay_not_llm_free';
  if (!opts.acceptCostIncrease && test.replay_cost_usd !== null && test.reference_cost_usd !== null && test.replay_cost_usd > test.reference_cost_usd + 1e-9) return 'cost_increase_requires_accept';
  return null;
}

export type MoveResult = {
  current_version: number;
  previous_version: number;
  status: string;
  transition: 22 | null;
  output_schema_version: string;
};

async function moveStatus(
  pool: pg.Pool,
  queue: JobQueue,
  args: { apiId: string; ownerId: string; via: 'promoted' | 'reverted'; move: (db: pg.PoolClient) => Promise<{ current: number; previous: number; schemaVersion: string }> },
): Promise<MoveResult> {
  const status = (await pool.query<{ status: string }>('SELECT status FROM apis WHERE id = $1 AND owner_id = $2', [args.apiId, args.ownerId])).rows[0]?.status;
  if (status === undefined) throw new IterationError('not_found');
  if (BLOCKED_STATUSES.has(status)) throw new IterationError('api_blocked');
  if (BUSY_STATUSES.has(status)) throw new IterationError('api_busy');
  let moved: { current: number; previous: number; schemaVersion: string } | null = null;
  const step = await applyStatusAndNotify(pool, queue, {
    apiId: args.apiId,
    event: { type: 'version_promoted', via: args.via },
    clock: { now: () => new Date() },
    beforeWrite: async (db) => {
      moved = await args.move(db);
    },
  });
  if (!step.ok || moved === null) throw new IterationError('status_not_promotable');
  const m = moved as { current: number; previous: number; schemaVersion: string };
  return { current_version: m.current, previous_version: m.previous, status: step.state.status, transition: step.transitions.some((t) => t.transition === 22) ? 22 : null, output_schema_version: m.schemaVersion };
}

/**
 * Promeut le brouillon : contrôles sous verrou, pointeur déplacé et transition 22 (depuis `erreur`) au même COMMIT. Les gardes
 * HUMAINES (porte de promotion, accusé `major`) sont décidées avant par la route (`decidePromotion`) : ce service ne promeut pas
 * sans elles, il n'est appelé qu'après. `diffHash` : celui du dernier test, sinon `diff_hash_mismatch`.
 */
export async function promoteDraft(pool: pg.Pool, queue: JobQueue, args: { apiId: string; ownerId: string; diffHash: string; acceptCostIncrease?: boolean; now?: Date }): Promise<MoveResult> {
  const now = args.now ?? new Date();
  return moveStatus(pool, queue, {
    apiId: args.apiId,
    ownerId: args.ownerId,
    via: 'promoted',
    move: async (db) => {
      const { rows } = await db.query<ApiState>(`SELECT ${API_COLUMNS} FROM apis WHERE id = $1 AND owner_id = $2`, [args.apiId, args.ownerId]);
      const apiRow = rows[0];
      if (apiRow === undefined) throw new IterationError('not_found');
      assertIterable(apiRow);
      const draft = await readDraftRow(db, apiRow, now, true);
      if (draft === null) throw new IterationError('no_draft');
      const refused = readinessOf(draft, apiRow, { acceptCostIncrease: args.acceptCostIncrease === true, diffHash: args.diffHash });
      if (refused !== null) throw new IterationError(refused);
      const previous = apiRow.current_strategy_version as number;
      const newSchema = draft.output_schema ?? apiRow.output_schema;
      const released = releasedSchemaVersion(draft.output_schema_version);
      // La version qui sort garde son schéma (un retour la rétablit avec lui).
      await db.query('UPDATE strategy_versions SET output_schema = COALESCE(output_schema, $3::jsonb), output_schema_version = $4 WHERE api_id = $1 AND version = $2', [apiRow.id, previous, JSON.stringify(apiRow.output_schema), apiRow.output_schema_version]);
      await db.query('UPDATE strategy_versions SET output_schema_version = $3 WHERE api_id = $1 AND version = $2', [apiRow.id, draft.version, released]);
      const columns = columnsOf(newSchema);
      await db.query(
        `UPDATE apis SET current_strategy_version = $2, output_schema = $3::jsonb, output_schema_version = $4, draft_strategy_version = NULL,
           output_columns = COALESCE($5::text[], output_columns), updated_at = now() WHERE id = $1`,
        [apiRow.id, draft.version, JSON.stringify(newSchema), released, columns],
      );
      await pruneVersions(db, apiRow.id);
      return { current: draft.version, previous, schemaVersion: released };
    },
  });
}

export type RevertPlan = { target_version: number; level: SchemaChangeLevel; schema_version_from: string; schema_version_to: string; crosses_schema_version: boolean };

/** Version visée par `revert_api` : celle demandée, sinon la plus récente qui a été courante avant la version en service. */
async function revertTarget(tx: Tx, apiRow: ApiState, version: number | undefined): Promise<VersionRow> {
  if (apiRow.current_strategy_version === null) throw new IterationError('no_current_version');
  if (version === undefined) {
    const { rows } = await tx.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM strategy_versions WHERE api_id = $1 AND was_current AND version <> $2 AND archive_reason IS NULL ORDER BY version DESC LIMIT 1`,
      [apiRow.id, apiRow.current_strategy_version],
    );
    if (rows[0] === undefined) throw new IterationError('no_previous_version');
    return rows[0];
  }
  const target = await readVersion(tx, apiRow.id, version);
  if (target === null) throw new IterationError('not_found');
  // Une version jamais courante (brouillon écarté, vN+1 de réparation non validée) ne devient jamais courante par un retour.
  if (!target.was_current) throw new IterationError('version_not_revertable');
  if (target.version === apiRow.current_strategy_version) throw new IterationError('already_current');
  return target;
}

/** Ce qu'un retour engage (franchit-il une version de schéma ? alors porte « promotion » et accusé `major`). */
export async function planRevert(pool: pg.Pool, args: { apiId: string; ownerId: string; version?: number }): Promise<RevertPlan> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const apiRow = await readApi(tx, { apiId: args.apiId, ownerId: args.ownerId });
    assertIterable(apiRow);
    const target = await revertTarget(tx, apiRow, args.version);
    const to = releasedSchemaVersion(target.output_schema_version);
    const crosses = target.output_schema !== null && crossesSchemaVersion(apiRow.output_schema_version, to);
    return { target_version: target.version, level: crosses ? 'major' : 'none', schema_version_from: apiRow.output_schema_version, schema_version_to: crosses ? to : apiRow.output_schema_version, crosses_schema_version: crosses };
  });
}

/**
 * Retour de version : déplacement de pointeur vers une version qui a été courante (aucune copie, aucun nouveau numéro).
 * Depuis `erreur` : transition 22 (`reverted`). Le brouillon reste (marqué `base_stale`).
 */
export async function revertCurrent(pool: pg.Pool, queue: JobQueue, args: { apiId: string; ownerId: string; version?: number }): Promise<MoveResult> {
  return moveStatus(pool, queue, {
    apiId: args.apiId,
    ownerId: args.ownerId,
    via: 'reverted',
    move: async (db) => {
      const { rows } = await db.query<ApiState>(`SELECT ${API_COLUMNS} FROM apis WHERE id = $1 AND owner_id = $2`, [args.apiId, args.ownerId]);
      const apiRow = rows[0];
      if (apiRow === undefined) throw new IterationError('not_found');
      assertIterable(apiRow);
      const target = await revertTarget(db, apiRow, args.version);
      const previous = apiRow.current_strategy_version as number;
      const schema = target.output_schema ?? apiRow.output_schema;
      const schemaVersion = target.output_schema !== null ? releasedSchemaVersion(target.output_schema_version) : apiRow.output_schema_version;
      await db.query('UPDATE strategy_versions SET output_schema = COALESCE(output_schema, $3::jsonb), output_schema_version = $4 WHERE api_id = $1 AND version = $2', [apiRow.id, previous, JSON.stringify(apiRow.output_schema), apiRow.output_schema_version]);
      await db.query(
        `UPDATE apis SET current_strategy_version = $2, output_schema = $3::jsonb, output_schema_version = $4, output_columns = COALESCE($5::text[], output_columns), updated_at = now() WHERE id = $1`,
        [apiRow.id, target.version, JSON.stringify(schema), schemaVersion, columnsOf(schema)],
      );
      return { current: target.version, previous, schemaVersion };
    },
  });
}

/** Porte de promotion de l'utilisateur (`users.promotion_gate`) : jamais plus large que `major_in_console`. */
export async function readPromotionGate(pool: pg.Pool, userId: string): Promise<'major_in_console' | 'all_in_console'> {
  const { rows } = await pool.query<{ promotion_gate: string }>('SELECT promotion_gate FROM users WHERE id = $1', [userId]);
  return rows[0]?.promotion_gate === 'all_in_console' ? 'all_in_console' : 'major_in_console';
}

// ---------------------------------------------------------------------------------------------------------------
// Test lancé, résultat à enregistrer : une conversation qui revient plus tard retrouve le diff
// ---------------------------------------------------------------------------------------------------------------

/**
 * Enregistre le test du brouillon quand les runs de test lancés pour lui sont finis (sans que l'appelant ait attendu) :
 * `null` si aucun test n'a été lancé, `pending` s'il reste un run en cours, sinon le test enregistré (déjà ou à l'instant).
 * La référence est le run de la version en service lancé avec l'essai (même entrée, même instant), sinon le plus récent.
 */
export async function settleDraftTest(pool: pg.Pool, args: { apiId: string; ownerId: string; now?: Date }): Promise<LastTest | 'pending' | null> {
  const found = await withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const apiRow = await readApi(tx, { apiId: args.apiId, ownerId: args.ownerId });
    if (apiRow.current_strategy_version === null) return null;
    const draft = await readDraftRow(tx, apiRow, args.now ?? new Date());
    if (draft === null) return null;
    const { rows } = await tx.query<{ id: string; state: string; input: unknown; created_at: Date }>(
      "SELECT id, state, input, created_at FROM runs WHERE api_id = $1 AND strategy_version = $2 AND trigger = 'draft_test' ORDER BY created_at DESC LIMIT 1",
      [apiRow.id, draft.version],
    );
    const run = rows[0];
    if (run === undefined) return null;
    if (draft.last_test !== null && draft.last_test.run_id === run.id) return { kind: 'done' as const, test: draft.last_test };
    const terminal = (s: string) => ['succeeded', 'failed', 'cancelled'].includes(s) || s.startsWith('skipped');
    if (!terminal(run.state)) return 'pending' as const;
    const base = apiRow.current_strategy_version;
    const sibling = await tx.query<{ id: string; state: string }>(
      `SELECT id, state FROM runs WHERE api_id = $1 AND strategy_version = $2 AND trigger = 'draft_test' AND input IS NOT DISTINCT FROM $3::jsonb
         AND created_at BETWEEN $4::timestamptz - interval '60 seconds' AND $4::timestamptz + interval '60 seconds' ORDER BY created_at DESC LIMIT 1`,
      [apiRow.id, base, run.input === null ? null : JSON.stringify(run.input), run.created_at],
    );
    if (sibling.rows[0] !== undefined && !terminal(sibling.rows[0].state)) return 'pending' as const;
    const reference = sibling.rows[0]?.id ?? (await findReferenceRun(tx, apiRow.id, base, run.input));
    return { kind: 'record' as const, run: run.id, reference };
  });
  if (found === null) return null;
  if (found === 'pending') return 'pending';
  if (found.kind === 'done') return found.test;
  return recordDraftTest(pool, { apiId: args.apiId, ownerId: args.ownerId, draftRunId: found.run, referenceRunId: found.reference });
}
