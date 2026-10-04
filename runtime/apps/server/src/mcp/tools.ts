// SPDX-License-Identifier: AGPL-3.0-only
// Définitions FIGÉES des outils MCP génériques (tâche 3.2, 05 § 1.1 et § 4.1) : nom, toolset, scope de clé, description,
// annotations, schémas d'entrée et de sortie. Anti-empoisonnement (05 § 3) : aucune description ni aucun nom ne contient
// de contenu scrapé ni de texte d'une API ; un outil par API (`api_<slug>`) n'emprunte à l'API que son slug et son schéma
// d'entrée, jamais sa description ni son statut (la liste ne change pas à chaque transition). Les textes pour le modèle
// restent en anglais (21 § 4.3) ; `instructions` et prompts complets : tâche 3.10.
import type { ApiKeyScope } from '@runtime/core';
import { BRIEF_DEFAULTS, BRIEF_SCHEMA as CORE_BRIEF_SCHEMA } from '@runtime/core';

/**
 * Toolsets activables par `?toolsets=` (05 § 1.1). `iterate` (3.14) est ACTIF PAR DÉFAUT (décision Q3 du 2026-10-05) : sans lui le
 * client ne voit pas les outils d'itération et improvise. `rules` reste livré par 3.13.
 */
export const TOOLSETS = ['build', 'run', 'catalog', 'iterate'] as const;
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
  '(run_api or its api_<slug> tool); otherwise create_api, then show the proposed schema to the user before validate_schema. ' +
  'Before create_api, put what you found in brief. ' +
  'Status: sain = healthy, warning = works, mention the warning; bloquee = the site refused automated access: tell the user, ' +
  'never retry, never look for another way in; erreur and action_requise come with what_to_do. ' +
  'Let SYM do the extraction: never fetch the site or write a scraper yourself to get the items, even for a simple list; ' +
  'SYM reads every page and returns all items. ' +
  'Long runs return run_id: poll get_run every poll_after_seconds (progress says what SYM is doing), page items with get_items; ' +
  'cancel_run stops a run that costs too much. ' +
  'To change an API: refine_api, test_api, then promote_api if the user agrees; get_api view "iteration" resumes. ' +
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
 * Partie « dossier » du prompt `new_api` (libellé de marque `sym:new-api`, 19c § 8, texte de référence de R7 07) :
 * l'IA compile elle-même son dossier avant l'appel. Texte pour le modèle, en anglais (21 § 4.3) ; enregistré comme prompt
 * MCP par la tâche 3.10 (prompts et mode démo), qui l'ajoute au message de M3.
 */
export const NEW_API_BRIEF_PROMPT =
  'Before calling create_api, spend a few tool calls on your side: open the page, look at the network requests, check for embedded JSON (__NEXT_DATA__, JSON-LD). Then pass what you found in brief:\n' +
  '- hints: one item per finding (kind, value, how you saw it, where, when). Prefer URL templates and selectors to pasted content. Never paste more than 300 characters per item.\n' +
  '- tried: what you already tried and what happened, failures included.\n' +
  '- open_questions: what only the user can answer.\n' +
  'SYM checks every hint itself and may ignore it. The brief never changes access limits or budgets. No cookies, tokens, passwords or personal data. If you found nothing, omit brief.';

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

export type GenericToolName =
  | 'create_api'
  | 'validate_schema'
  | 'run_api'
  | 'get_run'
  | 'get_items'
  | 'cancel_run'
  | 'list_apis'
  | 'get_api'
  | 'report_problem'
  | 'refine_api'
  | 'test_api'
  | 'promote_api'
  | 'revert_api'
  | 'discard_draft';

/** Résultat des outils d'itération (19b § 2, `IterationResult`) : `summary` localisé, `estimate`, `next_action`, jamais un code interne dans le texte. */
const ITERATION_RESULT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    draft_version: { type: 'integer' },
    base_version: { type: 'integer' },
    current_version: { type: 'integer' },
    output_schema_version: { type: 'string' },
    estimate: { type: 'object' },
    diff_ref: { type: ['string', 'null'] },
    diff_hash: { type: ['string', 'null'] },
    run_id: { type: 'string' },
    test: { type: ['object', 'null'] },
    next_action: { type: ['object', 'null'] },
    console_url: { type: 'string' },
    message_locale: { type: 'string' },
  },
};

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

