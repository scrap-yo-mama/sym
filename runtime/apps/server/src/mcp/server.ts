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
//
// Expérience MCP (tâche 3.10, 05 § 1.2 et § 1.3) : `instructions`, 4 prompts, récit obligatoire dans `content` et `timeline[]`
// dans `structuredContent` (même source : `investigation_events`), `notifications/progress` facultatif et strictement
// croissant, élicitation de la validation du schéma avec repli sur `validate_schema`. Les textes pour la personne suivent
// sa langue (`?lang=`, puis le compte) ; ceux pour le modèle restent en anglais (21 § 4.3).
import { randomUUID } from 'node:crypto';
import { briefWhatToDo, can, checkBrief as checkBriefInput, formatIssues, isTerminalRunState, validateOutput, type Permission } from '@runtime/core';
import { withActor } from '@runtime/db';
import {
  fromJsonSchema,
  inputRequired,
  inputResponse,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  requireScopes,
  type CallToolResult,
  type InputRequiredResult,
  type jsonSchemaValidator,
  type ListToolsResult,
  type ServerContext as SdkContext,
} from '@modelcontextprotocol/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context.js';
import { readApiById, readApiBySlug } from '../rest/apis.js';
import { datasetItems } from '../rest/export.js';
import { runErrorFor } from '../rest/run-error.js';
import { buildRunResult, decodeItemsCursor, itemsCursor, readRunRow, runMetadataForAdmin, type RunRow } from '../rest/runs.js';
import { investigationProgressOf, type TimelineEntry } from '../rest/timeline.js';
import { waitSecondsOf } from '../rest/shared.js';
import { UUID } from '../routes/account-helpers.js';
import { createdView, waitApiLeavesEnquete } from '../routes/apis.js';
import { audit, MCP_CHANNEL_HEADER, type Actor } from '../routes/guard.js';
import { journeyTexts } from './journey-texts.js';
import { attemptsOf, createdSummary, renderNarrative } from './narrative.js';
import { createProgressSink, progressMessage, type ProgressSink } from './progress.js';
import { blockHead, buildResultBlock, firstRunDue, milestoneText, PROGRESS_HEARTBEAT_MS, questionOf, readFirstRun, readGate, stepOf, type Question, type ResultBlock } from './result-block.js';
import { promptBody, PROMPT_ARG_SCHEMAS } from './prompts.js';
import { actionTemplate, blockedTemplate, elicitationCatalog, parseLang, PROMPT_ARGS, PROMPT_MENU, PROMPT_NAMES, type McpLocale } from './texts.js';
import {
  apiToolDescription,
  apiToolName,
  BRIEF_MAX_BYTES,
  GENERIC_TOOLS,
  MAX_API_TOOLS,
  MCP_INSTRUCTIONS,
  RUN_RESULT_SCHEMA,
  type GenericToolName,
  type Toolset,
} from './tools.js';

/** Appel en cours : la clé (acteur), la requête HTTP d'origine (en-têtes, IP pour l'audit) et l'application. */
export type McpCaller = { actor: Actor; request: FastifyRequest; app: FastifyInstance; toolsets: Set<Toolset>; /** `?lang=` brut (en, fr) : prime sur la langue du compte. */ lang?: string | null };

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
  blocked: {
    what_to_do:
      'Tell the user that the site refused automated access to this API, as written in message. Do not retry it and do not try other ways to reach the site. Offer instead: an official API, an export or a partnership; another source; a request for access to the site publisher.',
    retryable: false,
  },
  api_error: { what_to_do: 'The API has no working strategy: its owner can investigate it again (run_api with force_investigate), or report_problem.', retryable: false },
  action_required: {
    what_to_do: 'Ask the user to act in the console first: connect the site with the browser extension, configure the proxy, or settle the paid access; then call again.',
    retryable: false,
  },
  investigation_in_progress: { what_to_do: 'An investigation is running for this API: follow it with get_api or get_run, then call again when it is done.', retryable: true },
  not_awaiting_validation: { what_to_do: 'This API is not waiting for a schema validation: read its state with get_api.', retryable: false },
  queue_full: { what_to_do: 'The instance queue is full: wait about 30 seconds, then call again.', retryable: true },
  user_queue_full: { what_to_do: 'Too many of your runs are active: wait for them (get_run) or cancel one (cancel_run), then call again.', retryable: true },
  budget_exceeded: { what_to_do: 'The daily USD budget of this account is spent (LLM and proxy costs): do not retry today; tell the user it resets at 00:00 UTC.', retryable: false },
  key_rate_limited: { what_to_do: 'Too many runs started with this key in the last minute: wait one minute, then call again.', retryable: true },
  responsible_use_ack_required: { what_to_do: 'Ask the user to read the Responsible use page in the console and tick that they read it, then call again.', retryable: false },
  run_not_active: { what_to_do: 'This run is already finished: read its result with get_run.', retryable: false },
  forbidden: { what_to_do: 'This key or account is not allowed to do this; ask the API owner or an admin.', retryable: false },
  storage_full: { what_to_do: 'The instance storage is full: tell the user to ask the admin to free or extend it.', retryable: false },
  invalid_brief: { what_to_do: briefWhatToDo('invalid_brief'), retryable: true },
  brief_too_large: { what_to_do: briefWhatToDo('brief_too_large', BRIEF_MAX_BYTES), retryable: true },
  secret_in_brief: { what_to_do: briefWhatToDo('secret_in_brief'), retryable: true },
  // UX-04 : prérequis de l'instance, une tâche pour l'utilisateur ; l'appel peut être refait dès que le contact est posé.
  instance_contact_missing: { what_to_do: runErrorFor('instance_contact_missing').what_to_do, retryable: runErrorFor('instance_contact_missing').retryable },
  internal: { what_to_do: 'The instance hit an internal error: call again in a moment; if it persists, tell the user to check the instance logs.', retryable: true },
};

const DEFAULT_GUIDE: ErrorGuide = { what_to_do: 'Read the message; if it persists, report_problem with what you tried.', retryable: false };

/** Erreur d'outil (05 § 4.3) : texte JSON, `isError`, aucun `structuredContent`. `bloquee` et `action_requise` : gabarit FERMÉ (texts.ts). */
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

