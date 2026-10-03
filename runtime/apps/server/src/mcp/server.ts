// SPDX-License-Identifier: AGPL-3.0-only
// Serveur MCP (tâche 3.2, 05 § 1 et § 4) : une instance `McpServer` (SDK v2) par requête, sans état, construite pour la
// clé qui appelle. Chaque outil est une façade de l'API REST de 3.1 : les écritures (création, validation, run,
// annulation) sont rejouées EN INTERNE sur la route REST avec la même clé (`inject`), donc avec sa garde, ses scopes, ses
// plafonds, sa case « j'ai lu », son audit et son filtre par propriétaire (INV12) ; les lectures (run, items, catalogue)
// passent par les mêmes services sous `withActor` (RLS). Aucune donnée d'une API d'autrui ne sort : objet d'autrui et
// objet inexistant répondent la même erreur `not_found`.
//
// Erreurs (05 § 4.3) : bloc texte JSON `{ code, message, what_to_do, retryable, next_action }`, `isError: true`, SANS
// `structuredContent`, y compris pour une exception levée dans un outil (`internal`, message interne jamais servi, erreur
// journalisée côté serveur). Un outil inconnu ou disparu entre deux listes reste une erreur de protocole `-32602`
// (spécification MCP), dont `data` porte `not_found` et la prochaine action `list_apis`. Succès : `structuredContent` et
// le même contenu en texte (le texte seul suffit à un client qui n'affiche pas `structuredContent`).
//
// Exposition (08b § 3) : `tools/list` ne montre que les outils dont la clé a le scope (un outil masqué reste enregistré :
// l'appeler répond 403 `insufficient_scope` avec le défi de scope, 05 § 4.4) ; les outils par API ne viennent que des API
// de l'appelant (jamais une API partagée d'un autre membre, joignable par `list_apis` et `run_api`).
import { randomUUID } from 'node:crypto';
import { can, compileSchema, formatIssues, isTerminalRunState, validateOutput, type Permission, type RunState } from '@runtime/core';
import { withActor } from '@runtime/db';
import { fromJsonSchema, McpServer, ProtocolError, ProtocolErrorCode, requireScopes, type CallToolResult, type jsonSchemaValidator, type ListToolsResult } from '@modelcontextprotocol/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context.js';
import { readApiById, readApiBySlug } from '../rest/apis.js';
import { datasetItems } from '../rest/export.js';
import { runErrorFor } from '../rest/run-error.js';
import { buildRunResult, decodeItemsCursor, itemsCursor, readRunRow, runMetadataForAdmin } from '../rest/runs.js';
import { waitSecondsOf } from '../rest/shared.js';
import { UUID } from '../routes/account-helpers.js';
import { audit, MCP_CHANNEL_HEADER, type Actor } from '../routes/guard.js';
import {
  apiToolDescription,
  apiToolName,
  BRIEF_MAX_BYTES,
  BRIEF_SCHEMA,
  GENERIC_TOOLS,
  MAX_API_TOOLS,
  MCP_INSTRUCTIONS,
  RUN_RESULT_SCHEMA,
  type GenericToolName,
  type Toolset,
} from './tools.js';

/** Appel en cours : la clé (acteur), la requête HTTP d'origine (en-têtes, IP pour l'audit) et l'application. */
export type McpCaller = { actor: Actor; request: FastifyRequest; app: FastifyInstance; toolsets: Set<Toolset> };

type Json = Record<string, unknown>;

/** Plafond de caractères d'une page d'items (≈ 10 000 jetons, 05 § 4.1, à valider), comme l'enveloppe RunResult. */
const ITEMS_MAX_CHARS = 40_000;
const ITEMS_DEFAULT_LIMIT = 20;

// ---------------------------------------------------------------------------------------------------------------
// Erreurs (05 § 4.3)
// ---------------------------------------------------------------------------------------------------------------

type ErrorGuide = { what_to_do: string; retryable: boolean };

