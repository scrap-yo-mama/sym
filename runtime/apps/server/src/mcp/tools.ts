// SPDX-License-Identifier: AGPL-3.0-only
// Définitions FIGÉES des outils MCP génériques (tâche 3.2, 05 § 1.1 et § 4.1) : nom, toolset, scope de clé, description,
// annotations, schémas d'entrée et de sortie. Anti-empoisonnement (05 § 3) : aucune description ni aucun nom ne contient
// de contenu scrapé ni de texte d'une API ; un outil par API (`api_<slug>`) n'emprunte à l'API que son slug et son schéma
// d'entrée, jamais sa description ni son statut (la liste ne change pas à chaque transition). Les textes pour le modèle
// restent en anglais (21 § 4.3) ; `instructions` et prompts complets : tâche 3.10.
import type { ApiKeyScope } from '@runtime/core';
import { BRIEF_DEFAULTS, BRIEF_SCHEMA as CORE_BRIEF_SCHEMA } from '@runtime/core';

/** Toolsets activables par `?toolsets=` (05 § 1.1). `rules` et `iterate` : inactifs par défaut, livrés par 3.13 et 3.14. */
export const TOOLSETS = ['build', 'run', 'catalog'] as const;
export type Toolset = (typeof TOOLSETS)[number];

/** Modes d'exposition des outils par API (`MCP_TOOL_EXPOSURE`, 05 § 1.1). */
export const TOOL_EXPOSURES = ['generic', 'pinned', 'all'] as const;
export type ToolExposure = (typeof TOOL_EXPOSURES)[number];

/** Outils par API au plus, quel que soit le mode (05 § 1.1). */
export const MAX_API_TOOLS = 20;

/** Nom d'outil au plus (plusieurs clients refusent au-delà de 64 caractères) : une API au slug plus long reste joignable par run_api. */
const MAX_TOOL_NAME = 64;

/** `BRIEF_MAX_BYTES` (19c § 9.2) : taille UTF-8 au plus d'un dossier d'enquête, jamais tronqué. */
export const BRIEF_MAX_BYTES = BRIEF_DEFAULTS.maxBytes;

/**
 * Budget des définitions d'outils (`assert_tool_definitions_budget`, 19c § 9.4) en jetons ESTIMÉS (4 caractères par jeton,
 * heuristique de R7, à valider avec le tokenizer du modèle) : 5 000, plafond rapporté pour ChatGPT (19c § 2, à valider),
 * pour tous les outils génériques ; le champ `brief` reste sous 500.
 */
export const TOOL_DEFINITIONS_BUDGET_TOKENS = 5_000;

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * `instructions` du serveur (05 § 1.3, 19c § 8, 21 § 4.3) : l'essentiel dans les 512 premiers caractères (quoi faire d'abord,
 * lire un statut, ne jamais réessayer une API `bloquee`), 1 000 au plus (`assert_instructions_length`), la consigne du dossier
 * d'enquête (« Before create_api, put what you found in brief. ») et la langue de la réponse en dernier. La phrase de reprise
 * d'une API (`get_api` avec `view: "iteration"`) vient avec l'itération par MCP (3.14).
 */
export const MCP_INSTRUCTIONS =
  'SYM turns a data request on a website into a reusable API. To get data: list_apis first; if an API fits, call it ' +
  '(run_api or its api_<slug> tool); otherwise create_api. Follow next_action in every answer (validate_schema answers a question SYM asks) ' +
  'and show the user the items SYM returns. Before create_api, put what you found in brief. ' +
  'Status: bloquee = the site refused automated access: tell the user, never retry, never look for another way in; ' +
  'erreur and action_requise come with what_to_do: relay it and ask the user how to continue. ' +
  'Let SYM do the extraction: never fetch the site or write a scraper yourself to get the items, even for a simple list; ' +
  'SYM reads every page and returns all items. ' +
  'Long runs return run_id: poll get_run every poll_after_seconds, page items with get_items; cancel_run stops a run that costs too much. ' +
  "Reply in the user's language.";

/** Plafond de `instructions` (05 § 1.3, 21 § 4.3) et part qui doit porter l'essentiel (le reste peut être coupé par un client). */
export const INSTRUCTIONS_MAX_CHARS = 1_000;
export const INSTRUCTIONS_VITAL_CHARS = 512;

