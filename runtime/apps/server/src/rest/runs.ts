// SPDX-License-Identifier: AGPL-3.0-only
// Runs vus par l'API REST (tâche 3.1, 05 § 4.1 et § 4.2, 04b § 1) : métadonnées, détail, enveloppe `RunResult` commune au
// REST et au MCP (3.2), attente synchrone bornée.
//
// Droits (INV5, INV12, 13 § 2) : le contenu d'un run (entrée, essais, items, journal) se lit sous `withActor`, donc
// seulement par son propriétaire (RLS) ; l'admin et l'owner lisent les MÉTADONNÉES d'un run d'autrui par la vue
// `admin_run_metadata` (état, coût, durée, nombre d'items), jamais son contenu.
import { isTerminalRunState, type RunState } from '@runtime/core';
import { withActor } from '@runtime/db';
import type pg from 'pg';
import type { ServerContext } from '../context.js';
import type { Actor } from '../routes/guard.js';
import { runErrorOf, runNotStarted } from './run-error.js';
import { iso, reasonMessage, usd, usdOrNull } from './shared.js';
import { investigationTimeline } from './timeline.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

/** Plafond par réponse (05 § 4.1) : 20 items et environ 10 000 tokens (≈ 40 000 caractères JSON ; chiffres à valider). */
const RESULT_MAX_ITEMS = 20;
const RESULT_MAX_CHARS = 40_000;

/** Ligne `runs` lue par l'API (colonnes de contenu comprises : propriétaire seulement). */
export type RunRow = {
  id: string;
  api_id: string;
  api_slug: string | null;
  owner_id: string;
  kind: 'run' | 'investigation';
  strategy_version: number | null;
  trigger: string;
  state: RunState;
  outcome: string | null;
  degraded_reasons: string[];
  failure_class: string | null;
  retryable: boolean | null;
  /** Cause stable d'un échec ou d'un arrêt (`instance_contact_missing`…), masquée à l'écriture (INV8). */
  error_detail: string | null;
  cost_llm_usd: string | null;
  cost_proxy_usd: string;
  tokens_in: string;
  tokens_cached: string;
  tokens_out: string;
  tokens_reasoning: string;
  usage_estimated: boolean;
  items: number;
  dataset_id: string | null;
  duration_ms: number | null;
  trace_id: string | null;
  input: unknown;
  paused_at: Date | null;
  created_at: Date;
  created_text: string;
  started_at: Date | null;
  finished_at: Date | null;
  retention_until: Date | null;
};

const RUN_COLUMNS = `r.id, r.api_id, a.slug AS api_slug, r.owner_id, r.kind, r.strategy_version, r.trigger, r.state, r.outcome,
  r.degraded_reasons, r.failure_class, r.retryable, r.error_detail, r.cost_llm_usd, r.cost_proxy_usd, r.tokens_in, r.tokens_cached, r.tokens_out,
  r.tokens_reasoning, r.usage_estimated, r.items, r.dataset_id, r.duration_ms, r.trace_id, r.input, r.paused_at, r.created_at, r.created_at::text AS created_text,
  r.started_at, r.finished_at, d.expires_at AS retention_until`;

/** Jointures de `RUN_COLUMNS` : l'API (sous RLS : invisible → slug null) et le dataset du run (échéance de rétention). */
const RUN_FROM = 'runs r LEFT JOIN apis a ON a.id = r.api_id LEFT JOIN datasets d ON d.id = r.dataset_id';

/** Run de l'acteur (sous `withActor` : RLS) ; null si inexistant ou d'autrui. */
export async function readRunRow(db: Queryable, runId: string): Promise<RunRow | null> {
  const { rows } = await db.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM ${RUN_FROM} WHERE r.id = $1`, [runId]);
  return rows[0] ?? null;
}

/** Liste de runs (filtre SQL fourni par l'appelant, paramètres à partir de $1). */
export async function listRunRows(db: Queryable, where: string, params: unknown[], limit: number): Promise<RunRow[]> {
  const { rows } = await db.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM ${RUN_FROM} WHERE ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ${limit}`, params);
  return rows;
}