/** Conduite à tenir par code (texte pour le modèle, en anglais, 21 § 4.3) ; jamais un texte du site ni une valeur reçue. */
const GUIDES: Record<string, ErrorGuide> = {
  not_found: { what_to_do: 'Check the slug or id with list_apis or get_run: you only see your own objects and the shared APIs.', retryable: false },
  invalid_input: { what_to_do: 'Fix the arguments to match the tool input schema (for run_api, the API input schema shown by get_api), then call again.', retryable: true },
  invalid_request: { what_to_do: 'Fix the arguments to match the tool input schema, then call again.', retryable: true },
  invalid_cursor: { what_to_do: 'Use the next_cursor returned by the previous call, or start again without cursor.', retryable: true },
  invalid_fields: { what_to_do: 'Name at most 100 top-level fields of the output schema.', retryable: true },
  invalid_schema: { what_to_do: 'Send a JSON Schema 2020-12 object without remote $ref, then call again.', retryable: true },
  blocked: { what_to_do: 'Tell the user that the site refused automated access to this API. Do not retry it and do not try other ways to reach the site.', retryable: false },
  api_error: { what_to_do: 'The API has no working strategy: its owner can investigate it again (run_api with force_investigate), or report_problem.', retryable: false },
  action_required: {
    what_to_do: 'Ask the user to act in the console first: connect the site with the browser extension, configure the proxy, or settle the paid access; then call again.',
    retryable: false,
  },
  investigation_in_progress: { what_to_do: 'An investigation is running for this API: follow it with get_api or get_run, then call again when it is done.', retryable: true },
  not_awaiting_validation: { what_to_do: 'This API is not waiting for a schema validation: read its state with get_api.', retryable: false },
  queue_full: { what_to_do: 'The instance queue is full: wait about 30 seconds, then call again.', retryable: true },
  user_queue_full: { what_to_do: 'Too many of your runs are active: wait for them (get_run) or cancel one (cancel_run), then call again.', retryable: true },
  key_rate_limited: { what_to_do: 'Too many runs started with this key in the last minute: wait one minute, then call again.', retryable: true },
  responsible_use_ack_required: { what_to_do: 'Ask the user to read the Responsible use page in the console and tick that they read it, then call again.', retryable: false },
  run_not_active: { what_to_do: 'This run is already finished: read its result with get_run.', retryable: false },
  forbidden: { what_to_do: 'This key or account is not allowed to do this; ask the API owner or an admin.', retryable: false },
  storage_full: { what_to_do: 'The instance storage is full: tell the user to ask the admin to free or extend it.', retryable: false },
  invalid_brief: { what_to_do: 'Remove or fix the named brief field (closed schema), or call create_api again without brief.', retryable: true },
  brief_too_large: { what_to_do: `Keep the highest-confidence hints and drop notes; resend under ${Math.floor(BRIEF_MAX_BYTES / 1000)} KB.`, retryable: true },
  brief_unavailable: { what_to_do: 'Call create_api again without brief: this instance does not read investigation briefs yet, and nothing was created.', retryable: true },
  // UX-04 : prérequis de l'instance, une tâche pour l'utilisateur ; l'appel peut être refait dès que le contact est posé.
  instance_contact_missing: { what_to_do: runErrorFor('instance_contact_missing').what_to_do, retryable: runErrorFor('instance_contact_missing').retryable },
  internal: { what_to_do: 'The instance hit an internal error: call again in a moment; if it persists, tell the user to check the instance logs.', retryable: true },
};

const DEFAULT_GUIDE: ErrorGuide = { what_to_do: 'Read the message; if it persists, report_problem with what you tried.', retryable: false };

/** Erreur d'outil (05 § 4.3) : texte JSON, `isError`, aucun `structuredContent`. */
function toolError(code: string, message: string, nextAction: Json | null = null, own?: ErrorGuide): CallToolResult {
  const guide = own ?? GUIDES[code] ?? DEFAULT_GUIDE;
  const body = { code, message, what_to_do: guide.what_to_do, retryable: guide.retryable, next_action: nextAction };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] };
}