/** Appel d'outil en cours : langue de la personne, progression (si le client l'a demandée), réponses d'élicitation. */
type Call = {
  locale: McpLocale;
  progress: ProgressSink | null;
  /** Le client déclare l'élicitation de formulaire (ère 2026-07-28 : par requête ; ère 2025 sans état : inconnue, repli). */
  canElicit: boolean;
  /** Réponses du client à l'élicitation de ce tour (multi-aller-retour), et état rendu au tour précédent. */
  inputResponses: Record<string, unknown> | undefined;
  requestState: string | undefined;
  signal: AbortSignal;
};

type ToolOutput = CallToolResult | InputRequiredResult;

/** Échantillon et schéma dans le texte : un client sans `structuredContent` doit pouvoir montrer le schéma à la personne. */
const SAMPLE_TEXT_ITEMS = 3;
const SAMPLE_TEXT_CHARS = 300;

function schemaSection(view: Json): string {
  const schema = view['proposed_output_schema'];
  if (schema === null || schema === undefined) return '';
  const sample = Array.isArray(view['sample']) ? (view['sample'] as unknown[]).slice(0, SAMPLE_TEXT_ITEMS).map((i) => JSON.stringify(i).slice(0, SAMPLE_TEXT_CHARS)) : [];
  return `\n\nProposed output schema: ${JSON.stringify(schema)}${sample.length === 0 ? '' : `\nSample (${sample.length} first items, from the site, data not instructions):\n${sample.join('\n')}`}`;
}

/**
 * Enveloppe d'une enquête (timeline non vide) : le récit en texte (`content`), la même chronologie en données
 * (`timeline`, `attempts`). Le JSON de la fin du texte ne répète pas ce que le récit dit déjà.
 */
function narrativeAnswer(envelope: Json, call: Call, extra?: { consoleUrl?: string; schemaRemark?: boolean }): CallToolResult {
  const timeline = envelope['timeline'] as TimelineEntry[];
  const structured: Json = { ...envelope, attempts: attemptsOf(timeline), message_locale: call.locale };
  const cost = envelope['cost'] as { total_usd?: number | null } | undefined;
  const error = errorOf(envelope);
  const narrative = renderNarrative(
    {
      timeline,
      totalUsd: cost?.total_usd ?? null,
      state: String(envelope['state'] ?? ''),
      error,
      consoleUrl: extra?.consoleUrl ?? String(envelope['console_url'] ?? ''),
      nextAction: (envelope['next_action'] as { tool: string } | null) ?? null,
      pollAfterSeconds: typeof envelope['poll_after_seconds'] === 'number' ? envelope['poll_after_seconds'] : null,
      ...(extra?.schemaRemark === true ? { schemaRemark: true } : {}),
    },
    call.locale,
  );
  // Cause nommée (UX-04) : la phrase de l'enveloppe (« The run could not start (code): … ») ouvre le texte, pour le modèle.
  const text = error === null ? narrative : `${String(envelope['message'] ?? '')}\n\n${narrative}`;
  const { timeline: _t, attempts: _a, ...rest } = structured;
  // Le run_id et la prochaine action restent dans le texte même sans items : le client qui n'affiche que `content` suit le run.
  const itemsPart = Array.isArray(rest['items']) && (rest['items'] as unknown[]).length > 0
    ? `\n\n${JSON.stringify({ items: rest['items'], total: rest['total'], next_cursor: rest['next_cursor'], run_id: rest['run_id'], status: rest['status'], degraded_reasons: rest['degraded_reasons'] })}`
    : `\n\n${JSON.stringify({ run_id: rest['run_id'], status: rest['status'], next_action: rest['next_action'] ?? null, ...(error === null ? {} : { error }) })}`;
  return { content: [{ type: 'text', text: `${text}${itemsPart}` }], structuredContent: structured };
}