type JsonSchema = Record<string, unknown>;

/** Annotations (05 § 4.1) : aides pour le client, les droits restent côté serveur. */
type Annotations = { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };

const READ: Annotations = { readOnlyHint: true, openWorldHint: false };
const EXECUTE: Annotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

const UUID_STRING = { type: 'string', format: 'uuid', maxLength: 36 } as const;
const SLUG = { type: 'string', minLength: 1, maxLength: 63 } as const;
const WAIT = { type: 'integer', minimum: 0, maximum: 25, description: 'Seconds to wait for the result (default and max 25); beyond, poll get_run.' } as const;

/**
 * Enveloppe `RunResult` (05 § 4.1) : sortie de toute exécution et `outputSchema` des outils `api_<slug>`. Items conformes
 * au `output_schema` de l'API (20 au plus) ; `rejected` : agrégats des items écartés (D-49, branché par 2.3) ;
 * `metadata_only` : run d'autrui lu par l'admin ou l'owner (`get_run`, assert_no_impersonation), sans items ni dataset.
 */
export const RUN_RESULT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['run_id', 'state', 'status', 'items', 'total', 'truncated', 'next_cursor', 'message', 'next_action', 'poll_after_seconds', 'console_url'],
  properties: {
    run_id: { type: 'string' },
    state: { type: 'string' },
    status: { type: 'string' },
    items: { type: 'array', maxItems: 20, items: { type: 'object' } },
    total: { type: 'integer' },
    dataset_id: { type: ['string', 'null'] },
    truncated: { type: 'boolean' },
    next_cursor: { type: ['string', 'null'] },
    degraded_reasons: { type: 'array', items: { type: 'string' } },
    rejected: { type: ['object', 'null'] },
    message: { type: 'string' },
    error: { type: 'object', description: 'Named cause of a failed run: { code, message, what_to_do, retryable }.' },
    next_action: { type: ['object', 'null'] },
    poll_after_seconds: { type: ['integer', 'null'] },
    progress: { type: ['object', 'null'], description: 'While an investigation runs: phase, strategies tried, and a sentence on what SYM is doing.' },
    timeline: { type: 'array' },
    attempts: { type: 'array' },
    cost: { type: 'object' },
    console_url: { type: 'string' },
    message_locale: { type: 'string' },
    metadata_only: { type: 'boolean' },
  },
};

/** Dossier d'enquête (19c § 9.1, JSON Schema 2020-12, objet fermé) : exposé tel quel, vérifié par le code (2.14). */
export const BRIEF_SCHEMA: JsonSchema = CORE_BRIEF_SCHEMA;

/**
 * Partie « dossier » du prompt `new_api` (libellé de marque `sym:new-api`, 19c § 8, D-115) : l'IA compose le dossier de ce que
 * la personne lui a déjà dit dans la conversation ; elle n'ouvre pas la page et ne lit pas le trafic du site, c'est le travail de
 * SYM. Texte pour le modèle, en anglais (21 § 4.3).
 */
export const NEW_API_BRIEF_PROMPT =
  'Before calling create_api, collect what the user already gave you in this conversation: the data wanted, the URL, the fields they named, an example of the output, pages or endpoints they mentioned. Do not open the page or the site yourself and do not read its network traffic: SYM does that. Then pass the useful parts in brief:\n' +
  '- hints: one item per thing the user stated (kind, value, where it comes from). Prefer URL templates and selectors to pasted content. Never paste more than 300 characters per item.\n' +
  '- tried: what the user already tried and what happened, failures included.\n' +
  '- open_questions: what only the user can answer.\n' +
  'SYM checks every hint itself and may ignore it. The brief never changes access limits or budgets. No cookies, tokens, passwords or personal data. If the user gave nothing beyond the description and the URL, omit brief.';