const notFoundError = () => toolError('not_found', 'ressource introuvable', { tool: 'list_apis', args: {} });

/**
 * Outil inconnu, ou outil par API disparu entre deux listes : erreur de PROTOCOLE `-32602` (spécification MCP, « Unknown
 * tools » ; la suite de conformité l'exige), mais dont `data` porte la conduite de 05 § 4.3 (`not_found`, `what_to_do`,
 * prochaine action `list_apis`) au lieu du texte libre du SDK ; le nom reçu n'est pas recopié.
 */
function unknownToolError(): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown tool: call list_apis (or reconnect to refresh the tool list), then run_api with the API slug.', {
    code: 'not_found',
    what_to_do: 'The tool is unknown or was removed since the last tool list: call list_apis, then run_api with the slug.',
    retryable: false,
    next_action: { tool: 'list_apis', args: {} },
  });
}

/** Exception dans un outil : erreur `internal` sans le message interne (base, réseau…), journalisée côté serveur. */
function internalError(caller: McpCaller, tool: string, error: unknown): CallToolResult {
  caller.request.log.error({ err: error, tool }, 'mcp : erreur interne d’un outil');
  return toolError('internal', 'erreur interne de l’instance');
}

/** Succès : faits structurés, et les mêmes en texte (phrase puis JSON). */
function success(summary: string, structured: Json): CallToolResult {
  return { content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(structured)}` }], structuredContent: structured };
}

// ---------------------------------------------------------------------------------------------------------------
// Appels REST internes (même clé, même garde, canal `mcp`)
// ---------------------------------------------------------------------------------------------------------------

type RestAnswer = { status: number; body: Json };

async function rest(ctx: ServerContext, caller: McpCaller, method: 'GET' | 'POST', url: string, payload?: Json): Promise<RestAnswer> {
  const { request, app } = caller;
  const userAgent = request.headers['user-agent'];
  const res = await app.inject({
    method,
    url,
    remoteAddress: request.ip,
    headers: {
      authorization: request.headers.authorization ?? '',
      [MCP_CHANNEL_HEADER]: ctx.mcp!.channelToken,
      ...(typeof userAgent === 'string' ? { 'user-agent': userAgent } : {}),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
  let body: Json;
  try {
    body = res.body === '' ? {} : (JSON.parse(res.body) as Json);
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

/** Réponse d'erreur REST → erreur d'outil ; `nextAction` selon le code. */
function restError(answer: RestAnswer, nextAction: (code: string) => Json | null = () => null): CallToolResult {
  const error = (answer.body['error'] ?? {}) as { code?: unknown; message?: unknown; what_to_do?: unknown; retryable?: unknown };
  const code = typeof error.code === 'string' ? error.code : answer.status === 404 ? 'not_found' : 'internal';
  if (code === 'not_found') return notFoundError();
  // Marche à suivre écrite par la route elle-même (ex. contact du robot absent ou invalide, UX-04/UX-05) : reprise telle quelle.
  const own = typeof error.what_to_do === 'string' && typeof error.retryable === 'boolean' ? { what_to_do: error.what_to_do, retryable: error.retryable } : undefined;
  return toolError(code, typeof error.message === 'string' ? error.message : 'erreur', nextAction(code), own);
}

const query = (params: Record<string, string | number | undefined>): string => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string | number][];
  return entries.length === 0 ? '' : `?${new URLSearchParams(entries.map(([k, v]): [string, string] => [k, String(v)])).toString()}`;
};

// ---------------------------------------------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------------------------------------------

/** RunResult d'un run de l'acteur (lecture sous RLS) ; null si inexistant ou d'autrui. */
async function runResultOf(ctx: ServerContext, actor: Actor, runId: string): Promise<Json | null> {
  if (!UUID.test(runId)) return null;
  const row = await withActor(ctx.pool, actor, (db) => readRunRow(db, runId));
  return row === null ? null : ((await buildRunResult(ctx, actor, row)) as unknown as Json);
}

function runResultAnswer(envelope: Json): CallToolResult {
  return success(String(envelope['message'] ?? ''), envelope);
}

/** Réponse REST d'une exécution (200 RunResult, 202 run à suivre) → RunResult. */
async function executionAnswer(ctx: ServerContext, caller: McpCaller, answer: RestAnswer, nextAction?: (code: string) => Json | null): Promise<CallToolResult> {
  if (answer.status === 200 && typeof answer.body['run_id'] === 'string' && Array.isArray(answer.body['items'])) return runResultAnswer(answer.body);
  if (answer.status === 202 && typeof answer.body['run_id'] === 'string') {
    const envelope = await runResultOf(ctx, caller.actor, answer.body['run_id']);
    if (envelope !== null) return runResultAnswer(envelope);
  }
  return restError(answer, nextAction);
}

/** Erreur de statut d'API → prochaine action (05 § 4.3 : `api_error` → ré-enquête par le propriétaire). */
const runNextAction = (slug: string) => (code: string): Json | null => (code === 'api_error' ? { tool: 'run_api', args: { slug, force_investigate: true } } : null);

/** Contrôle d'un dossier d'enquête (19c § 9.1, § 9.3) : taille puis schéma fermé ; jamais une valeur reçue dans l'erreur. */
function checkBrief(brief: unknown): CallToolResult | null {
  if (Buffer.byteLength(JSON.stringify(brief), 'utf8') > BRIEF_MAX_BYTES) return toolError('brief_too_large', `brief : plus de ${BRIEF_MAX_BYTES} octets (aucune troncature)`);
  const validate = compileSchema(BRIEF_SCHEMA);
  if (!validate(brief)) {
    const first = validate.errors?.[0];
    const extra = first?.keyword === 'additionalProperties' ? `/${String((first.params as { additionalProperty?: unknown }).additionalProperty ?? '')}` : '';
    const field = `brief${(first?.instancePath ?? '') + extra}`.replace(/\//g, '.').replace(/[^a-zA-Z0-9_.]/g, '');
    return toolError('invalid_brief', `champ ${field} refusé (schéma fermé du dossier d'enquête)`);
  }
  // Service du dossier d'enquête (tâche 2.14) pas encore livré (D-83) : un dossier valide n'est ni lu ni conservé. 2.14
  // remplace ce bouchon par l'appel à son service et joue les deux test.todo du bloc create_api de mcp.integration.test.ts.
  return toolError('brief_unavailable', 'dossier d’enquête non pris en charge par cette instance : rien n’a été créé');
}