const cost = (r: Pick<RunRow, 'cost_llm_usd' | 'cost_proxy_usd' | 'usage_estimated'>) => {
  const llm = usdOrNull(r.cost_llm_usd);
  const proxy = usd(r.cost_proxy_usd);
  return { llm_usd: llm, proxy_usd: proxy, total_usd: llm === null ? null : Math.round((llm + proxy) * 1e6) / 1e6, estimated: r.usage_estimated };
};

/** `error` : la cause nommée d'un run en échec (UX-04), absente sinon. */
const errorField = (r: Pick<RunRow, 'state' | 'error_detail'>) => {
  const error = runErrorOf(r);
  return error === null ? {} : { error };
};

/** `RunSummary` (05 § 4.2, 06 § 2) : métadonnées, jamais d'items. */
export function runSummary(r: RunRow) {
  return {
    id: r.id,
    api_id: r.api_id,
    api_slug: r.api_slug ?? '',
    owner_id: r.owner_id,
    strategy_version: r.strategy_version,
    trigger: r.trigger,
    state: r.state,
    outcome: r.outcome,
    degraded_reasons: r.degraded_reasons,
    failure_class: r.failure_class,
    ...(r.retryable === null ? {} : { retryable: r.retryable }),
    ...errorField(r),
    created_at: r.created_at.toISOString(),
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
    duration_ms: r.duration_ms,
    cost: cost(r),
    items: r.items,
    dataset_id: r.dataset_id,
    retention_until: iso(r.retention_until),
  };
}

type AttemptRow = {
  seq: number;
  execution: string;
  network: string;
  est_cost_usd: string | null;
  result_class: string | null;
  cost_usd: string | null;
  ms: number | null;
  model_id: string | null;
  prompt_version: string | null;
  engine: string | null;
};

/** Détail d'un run de l'acteur (`Run`) : cascade d'essais, jetons, entrée, pause. */
export async function runDetail(db: Queryable, r: RunRow) {
  const attempts = await db.query<AttemptRow>(
    'SELECT seq, execution, network, est_cost_usd, result_class, cost_usd, ms, model_id, prompt_version, engine FROM run_attempts WHERE run_id = $1 ORDER BY seq',
    [r.id],
  );
  return {
    ...runSummary(r),
    metadata_only: false,
    attempts: attempts.rows.map((a) => ({
      index: a.seq,
      execution: a.execution,
      network: a.network,
      state: 'done' as const,
      est_cost_usd: usdOrNull(a.est_cost_usd),
      result: a.result_class ?? 'ok',
      cost_usd: usdOrNull(a.cost_usd),
      ms: a.ms,
      model_id: a.model_id,
      prompt_version: a.prompt_version,
      engine: a.engine,
      error: a.result_class === null || a.result_class === 'ok' ? null : reasonMessage(a.result_class),
    })),
    tokens: { in: Number(r.tokens_in), cached: Number(r.tokens_cached), out: Number(r.tokens_out), reasoning: Number(r.tokens_reasoning), estimated: r.usage_estimated },
    trace_id: r.trace_id,
    paused_at: iso(r.paused_at),
    ...(r.input !== null && typeof r.input === 'object' && !Array.isArray(r.input) ? { input: r.input as Record<string, unknown> } : {}),
  };
}

type MetadataRow = {
  id: string;
  api_id: string;
  owner_id: string;
  trigger: string;
  state: RunState;
  outcome: string | null;
  failure_class: string | null;
  cost_llm_usd: string | null;
  cost_proxy_usd: string;
  duration_ms: number | null;
  items: number;
  created_at: Date;
  finished_at: Date | null;
};

/**
 * Métadonnées d'un run d'autrui pour l'admin et l'owner (INV5, 05 § 4.4 `assert_no_impersonation`) : état, coût, durée,
 * nombre d'items, par la vue `admin_run_metadata` ; ni entrée, ni essais, ni dataset. null pour un membre ou un run inconnu.
 */