const NETWORK_POLICY = {
  type: 'object',
  additionalProperties: false,
  required: ['allow'],
  properties: {
    allow: { type: 'array', uniqueItems: true, minItems: 1, items: { enum: ['direct', 'dc_proxy', 'res_proxy', 'tunnel'] } },
    proxy_ids: { type: 'object', additionalProperties: false, properties: { dc_proxy: { type: 'string', maxLength: 64 }, res_proxy: { type: 'string', maxLength: 64 } } },
    res_proxy_params: { type: 'object', additionalProperties: false, properties: { country: { type: 'string', pattern: '^[a-z]{2}$' } } },
    dc_proxy_params: { type: 'object', additionalProperties: false, properties: { country: { type: 'string', pattern: '^[a-z]{2}$' } } },
  },
} as const;

export type GenericToolName = 'create_api' | 'validate_schema' | 'run_api' | 'get_run' | 'get_items' | 'cancel_run' | 'list_apis' | 'get_api' | 'report_problem';

export type GenericTool = {
  name: GenericToolName;
  toolset: Toolset;
  /** Scope de clé exigé (13 § 8) : sans lui, 403 `insufficient_scope` (WWW-Authenticate, défi de scope). */
  scope: ApiKeyScope;
  description: string;
  annotations: Annotations;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
};