/**
 * Phrase de `create_api` selon l'état RÉEL de l'enquête (UX-07) : schéma à valider, échec avec sa cause, fin sans schéma, ou en
 * cours. Jamais « running » quand le run est terminé, ni « done » sans dire ce qui s'est passé.
 */
function createdSummary(created: Json): string {
  const slug = String(created['slug']);
  const phase = created['investigation_phase'];
  const runState = created['run_state'];
  const status = typeof created['status'] === 'string' ? created['status'] : null;
  const error = created['error'] as { code?: unknown; message?: unknown } | undefined;
  if (phase === 'awaiting_schema_validation') return `API ${slug} created. Proposed output schema below: show it to the user, then call validate_schema with api_id.`;
  if (runState === 'failed') {
    const cause = typeof error?.code === 'string' ? ` (${error.code}): ${String(error.message ?? '')}` : '; read get_run with run_id for the cause.';
    return `API ${slug} created, but the investigation failed${cause}${status === null ? '' : ` The API is now ${status}.`}`;
  }
  if (typeof runState === 'string' && isTerminalRunState(runState as RunState)) {
    return `API ${slug} created; the investigation ended (${runState})${status === null ? '' : `, the API is now ${status}`}: read get_run with run_id.`;
  }
  return `API ${slug} created; the investigation is running: poll get_run with run_id, then validate the proposed schema.`;
}

