// SPDX-License-Identifier: AGPL-3.0-only
// Format de stratégie déclarative (04b § 2, `schema_version: 1`) : types, JSON Schema 2020-12 et validation à l'enregistrement
// (schéma, compilation des JSONPath et CSS, opérateurs, `allowed_hosts`, absence de secret, couverture des `required` de `output_schema`).
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import { BLOB_KINDS, SCRIPT_ID_PATTERN, VARIABLE_PATTERN, type BlobLocator } from './blobs.js';
import { compileSelector } from './css.js';
import { DslError } from './errors.js';
import { compileJsonPath } from './jsonpath.js';
import { compileOperators, OPERATOR_NAMES, type OperatorSpec } from './operators.js';

export const SPEC_SCHEMA_VERSION = 1;

export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
export type SourceFrom = 'response' | 'html' | 'embedded';
export type PaginationType = 'page_param' | 'offset' | 'cursor' | 'next_link' | 'infinite_scroll' | 'none';

export interface HttpRequestTemplate {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: { json?: unknown; form?: Record<string, string>; text?: string };
}

export interface RequestSpec extends HttpRequestTemplate {
  allowed_hosts: string[];
  session?: { mode: string; domain: string; inject?: ('cookie' | 'header')[] };
  params?: { at: string; role: 'constant' | 'input' | 'pagination' | 'session' | 'derived'; name?: string; step?: string }[];
  graphql?: { operation_name: string; persisted: 'none' | 'apq' | 'id'; hash?: string; query?: string } | null;
}

export interface StepSpec {
  id: string;
  request: HttpRequestTemplate;
  capture: Record<string, string>;
}

export interface FieldLocator {
  path?: string;
  css?: string;
  attr?: string;
  fallback_paths?: string[];
}

export interface FieldSpec extends FieldLocator {
  /** Refusé à l'enregistrement (aucune bibliothèque XPath sûre retenue en V1). */
  xpath?: string;
  type: FieldType;
  required?: boolean;
  reduce?: 'first' | 'all' | 'join';
  ops?: OperatorSpec[];
}

export interface SourceSpec {
  id: string;
  from: SourceFrom;
  format?: 'json';
  locator?: BlobLocator;
  /** JSONPath RFC 9535 (JSON, blob) ou sélecteur CSS (HTML). */
  records: string;
  /** Chemins propres à cette source, par champ (remplacent `path`, `css`, `attr`, `fallback_paths` du champ). */
  field_overrides?: Record<string, FieldLocator>;
}

export type StopCondition =
  | { when: 'records_empty' }
  | { when: 'repeated_cursor' }
  | { when: 'path_equals'; path: string; value: string | number | boolean | null }
  | { when: 'path_missing'; path: string };

export interface PaginationSpec {
  type: PaginationType;
  /** Emplacement du numéro de page : `url.query.<nom>`, `body.json.<chemin>`, `body.form.<nom>`, ou `url.path` (avec `path_pattern`). */
  param?: string;
  /**
   * Chemin des pages suivantes quand le numéro est dans le chemin (`/annonces/page/{page}/`) : `param` vaut `url.path`, la
   * première page est l'URL de la requête telle quelle, la page N remplace le chemin par ce motif. Chemin seul : l'hôte et
   * le schéma restent ceux de la requête (INV10).
   */
  path_pattern?: string;
  next_path?: string;
  start?: number;
  step?: number | 'items_received';
  stop?: StopCondition[];
  limits?: { max_pages_input?: string; hard_max_pages?: number };
}

export interface DeclarativeSpec {
  schema_version: 1;
  kind: 'declarative';
  request: RequestSpec;
  steps?: StepSpec[];
  sources: SourceSpec[];
  fields: Record<string, FieldSpec>;
  pagination?: PaginationSpec;
  expect?: { min_records?: number; shape_fingerprint?: string; sample_ref?: string };
  limits?: { max_response_bytes?: number; max_depth?: number; timeout_ms?: number };
}

// ---------------------------------------------------------------------------------------------------- JSON Schema