export async function runMetadataForAdmin(ctx: ServerContext, actor: Actor, runId: string) {
  if (actor.role !== 'admin' && actor.role !== 'owner') return null;
  const row = await withActor(ctx.pool, actor, async (db) => (await db.query<MetadataRow>('SELECT * FROM admin_run_metadata WHERE id = $1', [runId])).rows[0]);
  if (!row) return null;
  // Slug : métadonnée de l'API (identité système, lecture d'une seule colonne non sensible).
  const slug = (await ctx.pool.query<{ slug: string }>('SELECT slug FROM apis WHERE id = $1', [row.api_id])).rows[0]?.slug ?? '';
  const llm = usdOrNull(row.cost_llm_usd);
  const proxy = usd(row.cost_proxy_usd);
  return {
    id: row.id,
    api_id: row.api_id,
    api_slug: slug,
    owner_id: row.owner_id,
    strategy_version: null,
    trigger: row.trigger,
    state: row.state,
    outcome: row.outcome,
    degraded_reasons: [],
    failure_class: row.failure_class,
    created_at: row.created_at.toISOString(),
    started_at: null,
    finished_at: iso(row.finished_at),
    duration_ms: row.duration_ms,
    cost: { llm_usd: llm, proxy_usd: proxy, total_usd: llm === null ? null : Math.round((llm + proxy) * 1e6) / 1e6 },
    items: row.items,
    dataset_id: null,
    retention_until: null,
    metadata_only: true,
    attempts: [],
    tokens: { in: 0, cached: 0, out: 0, reasoning: 0, estimated: true },
    trace_id: null,
    paused_at: null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Enveloppe RunResult (05 § 4.1)
// ---------------------------------------------------------------------------------------------------------------

/** Curseur opaque d'items : `seq` du dernier item servi. */
export function itemsCursor(seq: number): string {
  return Buffer.from(JSON.stringify({ s: seq })).toString('base64url');
}

/** `seq` d'un curseur d'items ; undefined si absent, null si illisible (400). */
export function decodeItemsCursor(cursor: string | undefined): number | null | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown };
    if (Number.isInteger(value.s) && (value.s as number) >= -1) return value.s as number;
  } catch {
    // illisible
  }
  return null;
}

/** Phrase de l'enveloppe : gabarit fermé en anglais (texte d'outil, 05 § 4.3), jamais un texte du site. */
function messageOf(r: RunRow, status: string, total: number, awaitingSchema: boolean): string {
  if (r.paused_at !== null) return 'The run is paused; resume it with POST /api/runs/{id}/resume.';
  if (r.state === 'queued' || r.state === 'running' || r.state === 'waiting_tunnel') {
    return r.kind === 'investigation' ? 'The investigation is still running; poll get_run for its progress.' : 'The run is still running; poll get_run for its result.';
  }
  if (r.state === 'cancelled') return 'The run was cancelled; incurred costs remain charged.';
  if (r.state.startsWith('skipped_')) return `The run was skipped (${r.state}).`;
  if (r.state === 'failed') {
    // Cause nommée (UX-04) : la phrase la dit, au lieu de la seule classe d'échec.
    const error = runErrorOf(r);
    if (error !== null) return `The run ${runNotStarted(r) ? 'could not start' : 'ended without a known cost'} (${error.code}): ${error.message} The API is now ${status}.`;
    return `The run failed (${r.failure_class ?? 'unknown'}); the API is now ${status}.`;
  }
  if (awaitingSchema) return 'The investigation proposed an output schema: validate it (validate_schema) to start the trials.';
  if (r.kind === 'investigation') return `The investigation finished; the API is now ${status}.`;
  if (r.outcome === 'degraded') return `The run succeeded with warnings (${r.degraded_reasons.join(', ') || 'degraded'}): ${total} items. Mention it to the user.`;
  return `The run succeeded: ${total} items.`;
}