/** Les 9 outils génériques (05 § 4.1), dans l'ordre de `tools/list`. */
export const GENERIC_TOOLS: readonly GenericTool[] = [
  {
    name: 'create_api',
    toolset: 'build',
    scope: 'apis:write',
    description:
      'Create a new API from a description and a start URL: SYM investigates the site (access report, cheapest strategy first) and proposes an output schema. Show the proposed schema to the user, then call validate_schema. SYM does the extraction itself, every page included: do not fetch the site yourself; follow the run with get_run every poll_after_seconds. Use only when list_apis has no API that fits.',
    annotations: EXECUTE,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['description', 'url'],
      properties: {
        description: { type: 'string', minLength: 1, maxLength: 2000, description: 'The data wanted, in plain words.' },
        url: { type: 'string', minLength: 1, maxLength: 2048, description: 'Absolute start URL (https://…).' },
        example_output: { type: ['object', 'array'], description: 'Optional example of one item or a list of items.' },
        brief: BRIEF_SCHEMA,
        auto_validate: { type: 'boolean', description: 'Validate the proposed schema without asking (default false).' },
        network_policy: NETWORK_POLICY,
        wait_seconds: WAIT,
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        api_id: { type: 'string' },
        slug: { type: 'string' },
        investigation_phase: { type: ['string', 'null'] },
        proposed_output_schema: { type: ['object', 'null'] },
        sample: { type: 'array' },
        access_report: { type: ['object', 'null'] },
        run_id: { type: 'string' },
        brief_version: { type: 'integer' },
        brief_report: { type: 'array', items: { type: 'object' } },
        // Récit en données (05 § 1.2) : les mêmes faits que le texte de `content`.
        timeline: { type: 'array' },
        attempts: { type: 'array' },
        cost: { type: 'object' },
        console_url: { type: 'string' },
        next_action: { type: ['object', 'null'] },
        message_locale: { type: 'string' },
      },
    },
  },
  {
    name: 'validate_schema',
    toolset: 'build',
    scope: 'apis:write',
    description: 'Validate (optionally corrected) the output schema proposed by create_api, after the user agreed. SYM then tries the strategies, cheapest first, and returns a RunResult.',
    annotations: EXECUTE,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['api_id'],
      properties: { api_id: UUID_STRING, output_schema: { type: 'object', description: 'Corrected JSON Schema of one item (optional).' }, wait_seconds: WAIT },
    },
    outputSchema: RUN_RESULT_SCHEMA,
  },
  {
    name: 'run_api',
    toolset: 'run',
    scope: 'apis:run',
    description: 'Run an API of the catalog with an input matching its input schema (see get_api). Returns at most 20 items; page the rest with get_items. Never retry an API whose status is bloquee.',
    annotations: EXECUTE,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['input'],
      properties: {
        slug: SLUG,
        api_id: UUID_STRING,
        input: { type: 'object', description: 'Input matching the API input schema.' },
        wait_seconds: WAIT,
        force_investigate: { type: 'boolean', description: 'Owner only: investigate the site again instead of running (status erreur).' },
      },
    },
    outputSchema: RUN_RESULT_SCHEMA,
  },
  {
    name: 'get_run',
    toolset: 'run',
    scope: 'runs:read',
    description: 'Read the state and first items of one of your runs (RunResult). Poll it after a running answer, every poll_after_seconds; progress says what SYM is doing.',
    annotations: READ,
    inputSchema: { type: 'object', additionalProperties: false, required: ['run_id'], properties: { run_id: UUID_STRING } },
    outputSchema: RUN_RESULT_SCHEMA,
  },
  {
    name: 'get_items',
    toolset: 'run',
    scope: 'datasets:read',
    description: 'Page through the items of one of your runs or datasets, from next_cursor, without duplicates.',
    annotations: READ,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        run_id: UUID_STRING,
        dataset_id: UUID_STRING,
        cursor: { type: 'string', maxLength: 512 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        fields: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 200 } },
      },
    },
    outputSchema: { type: 'object', required: ['items', 'next_cursor'], properties: { items: { type: 'array', items: { type: 'object' } }, next_cursor: { type: ['string', 'null'] } } },
  },
  {
    name: 'cancel_run',
    toolset: 'run',
    scope: 'apis:run',
    description: 'Cancel one of your queued or running runs (an investigation included). Costs already incurred stay charged.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', additionalProperties: false, required: ['run_id'], properties: { run_id: UUID_STRING } },
    outputSchema: { type: 'object', required: ['run_id', 'state', 'cost'], properties: { run_id: { type: 'string' }, state: { const: 'cancelled' }, cost: { type: 'object' } } },
  },
  {
    name: 'list_apis',
    toolset: 'catalog',
    scope: 'apis:read',
    description: 'List the APIs you can use (yours and the shared ones), with status, execution and average cost. Search with q, page with cursor.',
    annotations: READ,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { enum: ['enquete', 'sain', 'warning', 'reparation', 'erreur', 'action_requise', 'bloquee'] },
        q: { type: 'string', maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        cursor: { type: 'string', maxLength: 512 },
      },
    },
    outputSchema: { type: 'object', required: ['apis', 'next_cursor'], properties: { apis: { type: 'array', items: { type: 'object' } }, next_cursor: { type: ['string', 'null'] } } },
  },
  {
    name: 'get_api',
    toolset: 'catalog',
    scope: 'apis:read',
    description: 'Read one API: input and output schemas, current strategy, last runs, status and access report.',
    annotations: READ,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug'],
      properties: { slug: SLUG, response_format: { enum: ['concise', 'detailed'] } },
    },
    outputSchema: { type: 'object', required: ['slug', 'status'], properties: { slug: { type: 'string' }, status: { type: 'string' } } },
  },
  {
    name: 'report_problem',
    toolset: 'catalog',
    scope: 'apis:read',
    description: 'Report a problem with an API (wrong or missing data) to its owner, optionally for one run.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug', 'note'],
      properties: { slug: SLUG, run_id: UUID_STRING, note: { type: 'string', minLength: 1, maxLength: 2000 } },
    },
    outputSchema: { type: 'object', required: ['bug_id'], properties: { bug_id: { type: 'string' } } },
  },
];

/** Description figée d'un outil par API (05 § 1.1) : le slug seul, ni description, ni statut, ni texte du site. */
export const apiToolDescription = (slug: string): string =>
  `Run the SYM API "${slug}" with an input matching its input schema. Returns a RunResult (at most 20 items, page with get_items). After a blocked error, do not retry it.`;

/** Nom de l'outil d'une API (`api_<slug>`, préfixe de namespace) ; null si le nom dépasserait la longueur admise. */
export function apiToolName(slug: string): string | null {
  const name = `api_${slug.replace(/-/g, '_')}`;
  return /^api_[a-z0-9_]+$/.test(name) && name.length <= MAX_TOOL_NAME ? name : null;
}

/** Toolsets demandés par `?toolsets=` (noms inconnus ignorés) ; absent : tous ceux actifs par défaut. */
export function parseToolsets(raw: unknown): Set<Toolset> {
  if (typeof raw !== 'string') return new Set(TOOLSETS);
  const wanted = raw.split(',').map((s) => s.trim());
  return new Set(TOOLSETS.filter((t) => wanted.includes(t)));
}