const ID = { type: 'string', pattern: '^[a-z][a-z0-9_]{0,31}$' };
const HOST = { type: 'string', pattern: '^[a-z0-9_]([a-z0-9_.-]{0,251}[a-z0-9_])?$' };
const NAME = { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]{0,63}$' };
const NAME_KEYS = { allOf: [NAME, { not: { enum: ['__proto__', 'constructor', 'prototype'] } }] };
const POINTER_LIKE = { type: 'string', pattern: '^[A-Za-z0-9_.\\[\\]-]{1,200}$' };
const PATH = { type: 'string', minLength: 1, maxLength: 1000 };
const SCALAR = { type: ['string', 'number', 'boolean', 'null'] };

const httpProps = {
  method: { enum: ['GET', 'POST'] },
  url: { type: 'string', pattern: '^https?://', maxLength: 2000 },
  headers: { type: 'object', maxProperties: 30, additionalProperties: { type: 'string', maxLength: 1000 } },
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      json: {},
      form: { type: 'object', maxProperties: 50, additionalProperties: { type: 'string', maxLength: 2000 } },
      text: { type: 'string', maxLength: 20000 },
    },
  },
};

const locatorProps = {
  path: PATH,
  css: { type: 'string', minLength: 1, maxLength: 300 },
  attr: { type: 'string', pattern: '^(text|[A-Za-z_:][A-Za-z0-9_:.-]{0,63})$' },
  fallback_paths: { type: 'array', maxItems: 5, items: PATH },
};