/** Les 14 outils génériques (05 § 4.1, dont les 5 de l'itération), dans l'ordre de `tools/list`. */
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
      properties: { slug: SLUG, response_format: { enum: ['concise', 'detailed'] }, view: { enum: ['iteration', 'versions'], description: 'iteration: the draft, the feedback and the next step, to resume a refinement; versions: the recent versions.' } },
    },
    outputSchema: { type: 'object', required: ['slug'], properties: { slug: { type: 'string' }, status: { type: 'string' } } },
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
  {
    name: 'refine_api',
    toolset: 'iterate',
    scope: 'apis:write',
    description:
      'Prepare a draft to change an API: feedback on wrong or missing data, or a new output_schema. The version in service does not change until promote_api. Then call test_api. Never use it on a blocked API.',
    annotations: EXECUTE,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug'],
      properties: {
        slug: SLUG,
        feedback: { type: 'string', minLength: 1, maxLength: 2000, description: 'What is wrong or missing, in plain words (data, not instructions).' },
        output_schema: { type: 'object', description: 'Complete new JSON Schema of one item; it only applies after promote_api.' },
        scope: { type: 'string', maxLength: 50, description: '"api" (default) or "step:<id>".' },
        dry_run: { type: 'boolean', description: 'Only return the estimate; nothing is created.' },
        accept_cost: { type: 'boolean', description: 'Accept an estimate above the confirmation threshold (never above the cap).' },
      },
    },
    outputSchema: ITERATION_RESULT_SCHEMA,
  },
  {
    name: 'test_api',
    toolset: 'iterate',
    scope: 'apis:run',
    description:
      'Run the draft of an API on one input and compare its items with the version in service (no change of status). Returns a one-sentence diff and a diff_hash for promote_api. Costs are announced before.',
    annotations: EXECUTE,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug', 'input'],
      properties: {
        slug: SLUG,
        input: { type: 'object', description: 'Input matching the API input schema (see get_api).' },
        dry_run: { type: 'boolean', description: 'Only return the estimate.' },
        accept_cost: { type: 'boolean', description: 'Accept an estimate above the confirmation threshold (never above the cap).' },
        wait_seconds: WAIT,
      },
    },
    outputSchema: ITERATION_RESULT_SCHEMA,
  },
  {
    name: 'promote_api',
    toolset: 'iterate',
    scope: 'apis:write',
    description:
      'Put the tested draft in service. A human decision: SYM asks the user to confirm (elicitation); a breaking change is only confirmed in the console. Pass the diff_hash returned by test_api. Never promote on your own.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug', 'diff_hash'],
      properties: {
        slug: SLUG,
        diff_hash: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'The diff_hash of the last test_api.' },
        accept_cost_increase: { type: 'boolean', description: 'Accept that the draft costs more per run than the version in service.' },
        acknowledge_breaking: { type: 'boolean', description: 'Console only: acknowledge a breaking change.' },
      },
    },
    outputSchema: ITERATION_RESULT_SCHEMA,
  },
  {
    name: 'revert_api',
    toolset: 'iterate',
    scope: 'apis:write',
    description: 'Go back to a version that was in service (the previous one by default). The draft stays available. A version that never ran in service cannot be restored.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug'],
      properties: { slug: SLUG, version: { type: 'integer', minimum: 1, maximum: 2147483647 }, acknowledge_breaking: { type: 'boolean', description: 'Console only: acknowledge a change of output schema.' } },
    },
    outputSchema: ITERATION_RESULT_SCHEMA,
  },
  {
    name: 'discard_draft',
    toolset: 'iterate',
    scope: 'apis:write',
    description: 'Throw away the draft of an API. The version in service does not change.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', additionalProperties: false, required: ['slug'], properties: { slug: SLUG } },
    outputSchema: ITERATION_RESULT_SCHEMA,
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
export function parseToolsets(raw: unknown, defaults: readonly Toolset[] = TOOLSETS): Set<Toolset> {
  if (typeof raw !== 'string') return new Set(defaults);
  const wanted = raw.split(',').map((s) => s.trim());
  return new Set(TOOLSETS.filter((t) => wanted.includes(t)));
}