type Handler = (args: Json, caller: McpCaller) => Promise<CallToolResult>;

function handlers(ctx: ServerContext): Record<GenericToolName, Handler> {
  const wait = (args: Json) => waitSecondsOf(ctx, typeof args['wait_seconds'] === 'number' ? args['wait_seconds'] : ctx.rest.maxWaitSeconds);
  /** Lecture directe sous RLS : la permission de rôle de la route REST équivalente s'applique aussi. */
  const allowed = (caller: McpCaller, permission: Permission) => can(caller.actor.role, permission);

  const runApi = async (slug: string, input: Json, args: Json, caller: McpCaller): Promise<CallToolResult> => {
    const answer = await rest(ctx, caller, 'POST', `/api/apis/${encodeURIComponent(slug)}/runs${query({ wait: wait(args) })}`, {
      input,
      ...(args['force_investigate'] === true ? { force_investigate: true } : {}),
    });
    return executionAnswer(ctx, caller, answer, runNextAction(slug));
  };

  return {
    async create_api(args, caller) {
      const body: Json = { description: args['description'], url: args['url'] };
      for (const key of ['example_output', 'auto_validate', 'network_policy'] as const) if (args[key] !== undefined) body[key] = args[key];
      const answer = await rest(ctx, caller, 'POST', `/api/apis${query({ wait: wait(args) })}`, body);
      if (answer.status !== 201) return restError(answer);
      if (typeof answer.body['run_id'] === 'string' && Array.isArray(answer.body['items'])) return runResultAnswer(answer.body);
      return success(createdSummary(answer.body), answer.body);
    },

    async validate_schema(args, caller) {
      const apiId = String(args['api_id']);
      if (!UUID.test(apiId)) return notFoundError();
      const answer = await rest(ctx, caller, 'POST', `/api/apis/${apiId}/validate-schema${query({ wait: wait(args) })}`, args['output_schema'] === undefined ? {} : { output_schema: args['output_schema'] });
      return executionAnswer(ctx, caller, answer);
    },

    async run_api(args, caller) {
      const hasSlug = typeof args['slug'] === 'string';
      const hasId = typeof args['api_id'] === 'string';
      if (hasSlug === hasId) return toolError('invalid_input', 'slug ou api_id : exactement un des deux');
      let slug = hasSlug ? String(args['slug']) : null;
      if (slug === null) {
        const id = String(args['api_id']);
        const api = UUID.test(id) ? await withActor(ctx.pool, caller.actor, (db) => readApiById(db, id)) : null;
        if (api === null) return notFoundError();
        slug = api.slug;
      }
      return runApi(slug, args['input'] as Json, args, caller);
    },

    async get_run(args, caller) {
      if (!allowed(caller, 'runs:read')) return toolError('forbidden', 'action non autorisée');
      const runId = String(args['run_id']);
      const envelope = await runResultOf(ctx, caller.actor, runId);
      if (envelope !== null) return runResultAnswer(envelope);
      // assert_no_impersonation (05 § 4.4, INV5) : l'admin et l'owner lisent les métadonnées du run d'autrui (état, coût,
      // nombre d'items), comme GET /api/runs/{id} ; jamais ses items, son entrée ni son dataset. Lecture auditée.
      const metadata = UUID.test(runId) ? await runMetadataForAdmin(ctx, caller.actor, runId) : null;
      if (metadata === null) return notFoundError();
      await audit(ctx, caller.request, { ...caller.actor, channel: 'mcp' }, { action: 'run.metadata_read', targetType: 'run', targetId: metadata.id, outcome: 'success' });
      const status = (await ctx.pool.query<{ status: string }>('SELECT status FROM apis WHERE id = $1', [metadata.api_id])).rows[0]?.status ?? 'erreur';
      return runResultAnswer({
        run_id: metadata.id,
        state: metadata.state,
        status,
        items: [],
        total: metadata.items,
        dataset_id: null,
        truncated: false,
        next_cursor: null,
        degraded_reasons: [],
        message: 'Metadata only: this run belongs to another user, so its items and input are not shown.',
        next_action: null,
        poll_after_seconds: null,
        timeline: [],
        cost: metadata.cost,
        console_url: `${ctx.publicUrl}/runs/${metadata.id}`,
        metadata_only: true,
      });
    },

    async get_items(args, caller) {
      if (!allowed(caller, 'datasets:read')) return toolError('forbidden', 'action non autorisée');
      const byRun = typeof args['run_id'] === 'string';
      if (byRun === (typeof args['dataset_id'] === 'string')) return toolError('invalid_input', 'run_id ou dataset_id : exactement un des deux');
      const id = String(byRun ? args['run_id'] : args['dataset_id']);
      if (!UUID.test(id)) return notFoundError();
      const after = decodeItemsCursor(typeof args['cursor'] === 'string' ? args['cursor'] : undefined);
      if (after === null) return toolError('invalid_cursor', 'curseur illisible');
      const datasetId = await withActor(ctx.pool, caller.actor, async (db) => {
        if (byRun) {
          const run = await readRunRow(db, id);
          return run === null ? null : (run.dataset_id ?? '');
        }
        const { rows } = await db.query<{ id: string }>('SELECT id FROM datasets WHERE id = $1 AND deleted_at IS NULL', [id]);
        return rows[0]?.id ?? null;
      });
      if (datasetId === null) return notFoundError();
      if (datasetId === '') return success('The run has no items yet: poll get_run.', { items: [], next_cursor: null });
      const limit = typeof args['limit'] === 'number' ? args['limit'] : ITEMS_DEFAULT_LIMIT;
      const fields = Array.isArray(args['fields']) ? (args['fields'] as string[]) : undefined;
      const items: Json[] = [];
      let lastSeq = after ?? -1;
      let more = false;
      let chars = 0;
      for await (const { seq, item } of datasetItems(ctx, caller.actor, { datasetId, afterSeq: after ?? -1, limit: limit + 1, ...(fields ? { fields } : {}) })) {
        chars += JSON.stringify(item).length;
        if (items.length >= limit || (chars > ITEMS_MAX_CHARS && items.length > 0)) {
          more = true;
          break;
        }
        items.push(item);
        lastSeq = seq;
      }
      const next = more ? itemsCursor(lastSeq) : null;
      return success(`${items.length} items${next === null ? '; no more items.' : '; call get_items again with next_cursor for the rest.'}`, { items, next_cursor: next });
    },

    async cancel_run(args, caller) {
      const runId = String(args['run_id']);
      if (!UUID.test(runId)) return notFoundError();
      const answer = await rest(ctx, caller, 'POST', `/api/runs/${runId}/cancel`, {});
      if (answer.status !== 200) return restError(answer);
      return success('The run is cancelled; incurred costs remain charged.', answer.body);
    },

    async list_apis(args, caller) {
      const answer = await rest(ctx, caller, 'GET', `/api/apis${query({ status: args['status'] as string | undefined, q: args['q'] as string | undefined, limit: (args['limit'] as number | undefined) ?? 20, cursor: args['cursor'] as string | undefined })}`);
      if (answer.status !== 200) return restError(answer);
      const apis = ((answer.body['apis'] ?? []) as Json[]).map((a) => ({
        slug: a['slug'],
        description: a['description'],
        status: a['status'],
        status_reason: (a['status_reason'] as { code?: string } | null)?.code ?? null,
        stale: a['stale'],
        execution: a['execution'],
        network: a['network'],
        requires: a['requires'],
        avg_cost_usd: a['avg_cost_usd'],
      }));
      const next = answer.body['next_cursor'] ?? null;
      return success(`${apis.length} APIs${next === null ? '.' : '; more with cursor.'}`, { apis, next_cursor: next });
    },

    async get_api(args, caller) {
      const answer = await rest(ctx, caller, 'GET', `/api/apis/${encodeURIComponent(String(args['slug']))}${query({ response_format: args['response_format'] as string | undefined })}`);
      if (answer.status !== 200) return restError(answer);
      return success(`API ${String(answer.body['slug'])}: status ${String(answer.body['status'])}.`, answer.body);
    },

    async report_problem(args, caller) {
      const slug = String(args['slug']);
      const runId = typeof args['run_id'] === 'string' ? args['run_id'] : null;
      const found = await withActor(ctx.pool, caller.actor, async (db) => {
        const api = await readApiBySlug(db, slug);
        if (api === null) return null;
        if (runId !== null) {
          const run = UUID.test(runId) ? await readRunRow(db, runId) : null;
          if (run === null || run.api_id !== api.id) return null;
        }
        return api;
      });
      if (found === null) return notFoundError();
      const bugId = randomUUID();
      // Journal de l'API : audit en ajout seul (acteur, API, run) ; la note passe par le masquage de l'audit (INV8).
      await audit(ctx, caller.request, { ...caller.actor, channel: 'mcp' }, {
        action: 'api.problem_reported',
        targetType: 'api',
        targetId: found.id,
        outcome: 'success',
        meta: { bug_id: bugId, run_id: runId, note: String(args['note']).slice(0, 2000) },
      });
      return success(`Problem ${bugId} recorded for API ${found.slug}.`, { bug_id: bugId });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Fabrique
// ---------------------------------------------------------------------------------------------------------------

/** Validation d'entrée laissée au serveur (erreur `invalid_input` de 05 § 4.3, et non le texte libre du SDK). */
const acceptAll: jsonSchemaValidator = { getValidator: () => (input: unknown) => ({ valid: true, data: input as never, errorMessage: undefined }) };

/**
 * Outils par API (05 § 1.1) de l'acteur, selon le mode d'exposition ; 20 au plus. SES API seulement (08b § 3) : une API
 * partagée par un autre membre n'est jamais un outil `api_<slug>` (ni description ni schéma d'autrui dans la liste, aucune
 * place prise aux outils de l'appelant) ; elle reste joignable par `list_apis` et `run_api`.
 */
async function apiTools(ctx: ServerContext, actor: Actor): Promise<{ name: string; slug: string; inputSchema: Json }[]> {
  const mode = ctx.mcp?.exposure ?? 'generic';
  if (mode === 'generic' || !can(actor.role, 'apis:run')) return [];
  const rows = await withActor(ctx.pool, actor, async (db) =>
    (
      await db.query<{ slug: string; input_schema: Json }>(
        `SELECT slug, input_schema FROM apis WHERE owner_id = app_current_user_id() AND current_strategy_version IS NOT NULL ${mode === 'pinned' ? 'AND mcp_exposed' : ''}
         ORDER BY mcp_exposed DESC, pinned DESC, slug LIMIT $1`,
        [MAX_API_TOOLS * 2],
      )
    ).rows,
  );
  const out: { name: string; slug: string; inputSchema: Json }[] = [];
  const names = new Set<string>();
  for (const row of rows) {
    const name = apiToolName(row.slug);
    const schema = row.input_schema;
    // Schéma d'entrée objet seulement (un outil MCP prend un objet) ; sinon l'API reste joignable par run_api.
    if (name === null || names.has(name) || schema === null || typeof schema !== 'object' || schema['type'] !== 'object') continue;
    names.add(name);
    out.push({ name, slug: row.slug, inputSchema: schema });
    if (out.length === MAX_API_TOOLS) break;
  }
  return out;
}

/** Gestionnaire de requête bas niveau du SDK (accès protégé, lu une fois à la construction du serveur). */
type RawHandler = (request: unknown, context: unknown) => Promise<unknown>;

/**
 * Habille les gestionnaires `tools/list` et `tools/call` du SDK : la liste ne garde que les outils dont la clé a le scope
 * (08b § 3) ; un appel à un outil inconnu (ou retiré depuis la liste du client) reste l'erreur `-32602` du protocole, mais
 * porte en `data` la conduite de 05 § 4.3 au lieu du texte libre du SDK (qui recopie le nom reçu). Tout le reste (validation, défi de scope, projection du résultat) reste au SDK.
 */
function shapeToolHandlers(server: McpServer, scopes: Map<string, string>, granted: ReadonlySet<string>): void {
  const low = server.server as unknown as { _getRequestHandler(method: string): RawHandler | undefined };
  const list = low._getRequestHandler('tools/list');
  const callTool = low._getRequestHandler('tools/call');
  if (list === undefined || callTool === undefined) throw new Error('SDK MCP : gestionnaires tools/list et tools/call absents');
  server.server.removeRequestHandler('tools/list');
  server.server.removeRequestHandler('tools/call');
  server.server.setRequestHandler('tools/list', async (request, context) => {
    const result = (await list(request, context)) as ListToolsResult;
    return { ...result, tools: result.tools.filter((tool) => granted.has(scopes.get(tool.name) ?? '')) };
  });
  server.server.setRequestHandler('tools/call', async (request, context) => {
    if (!scopes.has(request.params.name)) throw unknownToolError();
    return (await callTool(request, context)) as CallToolResult;
  });
}

/** Serveur MCP d'une requête : outils des toolsets demandés, outils par API de l'acteur. */
export async function buildMcpServer(ctx: ServerContext, caller: McpCaller, version: string): Promise<McpServer> {
  const server = new McpServer({ name: 'sym', version }, { instructions: MCP_INSTRUCTIONS, capabilities: { tools: { listChanged: true } } });
  const all = handlers(ctx);
  /** Outils enregistrés et scope exigé par chacun. */
  const scopes = new Map<string, string>();
  /** Corps d'outil gardé : toute exception devient une erreur `internal` au format 05 § 4.3. */
  const guarded = (name: string, body: (input: Json) => Promise<CallToolResult>) => async (args: unknown) => {
    try {
      return await body((args ?? {}) as Json);
    } catch (error) {
      return internalError(caller, name, error);
    }
  };
  for (const tool of GENERIC_TOOLS) {
    if (!caller.toolsets.has(tool.toolset)) continue;
    scopes.set(tool.name, tool.scope);
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema as never, acceptAll),
        ...(tool.outputSchema ? { outputSchema: fromJsonSchema(tool.outputSchema as never) } : {}),
        annotations: tool.annotations,
        scopeChallenge: requireScopes(tool.scope),
      },
      guarded(tool.name, async (input) => {
        // Dossier d'enquête contrôlé AVANT le reste (19c § 9.3) : invalid_brief nomme le champ, brief_too_large sans troncature.
        if (tool.name === 'create_api' && input['brief'] !== undefined) {
          const refused = checkBrief(input['brief']);
          if (refused) return refused;
        }
        const checked = validateOutput(tool.inputSchema, input);
        if (!checked.ok) return toolError('invalid_input', `arguments hors du schéma de ${tool.name} : ${formatIssues(checked.errors).replace(/\n/g, ' ; ')}`);
        return all[tool.name](input, caller);
      }),
    );
  }
  if (caller.toolsets.has('run')) {
    for (const api of await apiTools(ctx, caller.actor)) {
      scopes.set(api.name, 'apis:run');
      server.registerTool(
        api.name,
        {
          description: apiToolDescription(api.slug),
          inputSchema: fromJsonSchema(api.inputSchema as never, acceptAll),
          outputSchema: fromJsonSchema(RUN_RESULT_SCHEMA as never),
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
          scopeChallenge: requireScopes('apis:run'),
        },
        guarded(api.name, async (input) => {
          const answer = await rest(ctx, caller, 'POST', `/api/apis/${encodeURIComponent(api.slug)}/runs${query({ wait: waitSecondsOf(ctx, ctx.rest.maxWaitSeconds) })}`, { input });
          return executionAnswer(ctx, caller, answer, runNextAction(api.slug));
        }),
      );
    }
  }
  shapeToolHandlers(server, scopes, new Set(caller.actor.scopes ?? []));
  return server;
}