export const DECLARATIVE_SPEC_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://scrapyomama.invalid/schemas/declarative-strategy-v1.json',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'kind', 'request', 'sources', 'fields'],
  properties: {
    schema_version: { const: SPEC_SCHEMA_VERSION },
    kind: { const: 'declarative' },
    request: {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'url', 'allowed_hosts'],
      properties: {
        ...httpProps,
        allowed_hosts: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: HOST },
        session: {
          type: 'object',
          additionalProperties: false,
          required: ['mode', 'domain'],
          properties: {
            mode: { type: 'string', pattern: '^[a-z_]{1,32}$' },
            domain: HOST,
            inject: { type: 'array', maxItems: 2, items: { enum: ['cookie', 'header'] } },
          },
        },
        params: {
          type: 'array',
          maxItems: 50,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['at', 'role'],
            properties: {
              at: POINTER_LIKE,
              role: { enum: ['constant', 'input', 'pagination', 'session', 'derived'] },
              name: NAME,
              step: ID,
            },
          },
        },
        graphql: {
          anyOf: [
            { type: 'null' },
            {
              type: 'object',
              additionalProperties: false,
              required: ['operation_name', 'persisted'],
              properties: {
                operation_name: { type: 'string', maxLength: 200 },
                persisted: { enum: ['none', 'apq', 'id'] },
                hash: { type: 'string', maxLength: 200 },
                query: { type: 'string', maxLength: 20000 },
              },
            },
          ],
        },
      },
    },
    steps: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'request', 'capture'],
        properties: {
          id: ID,
          request: { type: 'object', additionalProperties: false, required: ['method', 'url'], properties: httpProps },
          capture: { type: 'object', minProperties: 1, maxProperties: 10, propertyNames: NAME_KEYS, additionalProperties: PATH },
        },
      },
    },
    sources: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'from', 'records'],
        properties: {
          id: ID,
          from: { enum: ['response', 'html', 'embedded'] },
          format: { const: 'json' },
          locator: {
            type: 'object',
            additionalProperties: false,
            required: ['kind'],
            properties: {
              kind: { enum: [...BLOB_KINDS] },
              id: { type: 'string', pattern: SCRIPT_ID_PATTERN.source },
              variable: { type: 'string', pattern: VARIABLE_PATTERN.source },
            },
          },
          records: PATH,
          field_overrides: {
            type: 'object',
            maxProperties: 64,
            propertyNames: NAME_KEYS,
            additionalProperties: { type: 'object', additionalProperties: false, properties: locatorProps },
          },
        },
        allOf: [
          { if: { properties: { from: { const: 'embedded' } }, required: ['from'] }, then: { required: ['locator'] }, else: { not: { required: ['locator'] } } },
          { if: { properties: { from: { const: 'html' } }, required: ['from'] }, then: { not: { required: ['format'] } } },
        ],
      },
    },
    fields: {
      type: 'object',
      minProperties: 1,
      maxProperties: 64,
      propertyNames: NAME_KEYS,
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['type'],
        properties: {
          ...locatorProps,
          xpath: { type: 'string', maxLength: 1000 },
          type: { enum: ['string', 'number', 'integer', 'boolean', 'array', 'object'] },
          required: { type: 'boolean' },
          reduce: { enum: ['first', 'all', 'join'] },
          ops: {
            type: 'array',
            maxItems: 16,
            items: {
              oneOf: [
                { enum: [...OPERATOR_NAMES] },
                { type: 'object', required: ['op'], properties: { op: { enum: [...OPERATOR_NAMES] } } },
              ],
            },
          },
        },
      },
    },
    pagination: {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: { enum: ['page_param', 'offset', 'cursor', 'next_link', 'infinite_scroll', 'none'] },
        param: POINTER_LIKE,
        path_pattern: { type: 'string', maxLength: 500, pattern: '^/[^?#{}\\s]*\\{page\\}[^?#{}\\s]*$' },
        next_path: PATH,
        start: { type: 'integer', minimum: 0, maximum: 1_000_000 },
        step: { oneOf: [{ type: 'integer', minimum: 1, maximum: 10_000 }, { const: 'items_received' }] },
        stop: {
          type: 'array',
          maxItems: 10,
          items: {
            oneOf: [
              { type: 'object', additionalProperties: false, required: ['when'], properties: { when: { const: 'records_empty' } } },
              { type: 'object', additionalProperties: false, required: ['when'], properties: { when: { const: 'repeated_cursor' } } },
              { type: 'object', additionalProperties: false, required: ['when', 'path', 'value'], properties: { when: { const: 'path_equals' }, path: PATH, value: SCALAR } },
              { type: 'object', additionalProperties: false, required: ['when', 'path'], properties: { when: { const: 'path_missing' }, path: PATH } },
            ],
          },
        },
        limits: {
          type: 'object',
          additionalProperties: false,
          properties: { max_pages_input: { type: 'string', pattern: '^input\\.[A-Za-z_][A-Za-z0-9_]{0,63}$' }, hard_max_pages: { type: 'integer', minimum: 1, maximum: 200 } },
        },
      },
    },
    expect: {
      type: 'object',
      additionalProperties: false,
      properties: {
        min_records: { type: 'integer', minimum: 0, maximum: 1_000_000 },
        shape_fingerprint: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
        sample_ref: { type: 'string', maxLength: 300 },
      },
    },
    limits: {
      type: 'object',
      additionalProperties: false,
      properties: {
        max_response_bytes: { type: 'integer', minimum: 1, maximum: 20_000_000 },
        max_depth: { type: 'integer', minimum: 1, maximum: 64 },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 60_000 },
      },
    },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true, validateFormats: false });
const validateSchema = ajv.compile(DECLARATIVE_SPEC_SCHEMA);

// ---------------------------------------------------------------------------------------------------- validation

export interface SpecIssue {
  /** Pointeur JSON vers l'élément fautif. */
  path: string;
  code: string;
  message: string;
}

export type SpecValidation = { ok: true; spec: DeclarativeSpec } | { ok: false; errors: SpecIssue[] };

export interface ValidateSpecOptions {
  /** `output_schema` de l'API (schéma d'un enregistrement) : `fields` doit couvrir ses `required`. */
  outputSchema?: unknown;
}