/** Cause nommée d'un run (`error` de l'enveloppe ou de `ApiCreated`, UX-04 : `{ code, message, what_to_do, retryable }`), ou null. */
function errorOf(body: Json): Json | null {
  const error = body['error'];
  return typeof error === 'object' && error !== null && typeof (error as Json)['code'] === 'string' ? (error as Json) : null;
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

/** Lignes du récit du dossier (19c § 7) produites par le code : gabarits fermés, jamais un texte du dossier. */
const narrativeLines = (v: unknown): string[] => (Array.isArray(v) ? v.filter((l): l is string => typeof l === 'string') : []);
/** RunResult d'un run de l'acteur (lecture sous RLS) ; null si inexistant ou d'autrui. */
async function runResultOf(ctx: ServerContext, actor: Actor, runId: string): Promise<Json | null> {
  if (!UUID.test(runId)) return null;
  const row = await withActor(ctx.pool, actor, (db) => readRunRow(db, runId));
  return row === null ? null : ((await buildRunResult(ctx, actor, row)) as unknown as Json);
}

/** Enveloppe RunResult : le récit pour une enquête (timeline non vide), sinon la phrase puis le JSON. */
function runResultAnswer(envelope: Json, call: Call): CallToolResult {
  if (Array.isArray(envelope['timeline']) && envelope['timeline'].length > 0) return narrativeAnswer(envelope, call);
  return success(String(envelope['message'] ?? ''), envelope);
}

/**
 * Erreur `blocked` ou `action_required` d'une API : message = gabarit FERMÉ de sa raison (06 « Panneau Bloquée », « Action
 * requise »), dans la langue de la personne ; jamais le texte de la réponse REST, jamais un texte du site.
 */
async function closedStatusError(ctx: ServerContext, caller: McpCaller, call: Call, answer: RestAnswer, slug: string, nextAction?: (code: string) => Json | null): Promise<CallToolResult | null> {
  const code = ((answer.body['error'] ?? {}) as { code?: unknown }).code;
  if (code !== 'blocked' && code !== 'action_required') return null;
  const reason = (await withActor(ctx.pool, caller.actor, (db) => readApiBySlug(db, slug)))?.status_reason ?? null;
  return toolError(code, code === 'blocked' ? blockedTemplate(call.locale, reason) : actionTemplate(call.locale, reason), nextAction?.(code) ?? null);
}

/** Réponse REST d'une exécution (200 RunResult, 202 run à suivre) → RunResult. `slug` : API visée (gabarits fermés des statuts). */
async function executionAnswer(ctx: ServerContext, caller: McpCaller, call: Call, answer: RestAnswer, nextAction?: (code: string) => Json | null, slug?: string): Promise<CallToolResult> {
  if (answer.status === 200 && typeof answer.body['run_id'] === 'string' && Array.isArray(answer.body['items'])) return runResultAnswer(answer.body, call);
  if (answer.status === 202 && typeof answer.body['run_id'] === 'string') {
    const envelope = await runResultOf(ctx, caller.actor, answer.body['run_id']);
    if (envelope !== null) return runResultAnswer(envelope, call);
  }
  if (slug !== undefined) {
    const closed = await closedStatusError(ctx, caller, call, answer, slug, nextAction);
    if (closed !== null) return closed;
  }
  return restError(answer, nextAction);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ACTIVE_RUN = new Set<string>(['queued', 'running', 'waiting_tunnel']);

/** Fenêtre après la fin d'une enquête pendant laquelle SYM lance son premier run complet (le client suit l'enquête dans ce délai). */
const FIRST_RUN_WINDOW_MS = 15 * 60_000;

/** Premiers runs en cours de création, par API : un seul lancement même si deux appels se croisent (instance unique, 03 § 2). */
const firstRunLaunches = new Map<string, Promise<void>>();

/**
 * Premier run complet d'une enquête réussie (03 § 2 : « les éléments sont dans le dataset du run », toutes les pages) : l'enquête
 * a validé la stratégie sur un échantillon de pages ; SYM lance lui-même le run ordinaire qui lit tout, avec la même clé (mêmes
 * gardes, mêmes plafonds, canal `mcp`). Idempotent : un run ordinaire déjà lancé après l'enquête est repris, jamais doublé.
 * Rend ce run, ou null (enquête non réussie, API d'autrui, entrée à renseigner, lancement refusé : le résultat de l'enquête reste).
 */
async function ensureFirstRun(ctx: ServerContext, caller: McpCaller, inv: RunRow): Promise<RunRow | null> {
  if (inv.kind !== 'investigation' || inv.state !== 'succeeded' || inv.finished_at === null) return null;
  const api = await withActor(ctx.pool, caller.actor, (db) => readApiById(db, inv.api_id));
  if (api === null || api.owner_id !== caller.actor.userId) return null;
  const existing = await readFirstRun(ctx, caller.actor, api.id, inv.finished_at);
  if (existing !== null) return existing;
  if (!firstRunDue(inv, api)) return null;
  // Seulement dans la foulée de l'enquête : relire plus tard une très ancienne enquête ne lance jamais un run (et sa dépense).
  if (Date.now() - inv.finished_at.getTime() > FIRST_RUN_WINDOW_MS) return null;
  let launch = firstRunLaunches.get(api.id);
  if (launch === undefined) {
    launch = (async () => {
      if ((await readFirstRun(ctx, caller.actor, api.id, inv.finished_at!)) !== null) return;
      await rest(ctx, caller, 'POST', `/api/apis/${encodeURIComponent(api.slug)}/runs${query({ wait: 0 })}`, { input: {} });
    })()
      .catch((error: unknown) => caller.request.log.warn({ err: error }, 'mcp : premier run complet non lancé'))
      .finally(() => firstRunLaunches.delete(api.id));
    firstRunLaunches.set(api.id, launch);
  }
  await launch;
  return readFirstRun(ctx, caller.actor, api.id, inv.finished_at);
}

/**
 * Attend un run jusqu'à son état terminal, une pause ou l'échéance (comme l'attente de l'API REST) ; pour une enquête, chaque
 * relève publie la progression (numéro du dernier événement de `investigation_events`, strictement croissant) si le client
 * l'a demandée, et un battement toutes les `progressHeartbeatMs` sans événement (03 § 5 : un jalon libellé toutes les 5 s au
 * plus, dans la langue de la personne). Une enquête réussie est suivie de son premier run complet (`ensureFirstRun`), attendu
 * dans la même échéance. Rend la dernière lecture du run d'enquête (null si le run a disparu).
 */
async function waitRun(ctx: ServerContext, caller: McpCaller, call: Call, runId: string, seconds: number) {
  const deadline = Date.now() + seconds * 1000;
  const beatMs = ctx.rest.progressHeartbeatMs ?? PROGRESS_HEARTBEAT_MS;
  let lastSeq = 0;
  let beats = 0;
  let sentAt = Date.now();
  for (;;) {
    const row = await withActor(ctx.pool, caller.actor, (db) => readRunRow(db, runId));
    if (row !== null && call.progress !== null && row.kind === 'investigation') {
      const progress = await investigationProgressOf(ctx, caller.actor, runId, row.api_slug ?? '');
      if (progress !== null && progress.seq > lastSeq) {
        lastSeq = progress.seq;
        beats = 0;
        sentAt = Date.now();
        await call.progress(progress.seq, progressMessage(progress.timeline, call.locale));
      } else if (Date.now() - sentAt >= beatMs && (!isTerminalRunState(row.state) || row.state === 'succeeded')) {
        // Battement : rien de nouveau dans le journal, mais SYM travaille ; le jalon courant et la durée mesurée, jamais une durée devinée.
        const phase = (await withActor(ctx.pool, caller.actor, (db) => db.query<{ investigation_phase: string | null }>('SELECT investigation_phase FROM apis WHERE id = $1', [row.api_id]))).rows[0]?.investigation_phase ?? null;
        const { step } = stepOf(row.state === 'succeeded' ? 'testing' : phase);
        beats += 1;
        sentAt = Date.now();
        await call.progress(lastSeq + beats / 1000, journeyTexts(call.locale).heartbeat(step, milestoneText(step, call.locale), Math.max(0, Math.round((Date.now() - row.created_at.getTime()) / 1000))));
      }
    }
    const finished = row === null || isTerminalRunState(row.state) || row.paused_at !== null;
    if (row !== null && row.state === 'succeeded' && row.kind === 'investigation' && !call.signal.aborted) {
      // Premier run complet : lancé ici, puis attendu tant qu'il reste de l'attente.
      const first = await ensureFirstRun(ctx, caller, row);
      if (first !== null && ACTIVE_RUN.has(first.state) && first.paused_at === null && Date.now() < deadline) {
        await sleep(Math.min(ctx.rest.pollMs, Math.max(1, deadline - Date.now())));
        continue;
      }
      return row;
    }
    if (finished || Date.now() >= deadline || call.signal.aborted) return row;
    await sleep(Math.min(ctx.rest.pollMs, Math.max(1, deadline - Date.now())));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Élicitation de la validation du schéma (05 § 1.3) : `create_api` pose une question plate quand le client la déclare,
// sinon la phase reste `awaiting_schema_validation` et `validate_schema` suit. Multi-aller-retour : le tour suivant rejoue
// l'appel avec les réponses ; l'état du tour précédent ne nomme que l'API et son enquête, et chaque lecture est refaite sous
// RLS (propriétaire, phase) : il ne confère aucun droit, une valeur falsifiée n'atteint que les objets de l'appelant.
// Jamais de secret par élicitation : deux champs plats (décision, remarque).
// ---------------------------------------------------------------------------------------------------------------

const STATE = /^v1\.([0-9a-f-]{36})\.([0-9a-f-]{36})$/;
const encodeState = (apiId: string, runId: string) => `v1.${apiId}.${runId}`;
function decodeState(raw: string | undefined): { apiId: string; runId: string } | null {
  const m = raw === undefined ? null : STATE.exec(raw);
  return m !== null && UUID.test(m[1]!) && UUID.test(m[2]!) ? { apiId: m[1]!, runId: m[2]! } : null;
}

/** Le client déclare l'élicitation de formulaire (ère 2026-07-28, par requête) ; client 2025 sans état : inconnu, donc repli. */
function elicitationSupported(server: McpServer): boolean {
  const e = server.server.getClientCapabilities()?.elicitation as { form?: unknown; url?: unknown } | undefined;
  return e !== undefined && (e.form !== undefined || e.url === undefined);
}

/** Question de validation : le schéma en texte, une décision à valeurs stables (`validate`, `modify`), une remarque libre. */
function schemaElicitation(view: Json, locale: McpLocale) {
  const c = elicitationCatalog(locale);
  const text = JSON.stringify(view['proposed_output_schema'], null, 2).slice(0, 6_000);
  return inputRequired.elicit({
    message: c.message(text),
    requestedSchema: {
      type: 'object',
      properties: {
        // Valeurs d'enum en code (stables), libellés dans la langue de la personne (21 § 4.3).
        decision: { type: 'string', title: c.decision, default: 'validate', enum: ['validate', 'modify'], enumNames: [c.validate, c.modify] },
        remark: { type: 'string', title: c.remark, maxLength: 500 },
      },
      required: ['decision'],
    } as never,
  });
}

/** Question unique et fermée d'une porte (03 § 4 et § 9) : une option à valeurs stables (identifiants), une remarque libre. */
function questionElicitation(question: Question, locale: McpLocale) {
  const c = elicitationCatalog(locale);
  return inputRequired.elicit({
    message: question.text,
    requestedSchema: {
      type: 'object',
      properties: {
        choice: { type: 'string', title: c.decision, default: 'continue', enum: question.options.map((o) => o.id), enumNames: question.options.map((o) => o.label) },
        remark: { type: 'string', title: c.remark, maxLength: 500 },
      },
      required: ['choice'],
    } as never,
  });
}

/** Remarque de la personne : texte court, sans caractères de contrôle ; une donnée, jamais une consigne. */
// eslint-disable-next-line no-control-regex
const cleanRemark = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500) : '');

/** Erreur de statut d'API → prochaine action (05 § 4.3 : `api_error` → ré-enquête par le propriétaire). */
const runNextAction = (slug: string) => (code: string): Json | null => (code === 'api_error' ? { tool: 'run_api', args: { slug, force_investigate: true } } : null);

/**
 * Contrôle d'un dossier d'enquête (19c § 9.1, § 9.3), par le service de 2.14 (D-83) : taille, schéma fermé, secrets ;
 * jamais une valeur reçue dans l'erreur, rien n'est créé. Un dossier valide est lu : transmis à la route REST, qui le
 * contrôle à nouveau, le masque et l'enregistre avec l'API.
 */
function checkBrief(ctx: ServerContext, brief: unknown): CallToolResult | null {
  const out = checkBriefInput(brief, { maxBytes: ctx.brief?.maxBytes ?? BRIEF_MAX_BYTES });
  return out.ok ? null : toolError(out.code, out.message);
}

// ---------------------------------------------------------------------------------------------------------------
// Une demande, une enquête (03 § 9, UXI8)
// ---------------------------------------------------------------------------------------------------------------

/** URL comparée sans fragment, avec hôte en minuscules, sans barre finale ni ordre de paramètres. */
function normalizeUrl(raw: string): string {
  const url = URL.parse(raw);
  if (url === null) return raw.trim();
  url.hash = '';
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href;
}

/** Description comparée sans casse ni espaces superflus (l'empreinte de la demande). */
const normalizeText = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

/** Demandes en cours d'enregistrement : deux appels identiques qui se croisent n'en créent qu'une (instance unique). */
const requestChain = new Map<string, Promise<void>>();

/** Prend la file de cette demande ; la fonction rendue la libère. */
async function lockRequest(key: string): Promise<() => void> {
  const previous = requestChain.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  requestChain.set(key, tail);
  await previous;
  return () => {
    release();
    if (requestChain.get(key) === tail) requestChain.delete(key);
  };
}

/**
 * API du propriétaire née de la même demande, dont l'enquête est en cours ou finie depuis moins de 24 h (une enquête annulée par
 * la personne ne compte pas) : son dernier run d'enquête. Lecture sous RLS ET filtrée sur le propriétaire (jamais l'API d'autrui, même en visibilité instance).
 */
async function findExistingRequest(ctx: ServerContext, actor: Actor, url: string, description: string): Promise<{ apiId: string; runId: string } | null> {
  const rows = await withActor(ctx.pool, actor, async (db) =>
    (
      await db.query<{ api_id: string; run_id: string; url: string | null; description: string | null }>(
        `SELECT a.id AS api_id, r.id AS run_id, a.investigation #>> '{request,url}' AS url, a.investigation #>> '{request,description}' AS description
         FROM apis a
         JOIN LATERAL (SELECT id, state, finished_at FROM runs WHERE api_id = a.id AND kind = 'investigation' ORDER BY created_at DESC LIMIT 1) r ON true
         WHERE a.owner_id = $1 AND a.investigation IS NOT NULL AND r.state <> 'cancelled' AND (r.finished_at IS NULL OR r.finished_at > now() - interval '24 hours')
         ORDER BY a.created_at DESC LIMIT 50`,
        [actor.userId],
      )
    ).rows,
  );
  const wantedUrl = normalizeUrl(url);
  const wantedText = normalizeText(description);
  const hit = rows.find((r) => r.url !== null && r.description !== null && normalizeUrl(r.url) === wantedUrl && normalizeText(r.description) === wantedText);
  return hit === undefined ? null : { apiId: hit.api_id, runId: hit.run_id };
}

type Handler = (args: Json, caller: McpCaller, call: Call) => Promise<ToolOutput>;

function handlers(ctx: ServerContext): Record<GenericToolName, Handler> {
  const wait = (args: Json) => waitSecondsOf(ctx, typeof args['wait_seconds'] === 'number' ? args['wait_seconds'] : ctx.rest.maxWaitSeconds);
  /** Lecture directe sous RLS : la permission de rôle de la route REST équivalente s'applique aussi. */
  const allowed = (caller: McpCaller, permission: Permission) => can(caller.actor.role, permission);

  /** Suite d'un parcours selon l'état du bloc (spec 03 § 2 et § 8) : toujours un outil SYM, jamais un appel au site. */
  const nextActionOf = (block: ResultBlock, apiStatus: string): Json | null => {
    const runId = String(block.fields['run_id']);
    switch (block.state) {
      case 'running':
        return { tool: 'get_run', args: { run_id: runId, wait_seconds: ctx.rest.maxWaitSeconds } };
      case 'awaiting_decision':
        return { tool: 'validate_schema', args: { api_id: block.fields['api_id'] } };
      case 'succeeded':
        return block.items?.cursor !== undefined && block.items.cursor !== null && block.datasetId !== null ? { tool: 'get_items', args: { dataset_id: block.datasetId, cursor: block.items.cursor } } : null;
      case 'failed':
        // Après un échec : la suite proposée par SYM (ré-enquête par le propriétaire), jamais un nouveau create_api (UXI8).
        return apiStatus === 'erreur' ? { tool: 'run_api', args: { slug: block.fields['slug'], force_investigate: true } } : null;
      default:
        return null;
    }
  };

  /** Schéma proposé et question d'une API dont l'enquête attend une décision ; null sinon (ou API d'autrui). */
  const awaitingExtras = async (apiId: string, caller: McpCaller, call: Call): Promise<Json | null> => {
    if (!UUID.test(apiId)) return null;
    const api = await withActor(ctx.pool, caller.actor, (db) => readApiById(db, apiId));
    if (api === null || api.owner_id !== caller.actor.userId || api.investigation_phase !== 'awaiting_schema_validation') return null;
    const run = await withActor(ctx.pool, caller.actor, async (db) => (await db.query<{ id: string }>("SELECT id FROM runs WHERE api_id = $1 AND kind = 'investigation' ORDER BY created_at DESC LIMIT 1", [apiId])).rows[0]);
    if (run === undefined) return null;
    const view = (await createdView(ctx, caller.actor, apiId, run.id)) as unknown as Json;
    const proposed = view['proposed_output_schema'];
    if (proposed === null || proposed === undefined) return null;
    const properties = (proposed as { properties?: Json }).properties;
    const info = await readGate(ctx, caller.actor, apiId);
    const question = questionOf(info.gate, call.locale);
    return {
      proposed_output_schema: proposed,
      sample: view['sample'] ?? [],
      fields_found: info.columns ?? (properties === undefined ? [] : Object.keys(properties)),
      ...(question === null ? {} : { question }),
      next_action: { tool: 'validate_schema', args: { api_id: apiId } },
    };
  };

  type AnswerOptions = { existing?: boolean; note?: string; schemaRemark?: boolean; userRemark?: string; created?: boolean; briefLines?: readonly string[]; nextAction?: Json | null };

  /**
   * Réponse d'un run d'ENQUÊTE (create_api, get_run, validate_schema, ré-enquête) : le bloc de résultat de 03 § 10.2 dans
   * `structuredContent`, et en texte le succès chiffré avec son aperçu (ou la question unique), le récit, les identifiants.
   * Le premier run complet qui suit une enquête réussie est lancé ici s'il ne l'est pas encore (`ensureFirstRun`).
   */
  const investigationAnswer = async (runId: string, caller: McpCaller, call: Call, opts: AnswerOptions = {}): Promise<ToolOutput> => {
    const row = await withActor(ctx.pool, caller.actor, (db) => readRunRow(db, runId));
    if (row === null) return notFoundError();
    const first = await ensureFirstRun(ctx, caller, row);
    const block = await buildResultBlock({ ctx, actor: caller.actor, locale: call.locale, runId, existing: opts.existing === true, firstRun: first });
    const base = await runResultOf(ctx, caller.actor, runId);
    if (base === null) return notFoundError();
    if (block === null) return runResultAnswer(base, call);
    const apiId = String(block.fields['api_id']);
    const awaiting = block.state === 'awaiting_decision';
    const view = awaiting || opts.created === true ? ((await createdView(ctx, caller.actor, apiId, runId)) as unknown as Json) : null;
    const { brief_narrative: briefNarrative, ...viewData } = view ?? {};
    const status = String(base['status'] ?? '');
    const object = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});
    const proposed = awaiting && view !== null ? (view['proposed_output_schema'] ?? null) : null;
    const envelope: Json = {
      ...base,
      // `state` est celui du parcours (03 § 10.2) ; l'état brut du run d'enquête reste lisible dans `run_state`.
      run_state: base['state'],
      ...block.fields,
      progress: { ...object(base['progress']), ...object(block.fields['progress']) },
      cost: { ...object(base['cost']), ...object(block.fields['cost']) },
      ...(block.items === null ? {} : { items: block.items.preview, total: block.items.total, next_cursor: block.items.cursor, truncated: block.items.cursor !== null, dataset_id: block.datasetId }),
      next_action: opts.nextAction !== undefined ? opts.nextAction : nextActionOf(block, status),
      ...(proposed === null ? {} : { proposed_output_schema: proposed, sample: view!['sample'] ?? [], fields_found: block.proposedColumns ?? Object.keys(object(object(proposed)['properties'])) }),
    };
    const timeline = envelope['timeline'] as TimelineEntry[];
    const consoleUrl = String(envelope['console_url']);
    const cost = envelope['cost'] as { total_usd?: number | null };
    const error = errorOf(view ?? {}) ?? errorOf(envelope);
    const structured: Json = {
      ...(view === null ? {} : viewData),
      ...envelope,
      attempts: attemptsOf(timeline),
      message_locale: call.locale,
      ...(opts.userRemark === undefined ? {} : { user_remark: opts.userRemark }),
    };
    const nextAction = envelope['next_action'] as { tool: string } | null;
    const narrative = renderNarrative(
      {
        timeline,
        totalUsd: cost?.total_usd ?? null,
        state: block.state,
        error,
        consoleUrl,
        nextAction,
        pollAfterSeconds: typeof envelope['poll_after_seconds'] === 'number' ? envelope['poll_after_seconds'] : null,
        ...(opts.schemaRemark === true ? { schemaRemark: true } : {}),
      },
      call.locale,
    );
    const ids = JSON.stringify({ api_id: apiId, run_id: runId, slug: block.fields['slug'], next_action: nextAction, ...(error === null ? {} : { error }) });
    const idsForItems = block.items?.cursor !== undefined && block.items.cursor !== null && block.datasetId !== null ? `dataset_id ${block.datasetId}, cursor ${block.items.cursor}` : null;
    const t = journeyTexts(call.locale);
    // Aide pour le modèle (anglais) : l'état réel d'abord (UX-07), la cause nommée quand l'enquête a échoué (UX-04).
    const lead =
      block.state === 'succeeded' || (block.state === 'awaiting_decision' && block.question !== null)
        ? ''
        : block.state === 'running' && opts.created === true
          ? `API ${String(block.fields['slug'])} created; the investigation is running: call get_run with run_id and wait_seconds until state is succeeded.`
          : opts.created === true && view !== null
            ? createdSummary(view)
            : error === null
              ? ''
              : String(base['message'] ?? '');
    const briefLines = opts.briefLines ?? narrativeLines(briefNarrative);
    const parts = [
      opts.note,
      opts.existing === true ? t.existing : undefined,
      briefLines.length === 0 ? undefined : briefLines.join('\n'),
      blockHead(block, call.locale, { nextItemsIds: idsForItems }) || undefined,
      lead === '' ? undefined : lead,
      narrative,
      ids,
      proposed === null ? undefined : schemaSection(view!).trimStart(),
    ].filter((p): p is string => p !== undefined && p !== '');
    return { content: [{ type: 'text', text: parts.join('\n\n') }], structuredContent: structured };
  };

  /** Valide le schéma proposé (sans correction ou corrigé), attend les essais et rend le bloc de résultat. */
  const validateFlow = async (apiId: string, body: Json, args: Json, caller: McpCaller, call: Call): Promise<ToolOutput> => {
    const answer = await rest(ctx, caller, 'POST', `/api/apis/${apiId}/validate-schema${query({ wait: 0 })}`, body);
    const runId = answer.body['run_id'];
    if ((answer.status === 202 || answer.status === 200) && typeof runId === 'string') {
      await waitRun(ctx, caller, call, runId, wait(args));
      return investigationAnswer(runId, caller, call);
    }
    return restError(answer);
  };

  /**
   * Réponse à la question unique (03 § 4 et § 9) : « continuer » valide le schéma proposé et lance les essais ; les autres
   * options ne lancent rien ici : « ne rien lancer » s'arrête, les autres repartent d'une nouvelle demande précisée
   * (`next_action: create_api` avec `force_new`), puisque l'ancienne reste dans le catalogue.
   */
  const choose = async (apiId: string, choice: string | undefined, remark: string, args: Json, caller: McpCaller, call: Call): Promise<ToolOutput> => {
    const info = await readGate(ctx, caller.actor, apiId);
    const question = questionOf(info.gate, call.locale);
    const valid = question === null ? ['continue'] : question.options.map((o) => o.id);
    const t = journeyTexts(call.locale);
    if (choice === undefined || choice === 'continue') return validateFlow(apiId, {}, args, caller, call);
    if (!valid.includes(choice)) return toolError('invalid_input', t.choice.unknown(valid.join(', ')));
    // Dernier run d'enquête de l'API : le bloc de résultat (la question reste lisible) accompagne la réponse.
    const latest = await withActor(ctx.pool, caller.actor, async (db) => (await db.query<{ id: string }>("SELECT id FROM runs WHERE api_id = $1 AND kind = 'investigation' ORDER BY created_at DESC LIMIT 1", [apiId])).rows[0]);
    if (latest === undefined) return notFoundError();
    if (choice === 'cancel') return investigationAnswer(latest.id, caller, call, { note: t.choice.declined, created: true, nextAction: null });
    const hint = choice === 'other_list' ? (call.locale === 'fr' ? 'prends l’autre liste de la page' : 'take the other list of the page') : choice === 'look_details' ? (call.locale === 'fr' ? 'regarde aussi les pages de détail' : 'also look at the detail pages') : remark === '' ? (call.locale === 'fr' ? 'selon ma remarque' : 'as I remarked') : remark;
    const description = `${info.description} (${hint})`.slice(0, 2000);
    const next = info.url === null ? null : { tool: 'create_api', args: { description, url: info.url, force_new: true } };
    return investigationAnswer(latest.id, caller, call, { note: t.choice.rerun(hint), created: true, nextAction: next });
  };

  /** Tour suivant d'une élicitation : valider (essais lancés), modifier (rien lancé), refuser ou annuler (rien lancé). */
  const resumeSchemaDecision = async (state: { apiId: string; runId: string }, args: Json, caller: McpCaller, call: Call): Promise<ToolOutput> => {
    const api = await withActor(ctx.pool, caller.actor, (db) => readApiById(db, state.apiId));
    if (api === null || api.owner_id !== caller.actor.userId) return notFoundError();
    if (api.investigation_phase !== 'awaiting_schema_validation') return toolError('not_awaiting_validation', 'cette API n’attend pas de validation de schéma');
    const answer = inputResponse(call.inputResponses, 'validate_schema');
    const c = elicitationCatalog(call.locale);
    const accepted = answer.kind === 'elicit' && answer.action === 'accept';
    // Question unique d'une porte (ambiguïté, coût) : la réponse porte l'identifiant de l'option choisie.
    const picked = accepted ? answer.content?.['choice'] : undefined;
    if (typeof picked === 'string') return choose(state.apiId, picked, cleanRemark(answer.kind === 'elicit' ? answer.content?.['remark'] : undefined), args, caller, call);
    const decision = accepted ? answer.content?.['decision'] : undefined;
    if (decision === 'validate') return validateFlow(state.apiId, {}, args, caller, call);
    if (decision === 'modify') {
      const remark = cleanRemark(answer.kind === 'elicit' ? answer.content?.['remark'] : undefined);
      return investigationAnswer(state.runId, caller, call, { note: c.modifyAsked(remark), schemaRemark: true, userRemark: remark, created: true });
    }
    return investigationAnswer(state.runId, caller, call, { note: c.declined, created: true });
  };

  const runApi = async (slug: string, input: Json, args: Json, caller: McpCaller, call: Call): Promise<ToolOutput> => {
    // Ré-enquête demandée : le run est une enquête, suivie avec sa progression (le récit des essais, comme create_api).
    if (args['force_investigate'] === true) {
      const answer = await rest(ctx, caller, 'POST', `/api/apis/${encodeURIComponent(slug)}/runs${query({ wait: 0 })}`, { input, force_investigate: true });
      const runId = answer.body['run_id'];
      if ((answer.status === 202 || answer.status === 200) && typeof runId === 'string') {
        await waitRun(ctx, caller, call, runId, wait(args));
        return investigationAnswer(runId, caller, call);
      }
      return executionAnswer(ctx, caller, call, answer, runNextAction(slug), slug);
    }
    return runAndWait(slug, { input }, wait(args), caller, call);
  };

  /**
   * Lance un run ordinaire et l'attend jusqu'à `seconds` (jusqu'à 50, plus que le `wait` de la route REST, 25 au plus) : la
   * route répond sans attendre, l'attente est ici (progression et annulation du client comprises).
   */
  const runAndWait = async (slug: string, payload: Json, seconds: number, caller: McpCaller, call: Call): Promise<ToolOutput> => {
    const answer = await rest(ctx, caller, 'POST', `/api/apis/${encodeURIComponent(slug)}/runs${query({ wait: 0 })}`, payload);
    const runId = answer.body['run_id'];
    if ((answer.status === 202 || answer.status === 200) && typeof runId === 'string') {
      if (seconds > 0) await waitRun(ctx, caller, call, runId, seconds);
      const envelope = await runResultOf(ctx, caller.actor, runId);
      if (envelope !== null) return runResultAnswer(envelope, call);
    }
    return executionAnswer(ctx, caller, call, answer, runNextAction(slug), slug);
  };

  return {
    async create_api(args, caller, call) {
      // Tour suivant d'une élicitation : l'API existe déjà, on ne la recrée pas.
      const resumed = decodeState(call.requestState);
      if (resumed !== null) return resumeSchemaDecision(resumed, args, caller, call);
      const description = String(args['description']);
      const url = String(args['url']);
      // Une demande, une enquête (03 § 9, UXI8) : la même demande (propriétaire, URL normalisée, description) pendant une enquête ou
      // dans les 24 h après sa fin rend l'API existante et son run, sans nouvelle dépense. `force_new` crée une nouvelle API.
      const release = await lockRequest(`${caller.actor.userId}|${normalizeUrl(url)}|${normalizeText(description)}`);
      let target: { apiId: string; runId: string; existing: boolean };
      try {
        const found = args['force_new'] === true ? null : await findExistingRequest(ctx, caller.actor, url, description);
        if (found !== null) target = { ...found, existing: true };
        else {
          const body: Json = { description, url };
          for (const key of ['example_output', 'auto_validate', 'network_policy', 'brief', 'name'] as const) if (args[key] !== undefined) body[key] = args[key];
          // Création sans attente : l'attente (et la progression) sont ici, pour que le client voie l'enquête avancer.
          const answer = await rest(ctx, caller, 'POST', `/api/apis${query({ wait: 0 })}`, body);
          if (answer.status !== 201) return restError(answer);
          target = { apiId: String(answer.body['api_id']), runId: String(answer.body['run_id']), existing: false };
        }
      } finally {
        release();
      }
      const row = await waitRun(ctx, caller, call, target.runId, wait(args));
      // UX-07 : le worker clôt le run PUIS applique le statut (transaction suivante) : on attend (borné) qu'il en découle.
      if (row?.state === 'failed') await waitApiLeavesEnquete(ctx, caller.actor, target.apiId, Date.now() + 2_000, call.signal);
      // Décision due (ambiguïté réelle, coût au-delà du seuil, ou `auto_validate: false`) : élicitation si le client la déclare.
      const api = await withActor(ctx.pool, caller.actor, (db) => readApiById(db, target.apiId));
      if (api?.investigation_phase === 'awaiting_schema_validation' && row?.state === 'succeeded' && call.canElicit) {
        const view = (await createdView(ctx, caller.actor, target.apiId, target.runId)) as unknown as Json;
        if (view['proposed_output_schema'] !== null && view['proposed_output_schema'] !== undefined) {
          const question = questionOf((await readGate(ctx, caller.actor, target.apiId)).gate, call.locale);
          return inputRequired({
            inputRequests: { validate_schema: question === null ? schemaElicitation(view, call.locale) : questionElicitation(question, call.locale) },
            requestState: encodeState(target.apiId, target.runId),
          });
        }
      }
      return investigationAnswer(target.runId, caller, call, { existing: target.existing, created: true });
    },

    async validate_schema(args, caller, call) {
      const apiId = String(args['api_id']);
      if (!UUID.test(apiId)) return notFoundError();
      // Schéma corrigé : la personne a tranché, les essais partent. Sinon `choice` répond à la question unique (« continue » par défaut).
      if (args['output_schema'] !== undefined) return validateFlow(apiId, { output_schema: args['output_schema'] }, args, caller, call);
      return choose(apiId, typeof args['choice'] === 'string' ? args['choice'] : undefined, '', args, caller, call);
    },

    async run_api(args, caller, call) {
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
      return runApi(slug, args['input'] as Json, args, caller, call);
    },

    async get_run(args, caller, call) {
      if (!allowed(caller, 'runs:read')) return toolError('forbidden', 'action non autorisée');
      const runId = String(args['run_id']);
      // `wait_seconds` tenu (UX-14, 03 § 3) : retour avant l'échéance seulement si le run finit, ou attend une décision.
      const seconds = typeof args['wait_seconds'] === 'number' ? waitSecondsOf(ctx, args['wait_seconds']) : 0;
      const known = UUID.test(runId) ? await withActor(ctx.pool, caller.actor, (db) => readRunRow(db, runId)) : null;
      if (known !== null && seconds > 0) await waitRun(ctx, caller, call, runId, seconds);
      if (known !== null && known.kind === 'investigation') return investigationAnswer(runId, caller, call);
      const envelope = await runResultOf(ctx, caller.actor, runId);
      if (envelope !== null) return runResultAnswer(envelope, call);
      // assert_no_impersonation (05 § 4.4, INV5) : l'admin et l'owner lisent les métadonnées du run d'autrui (état, coût,
      // nombre d'items), comme GET /api/runs/{id} ; jamais ses items, son entrée ni son dataset. Lecture auditée.
      const metadata = UUID.test(runId) ? await runMetadataForAdmin(ctx, caller.actor, runId) : null;
      if (metadata === null) return notFoundError();
      await audit(ctx, caller.request, { ...caller.actor, channel: 'mcp' }, { action: 'run.metadata_read', targetType: 'run', targetId: metadata.id, outcome: 'success' });
      const status = (await ctx.pool.query<{ status: string }>('SELECT status FROM apis WHERE id = $1', [metadata.api_id])).rows[0]?.status ?? 'erreur';
      return runResultAnswer(
        {
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
        },
        call,
      );
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

    async get_api(args, caller, call) {
      const answer = await rest(ctx, caller, 'GET', `/api/apis/${encodeURIComponent(String(args['slug']))}${query({ response_format: args['response_format'] as string | undefined })}`);
      if (answer.status !== 200) return restError(answer);
      // Enquête en attente d'une décision (UX-18, UX-36) : le schéma proposé, l'échantillon, les champs trouvés et la question
      // unique, comme `get_run` (03 § 3). Propriétaire seulement (la porte et la proposition sont à lui).
      const awaiting = await awaitingExtras(String(answer.body['id'] ?? ''), caller, call);
      return success(`API ${String(answer.body['slug'])}: status ${String(answer.body['status'])}.${awaiting === null ? '' : ' A schema is waiting for a decision: see proposed_output_schema and question.'}`, awaiting === null ? answer.body : { ...answer.body, ...awaiting });
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

/** Langue de la personne : `?lang=`, puis le compte propriétaire de la clé, puis `en` (21 § 4.3). */
async function localeOf(ctx: ServerContext, caller: McpCaller): Promise<McpLocale> {
  const asked = parseLang(caller.lang);
  if (asked !== null) return asked;
  const { rows } = await ctx.pool.query<{ locale: string }>('SELECT locale FROM users WHERE id = $1', [caller.actor.userId]);
  return parseLang(rows[0]?.locale) ?? 'en';
}

/** Prompts (05 § 1.3) : noms stables, titres et descriptions de menu dans la langue de la personne, corps en anglais. */
function registerPrompts(server: McpServer, locale: McpLocale): void {
  for (const name of PROMPT_NAMES) {
    const menu = PROMPT_MENU[locale][name];
    const schema = PROMPT_ARG_SCHEMAS[name];
    const config = { title: menu.title, description: menu.description };
    const text = (args: Json) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: promptBody(name, args, locale) } }] });
    if (schema === null) {
      server.registerPrompt(name, config, () => text({}));
      continue;
    }
    const properties = Object.fromEntries(Object.entries(schema['properties'] as Record<string, Json>).map(([key, value]) => [key, { ...value, description: PROMPT_ARGS[locale][key] ?? '' }]));
    server.registerPrompt(name, { ...config, argsSchema: fromJsonSchema({ ...schema, properties } as never, acceptAll) }, (args: unknown) => text((args ?? {}) as Json));
  }
}