/**
 * `RunResult` d'un run de l'acteur : au plus 20 items conformes (lus dans le dataset du run, déjà validés contre
 * `output_schema` par le worker, INV1), total, curseur de suite, état, statut de l'API, coût, prochaine action.
 */
export async function buildRunResult(ctx: ServerContext, actor: Actor, r: RunRow) {
  // Statut de l'API (métadonnée ; l'API d'un run de l'acteur peut ne plus lui être visible) et phase d'enquête.
  const api = (
    await ctx.pool.query<{ status: string; investigation_phase: string | null }>('SELECT status, investigation_phase FROM apis WHERE id = $1', [r.api_id])
  ).rows[0];
  const status = api?.status ?? 'erreur';
  const awaitingSchema = r.kind === 'investigation' && api?.investigation_phase === 'awaiting_schema_validation' && r.state === 'succeeded';
  const items: Record<string, unknown>[] = [];
  let lastSeq: number | null = null;
  let total = r.items;
  if (r.dataset_id !== null && r.state === 'succeeded') {
    const fetched = await withActor(ctx.pool, actor, async (db) => {
      const count = await db.query<{ item_count: number }>('SELECT item_count FROM datasets WHERE id = $1 AND deleted_at IS NULL', [r.dataset_id]);
      const page = await db.query<{ seq: number; item: Record<string, unknown> }>(
        'SELECT seq, item FROM dataset_items WHERE dataset_id = $1 ORDER BY seq LIMIT $2',
        [r.dataset_id, RESULT_MAX_ITEMS],
      );
      return { count: count.rows[0]?.item_count ?? null, page: page.rows };
    });
    if (fetched.count !== null) total = fetched.count;
    let chars = 0;
    for (const row of fetched.page) {
      chars += JSON.stringify(row.item).length;
      if (chars > RESULT_MAX_CHARS) break;
      items.push(row.item);
      lastSeq = row.seq;
    }
  }
  const truncated = total > items.length;
  const nextCursor = truncated && r.dataset_id !== null ? itemsCursor(lastSeq ?? -1) : null;
  const active = !isTerminalRunState(r.state);
  const nextAction = active
    ? { tool: 'get_run', args: { run_id: r.id } }
    : awaitingSchema
      ? { tool: 'validate_schema', args: { api_id: r.api_id } }
      : nextCursor !== null
        ? { tool: 'get_items', args: { dataset_id: r.dataset_id, cursor: nextCursor } }
        : null;
  return {
    run_id: r.id,
    state: r.state,
    status,
    items,
    total,
    dataset_id: r.dataset_id,
    truncated,
    next_cursor: nextCursor,
    degraded_reasons: r.degraded_reasons,
    message: messageOf(r, status, total, awaitingSchema),
    ...errorField(r),
    next_action: nextAction,
    poll_after_seconds: active && r.paused_at === null ? 5 : null,
    // Chronologie d'une enquête (05 § 1.2, tâche 3.10) : dérivée de `investigation_events`, la source unique du récit.
    timeline: r.kind === 'investigation' ? await investigationTimeline(ctx, actor, r.id, r.api_slug ?? '') : [],
    cost: cost(r),
    console_url: `${ctx.publicUrl}/runs/${r.id}`,
  };
}

/**
 * Attente synchrone bornée (`wait`, 05 § 2) : relit le run de l'acteur jusqu'à un état terminal, une pause ou l'échéance.
 * Rend la dernière lecture (null si le run a disparu).
 */
export async function waitForRun(ctx: ServerContext, actor: Actor, runId: string, seconds: number, signal?: AbortSignal): Promise<RunRow | null> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const row = await withActor(ctx.pool, actor, (db) => readRunRow(db, runId));
    if (row === null || isTerminalRunState(row.state) || row.paused_at !== null || Date.now() >= deadline || signal?.aborted) return row;
    await new Promise((resolve) => setTimeout(resolve, Math.min(ctx.rest.pollMs, Math.max(1, deadline - Date.now()))));
  }
}