const FORBIDDEN_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'set-cookie', 'host']);
const SECRET_PARAMS = new Set(['token', 'access_token', 'api_key', 'apikey', 'key', 'secret', 'password', 'auth', 'authorization', 'sig', 'signature', 'session', 'sessionid']);
const TEMPLATE_ANY = /\{\{|\}\}/;
const TEMPLATE = /\{\{\s*(input|page|steps)\.([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\s*\}\}/g;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function ajvIssue(e: ErrorObject): SpecIssue {
  const params = e.params as Record<string, unknown>;
  let message = e.message ?? 'invalide';
  if (e.keyword === 'additionalProperties') message = `propriété non autorisée : ${String(params['additionalProperty'])}`;
  else if (e.keyword === 'required') message = `propriété requise absente : ${String(params['missingProperty'])}`;
  else if (e.keyword === 'enum') message = 'valeur hors de la liste autorisée';
  else if (e.keyword === 'pattern') message = 'format invalide';
  return { path: e.instancePath === '' ? '(racine)' : e.instancePath, code: `schema_${e.keyword}`, message };
}

/** Gabarits `{{input.x}}`, `{{page.x}}`, `{{steps.id.nom}}` : tout autre `{{` est refusé. */
function templateIssues(text: string, path: string, stepNames: Map<string, Set<string>>): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const rest = text.replace(TEMPLATE, (_m, ns: string, a: string, b: string | undefined) => {
    if (ns === 'steps') {
      if (b === undefined || !stepNames.get(a)?.has(b)) issues.push({ path, code: 'invalid_template', message: `gabarit steps.${a}${b === undefined ? '' : `.${b}`} : étape ou capture inconnue` });
    } else if (b !== undefined) {
      issues.push({ path, code: 'invalid_template', message: `gabarit ${ns}.${a}.${b} : un seul niveau attendu` });
    }
    return '';
  });
  if (TEMPLATE_ANY.test(rest)) issues.push({ path, code: 'invalid_template', message: 'gabarit non reconnu (formes admises : input.x, page.x, steps.id.nom)' });
  return issues;
}

function walkStrings(value: unknown, path: string, visit: (s: string, p: string) => void, depth = 0): void {
  if (depth > 32) return;
  if (typeof value === 'string') visit(value, path);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, `${path}/${i}`, visit, depth + 1));
  else if (isRecord(value)) for (const [k, v] of Object.entries(value)) walkStrings(v, `${path}/${k}`, visit, depth + 1);
}

function checkHttp(req: HttpRequestTemplate, path: string, allowed: readonly string[], stepNames: Map<string, Set<string>>, issues: SpecIssue[]): void {
  // Hôte : statique (aucun gabarit avant le premier `/`, `?` ou `#`) et présent dans allowed_hosts (INV10).
  const afterScheme = req.url.replace(/^https?:\/\//, '');
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? '';
  if (TEMPLATE_ANY.test(authority)) {
    issues.push({ path: `${path}/url`, code: 'host_not_static', message: "l'hôte de l'URL ne peut pas être un gabarit" });
  } else {
    const SENTINEL = 'zz-tpl-zz';
    let url: URL | undefined;
    try {
      url = new URL(req.url.replace(TEMPLATE, SENTINEL));
    } catch {
      issues.push({ path: `${path}/url`, code: 'invalid_url', message: 'URL invalide' });
    }
    if (url !== undefined) {
      if (url.username !== '' || url.password !== '') issues.push({ path: `${path}/url`, code: 'secret_in_spec', message: "identifiants dans l'URL interdits" });
      if (!allowed.includes(url.hostname)) issues.push({ path: `${path}/url`, code: 'host_not_allowed', message: "l'hôte de l'URL n'est pas dans allowed_hosts" });
      for (const [name, value] of url.searchParams) {
        if (SECRET_PARAMS.has(name.toLowerCase()) && value !== SENTINEL) issues.push({ path: `${path}/url`, code: 'secret_in_spec', message: `paramètre « ${name} » : valeur constante interdite (secret possible)` });
      }
    }
  }
  for (const name of Object.keys(req.headers ?? {})) {
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) issues.push({ path: `${path}/headers/${name}`, code: 'secret_in_spec', message: `en-tête « ${name} » interdit (les sessions sont des références)` });
  }
  walkStrings(req.url, `${path}/url`, (s, p) => issues.push(...templateIssues(s, p, stepNames)));
  walkStrings(req.headers, `${path}/headers`, (s, p) => issues.push(...templateIssues(s, p, stepNames)));
  walkStrings(req.body, `${path}/body`, (s, p) => issues.push(...templateIssues(s, p, stepNames)));
}