/** Serveur MCP d'une requête : outils des toolsets demandés, outils par API de l'acteur, prompts. */
export async function buildMcpServer(ctx: ServerContext, caller: McpCaller, version: string): Promise<McpServer> {
  const server = new McpServer({ name: 'sym', version }, { instructions: MCP_INSTRUCTIONS, capabilities: { tools: { listChanged: true }, prompts: { listChanged: false } } });
  const locale = await localeOf(ctx, caller);
  const all = handlers(ctx);
  /** Outils enregistrés et scope exigé par chacun. */
  const scopes = new Map<string, string>();
  /** Appel en cours : langue, progression demandée par le client, réponses d'élicitation du tour. */
  const callOf = (sdk: SdkContext): Call => ({
    locale,
    canElicit: elicitationSupported(server),
    progress: createProgressSink(sdk.mcpReq._meta?.progressToken, (notification) => sdk.mcpReq.notify(notification as never)),
    inputResponses: sdk.mcpReq.inputResponses,
    requestState: sdk.mcpReq.requestState<string>(),
    signal: sdk.mcpReq.signal,
  });
  /** Corps d'outil gardé : toute exception devient une erreur `internal` au format 05 § 4.3. */
  const guarded = (name: string, body: (input: Json, call: Call) => Promise<ToolOutput>) => async (args: unknown, sdk: SdkContext) => {
    try {
      return await body((args ?? {}) as Json, callOf(sdk));
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
      guarded(tool.name, async (input, call) => {
        // Dossier d'enquête contrôlé AVANT le reste (19c § 9.3) : invalid_brief nomme le champ, brief_too_large sans troncature.
        if (tool.name === 'create_api' && input['brief'] !== undefined) {
          const refused = checkBrief(ctx, input['brief']);
          if (refused) return refused;
        }
        const checked = validateOutput(tool.inputSchema, input);
        if (!checked.ok) return toolError('invalid_input', `arguments hors du schéma de ${tool.name} : ${formatIssues(checked.errors).replace(/\n/g, ' ; ')}`);
        return all[tool.name](input, caller, call);
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
        guarded(api.name, async (input, call) => {
          return all.run_api({ slug: api.slug, input }, caller, call);
        }),
      );
    }
  }
  registerPrompts(server, locale);
  shapeToolHandlers(server, scopes, new Set(caller.actor.scopes ?? []));
  return server;
}