function tryCompile(fn: () => unknown, path: string, issues: SpecIssue[]): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof DslError) issues.push({ path, code: error.code, message: error.message });
    else throw error;
  }
}

/** Validation complète d'une stratégie déclarative à l'enregistrement. Ne lève jamais pour un document invalide. */
export function validateDeclarativeSpec(input: unknown, options: ValidateSpecOptions = {}): SpecValidation {
  if (!validateSchema(input)) return { ok: false, errors: (validateSchema.errors ?? []).slice(0, 30).map(ajvIssue) };
  const spec = input as unknown as DeclarativeSpec;
  const issues: SpecIssue[] = [];

  const stepNames = new Map<string, Set<string>>();
  for (const [i, step] of (spec.steps ?? []).entries()) {
    if (stepNames.has(step.id)) issues.push({ path: `/steps/${i}/id`, code: 'duplicate_id', message: 'identifiant d\'étape en double' });
    stepNames.set(step.id, new Set(Object.keys(step.capture)));
    for (const [name, path] of Object.entries(step.capture)) tryCompile(() => compileJsonPath(path), `/steps/${i}/capture/${name}`, issues);
  }

  checkHttp(spec.request, '/request', spec.request.allowed_hosts, stepNames, issues);
  for (const [i, step] of (spec.steps ?? []).entries()) checkHttp(step.request, `/steps/${i}/request`, spec.request.allowed_hosts, stepNames, issues);
  if (spec.request.session !== undefined && !spec.request.allowed_hosts.some((h) => h === spec.request.session?.domain || h.endsWith(`.${spec.request.session?.domain ?? ''}`))) {
    issues.push({ path: '/request/session/domain', code: 'session_domain_mismatch', message: 'le domaine de session doit couvrir un hôte de allowed_hosts' });
  }

  const ids = new Set<string>();
  for (const [i, source] of spec.sources.entries()) {
    const at = `/sources/${i}`;
    if (ids.has(source.id)) issues.push({ path: `${at}/id`, code: 'duplicate_id', message: 'identifiant de source en double' });
    ids.add(source.id);
    if (source.from === 'html') tryCompile(() => compileSelector(source.records), `${at}/records`, issues);
    else tryCompile(() => compileJsonPath(source.records), `${at}/records`, issues);
    for (const [name, override] of Object.entries(source.field_overrides ?? {})) {
      if (!(name in spec.fields)) issues.push({ path: `${at}/field_overrides/${name}`, code: 'unknown_field', message: 'champ inconnu' });
      checkLocator(override, `${at}/field_overrides/${name}`, issues);
    }
  }

  for (const [name, field] of Object.entries(spec.fields)) {
    const at = `/fields/${name}`;
    if (field.xpath !== undefined) issues.push({ path: `${at}/xpath`, code: 'unsupported', message: 'XPath non pris en charge dans cette version (utiliser css ou path)' });
    tryCompile(() => compileOperators(field.ops), `${at}/ops`, issues);
    checkLocator(field, at, issues);
    for (const [i, source] of spec.sources.entries()) {
      const effective = { ...field, ...(source.field_overrides?.[name] ?? {}) };
      const usable = source.from === 'html' ? effective.css !== undefined || effective.attr !== undefined : effective.path !== undefined;
      if (!usable) issues.push({ path: at, code: 'field_missing_locator', message: `aucun ${source.from === 'html' ? 'sélecteur css' : 'chemin path'} pour la source « ${source.id} » (#${i})` });
      // Un repli est un sélecteur CSS pour une source HTML, un chemin JSONPath sinon.
      for (const [k, alt] of (effective.fallback_paths ?? []).entries()) {
        tryCompile(() => (source.from === 'html' ? compileSelector(alt) : compileJsonPath(alt)), `${at}/fallback_paths/${k}`, issues);
      }
      if (source.from !== 'html' && effective.css !== undefined && effective.path === undefined) issues.push({ path: at, code: 'field_locator_mismatch', message: `la source « ${source.id} » est JSON : css n'a pas de sens` });
    }
  }

  checkPagination(spec, issues);

  if (options.outputSchema !== undefined && isRecord(options.outputSchema)) {
    const required = options.outputSchema['required'];
    if (Array.isArray(required)) {
      for (const name of required) {
        if (typeof name === 'string' && !(name in spec.fields)) issues.push({ path: '/fields', code: 'required_not_covered', message: `le champ requis « ${name} » de output_schema n'est pas extrait` });
      }
    }
  }

  return issues.length === 0 ? { ok: true, spec } : { ok: false, errors: issues.slice(0, 50) };
}

function checkLocator(loc: FieldLocator, at: string, issues: SpecIssue[]): void {
  if (loc.path !== undefined) tryCompile(() => compileJsonPath(loc.path as string), `${at}/path`, issues);
  if (loc.css !== undefined) tryCompile(() => compileSelector(loc.css as string), `${at}/css`, issues);
}

function checkPagination(spec: DeclarativeSpec, issues: SpecIssue[]): void {
  const p = spec.pagination;
  if (p === undefined) return;
  if (p.type !== 'none') {
    if (p.stop === undefined || p.stop.length === 0) issues.push({ path: '/pagination/stop', code: 'stop_required', message: "stop[] obligatoire (sauf type none)" });
    if (p.limits?.hard_max_pages === undefined) issues.push({ path: '/pagination/limits/hard_max_pages', code: 'hard_max_pages_required', message: 'hard_max_pages obligatoire (arrêt certain)' });
  }
  if ((p.type === 'page_param' || p.type === 'offset' || p.type === 'cursor') && p.param === undefined) issues.push({ path: '/pagination/param', code: 'param_required', message: 'param obligatoire' });
  if (p.type === 'cursor' && p.next_path === undefined) issues.push({ path: '/pagination/next_path', code: 'next_path_required', message: 'next_path obligatoire' });
  if (p.next_path !== undefined) tryCompile(() => compileJsonPath(p.next_path as string), '/pagination/next_path', issues);
  for (const [i, stop] of (p.stop ?? []).entries()) {
    if ('path' in stop) tryCompile(() => compileJsonPath(stop.path), `/pagination/stop/${i}/path`, issues);
    if (stop.when === 'repeated_cursor' && p.type !== 'cursor' && p.type !== 'next_link') issues.push({ path: `/pagination/stop/${i}`, code: 'stop_not_applicable', message: 'repeated_cursor ne vaut que pour cursor et next_link' });
  }
  // Numéro de page dans le chemin : motif obligatoire, `page_param` seulement, aucun segment `.` ni `..` (le chemin ne remonte pas).
  if (p.param === 'url.path') {
    if (p.type !== 'page_param') issues.push({ path: '/pagination/param', code: 'param_not_applicable', message: 'url.path ne vaut que pour page_param' });
    if (p.path_pattern === undefined) issues.push({ path: '/pagination/path_pattern', code: 'path_pattern_required', message: 'path_pattern obligatoire avec url.path' });
    else if (p.path_pattern.split('{page}').length !== 2 || p.path_pattern.split('/').some((seg) => seg === '..' || seg === '.')) {
      issues.push({ path: '/pagination/path_pattern', code: 'invalid_path_pattern', message: 'path_pattern : un seul {page}, aucun segment . ou ..' });
    }
  } else if (p.path_pattern !== undefined) {
    issues.push({ path: '/pagination/path_pattern', code: 'param_not_applicable', message: 'path_pattern ne vaut qu’avec param url.path' });
  }
  if (p.param !== undefined && !spec.request.params?.some((x) => x.at === p.param && x.role === 'pagination')) {
    issues.push({ path: '/pagination/param', code: 'param_not_declared', message: 'param doit figurer dans request.params avec le rôle pagination' });
  }
}
