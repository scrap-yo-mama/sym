// SPDX-License-Identifier: AGPL-3.0-only
// Format portable d'une API (tâche 3.12, 16 § 6) : export et import JSON, sans I/O.
//
// Enveloppe `{format: "scrapyomama.api", format_version: "1.0", min_runtime_version, exported_at, api, strategy, history?,
// schedules, fixtures?, integrity: {sha256}}`, fermée (`additionalProperties: false`), écrite à clés triées (diffs git
// lisibles). Le format n'a AUCUN champ pour une session, un cookie, une clé LLM, un identifiant de proxy, un secret ou une
// URL de webhook, ni pour une donnée de run : les cibles d'alerte sont des références (`$ALERT_WEBHOOK_1`), la politique
// réseau ne garde que ses niveaux exportables (jamais le tunnel, INV5). La stratégie n'est exportée que déclarative
// (E1-E3), sans session, tunnel ni code.
//
// Import (`parseApiExport`) : les champs inconnus sont IGNORÉS (et listés), l'empreinte porte sur les champs connus ; une
// version de format d'une autre majeure, un runtime trop ancien, une empreinte fausse, un `$ref` distant (INV1), une
// stratégie hors format (session, secret, hôte hors du site) ou des fixtures hors schéma sont refusés. Un `tunnel` dans
// `api.network_policy.allow` est écarté (et listé) : un fichier ne fait jamais passer une API par le navigateur, la session
// et l'IP de l'utilisateur (INV5). La suite (enquête : `access_check` puis `testing`) est l'affaire de la base et du worker.
import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { validateAgentFetchSpec } from '../agent/specs.js';
import { validateDeclarativeSpec } from '../dsl/spec.js';
import { siteScope, withinSiteScope } from '../investigation/recon.js';
import { assertInputSchema } from '../schema/input-schema.js';
import { assertSchemaAcceptable, compileSchema, findRemoteRefs, SchemaError, validateOutput } from '../schema/validator.js';
import { compareSemver, parseSemver } from '../version.js';
import { WEBHOOK_EVENTS } from '../webhook/events.js';

export const API_EXPORT_FORMAT = 'scrapyomama.api';
/** Version du format écrite par cet export. Un import lit toute version `1.x` (les champs ajoutés par une mineure sont ignorés). */
export const API_EXPORT_FORMAT_VERSION = '1.0';
/** Plus petite version du runtime qui sait relire ce format : à monter quand le format change de façon incompatible. */
export const API_EXPORT_MIN_RUNTIME_VERSION = '0.0.0';

/**
 * Niveaux d'exécution exportables (04 § 3.1) : déclaratifs (E1-E3) et E4 `agent_fetch` (UX-28 : page lue, éléments mis en forme
 * par le rôle `extract`, sans session ni script). Ni E5 ni E6 (agent dans un navigateur), ni un script.
 */
export const PORTABLE_EXECUTIONS = ['fetch', 'fetch_in_page', 'playwright', 'agent_fetch'] as const;
/** Réseaux exportables : jamais le tunnel, qui porte l'identité et la session de l'utilisateur (INV5). */
export const PORTABLE_NETWORKS = ['direct', 'dc_proxy', 'res_proxy'] as const;

/**
 * Niveaux réseau d'une politique qu'un fichier peut porter, à l'export comme à l'import : exportables seulement (jamais
 * le tunnel), dans l'ordre, sans doublon ; une politique vidée devient `['direct']`.
 */
export function portableNetworkAllow(allow: readonly unknown[] | undefined): string[] {
  const kept = [...new Set((allow ?? []).filter((m): m is string => typeof m === 'string' && (PORTABLE_NETWORKS as readonly string[]).includes(m)))];
  return kept.length > 0 ? kept : ['direct'];
}

export type ApiExportStrategy = {
  execution: (typeof PORTABLE_EXECUTIONS)[number];
  network: (typeof PORTABLE_NETWORKS)[number];
  spec: Record<string, unknown>;
  est_cost_usd: number | null;
};

export type ApiExportSchedule = {
  cron: string;
  timezone: string;
  input: Record<string, unknown>;
  rules: Record<string, unknown>;
  overlap: 'skip' | 'queue' | 'allow';
  missed: 'once' | 'skip';
  enabled: boolean;
};

export type ApiExportApi = {
  slug?: string;
  description: string;
  source_url: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  output_columns?: string[];
  views?: { columns?: string[] };
  purpose?: string | null;
  legal_basis?: string | null;
  contains_personal_data?: boolean;
  max_cost_usd?: number;
  budget_daily_usd?: number;
  network_policy?: { allow: string[] };
  alert_targets?: { ref: string; events: string[] }[];
};

export type ApiExportDraft = {
  format: string;
  format_version: string;
  min_runtime_version: string;
  exported_at: string;
  api: ApiExportApi;
  strategy: ApiExportStrategy | null;
  history?: { version: number; execution: string; network: string; created_by: string; created_at: string }[];
  schedules: ApiExportSchedule[];
  fixtures?: { items: Record<string, unknown>[] };
};

export type ApiExport = ApiExportDraft & { integrity: { sha256: string } };

const SLUG = '^[a-z0-9][a-z0-9-]{0,62}$';
const NULLABLE_TEXT = { type: ['string', 'null'], maxLength: 2000 } as const;
const COLUMNS = { type: 'array', maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 200 } } as const;

/** JSON Schema 2020-12 de l'enveloppe (fermée à chaque niveau ; les schémas et la spécification sont contrôlés à part). */
export const API_EXPORT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['format', 'format_version', 'min_runtime_version', 'exported_at', 'api', 'strategy', 'schedules', 'integrity'],
  properties: {
    format: { const: API_EXPORT_FORMAT },
    format_version: { type: 'string', pattern: '^[0-9]{1,3}\\.[0-9]{1,3}$' },
    min_runtime_version: { type: 'string', pattern: '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$' },
    exported_at: { type: 'string', maxLength: 40, pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' },
    api: {
      type: 'object',
      additionalProperties: false,
      required: ['description', 'source_url', 'input_schema', 'output_schema'],
      properties: {
        slug: { type: 'string', pattern: SLUG },
        description: { type: 'string', minLength: 1, maxLength: 2000 },
        source_url: { type: 'string', maxLength: 2048, pattern: '^https?://' },
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        output_columns: COLUMNS,
        views: { type: 'object', additionalProperties: false, properties: { columns: COLUMNS } },
        purpose: NULLABLE_TEXT,
        legal_basis: NULLABLE_TEXT,
        contains_personal_data: { type: 'boolean' },
        max_cost_usd: { type: 'number', minimum: 0, maximum: 1000 },
        budget_daily_usd: { type: 'number', minimum: 0, maximum: 100000 },
        network_policy: {
          type: 'object',
          additionalProperties: false,
          required: ['allow'],
          // `tunnel` est LU (fichier écrit à la main ou par un autre outil) puis écarté par `parseApiExport` ; jamais écrit.
          properties: { allow: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: [...PORTABLE_NETWORKS, 'tunnel'] } } },
        },
        alert_targets: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['ref', 'events'],
            properties: { ref: { type: 'string', pattern: '^\\$ALERT_WEBHOOK_[1-9][0-9]?$' }, events: { type: 'array', uniqueItems: true, items: { enum: [...WEBHOOK_EVENTS] } } },
          },
        },
      },
    },
    strategy: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['execution', 'network', 'spec'],
          properties: {
            execution: { enum: [...PORTABLE_EXECUTIONS] },
            network: { enum: [...PORTABLE_NETWORKS] },
            spec: { type: 'object' },
            est_cost_usd: { type: ['number', 'null'], minimum: 0 },
          },
        },
      ],
    },
    history: {
      type: 'array',
      maxItems: 1000,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['version', 'execution', 'network', 'created_by', 'created_at'],
        properties: {
          version: { type: 'integer', minimum: 1 },
          execution: { type: 'string', maxLength: 32 },
          network: { type: 'string', maxLength: 32 },
          created_by: { type: 'string', maxLength: 32 },
          created_at: { type: 'string', maxLength: 40 },
        },
      },
    },
    schedules: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['cron', 'timezone', 'input', 'rules', 'overlap', 'missed', 'enabled'],
        properties: {
          cron: { type: 'string', minLength: 1, maxLength: 100 },
          timezone: { type: 'string', minLength: 1, maxLength: 64 },
          input: { type: 'object' },
          rules: { type: 'object' },
          overlap: { enum: ['skip', 'queue', 'allow'] },
          missed: { enum: ['once', 'skip'] },
          enabled: { type: 'boolean' },
        },
      },
    },
    fixtures: {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: { items: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object' } } },
    },
    integrity: {
      type: 'object',
      additionalProperties: false,
      required: ['sha256'],
      properties: { sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
    },
  },
} as const;

const validateEnvelope = new Ajv2020({ allErrors: false, strict: false }).compile(API_EXPORT_SCHEMA as unknown as Record<string, unknown>);

// ---------------------------------------------------------------------------------------------------------------
// Écriture : JSON canonique, empreinte, mise en forme
// ---------------------------------------------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Copie à clés triées à toute profondeur ; les valeurs `undefined` disparaissent (comme `JSON.stringify`). */
function sortKeys(value: unknown, depth = 0): unknown {
  if (depth > 256) throw new Error('document trop profond');
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : sortKeys(v, depth + 1)));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    if (v === undefined) continue;
    // defineProperty : une clé `__proto__` d'un schéma reste une donnée, jamais un prototype.
    Object.defineProperty(out, key, { value: sortKeys(v, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** JSON canonique (clés triées, sans espace) : base de l'empreinte. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Empreinte sha256 du contenu (l'enveloppe sans `integrity`). */
export function exportIntegrity(doc: ApiExportDraft | ApiExport): string {
  const { integrity: _integrity, ...content } = doc as ApiExport;
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');
}

/** Enveloppe scellée : contenu inchangé, empreinte calculée. */
export function sealExport(draft: ApiExportDraft): ApiExport {
  const { integrity: _integrity, ...content } = draft as ApiExport;
  return { ...content, integrity: { sha256: exportIntegrity(content) } };
}

/** Texte du fichier : JSON à clés triées, indenté de deux espaces, terminé par un saut de ligne. */
export function formatExport(doc: ApiExport): string {
  return `${JSON.stringify(sortKeys(doc), null, 2)}\n`;
}

/** Stratégie déclarative sans session : `request.session` absent, aucun paramètre de rôle `session`. */
function sessionFree(spec: Record<string, unknown>): boolean {
  const request = spec['request'];
  if (!isRecord(request)) return true;
  if (request['session'] !== undefined) return false;
  const params = request['params'];
  return !Array.isArray(params) || !params.some((p) => isRecord(p) && p['role'] === 'session');
}

/**
 * Version de stratégie exportable, ou `null` : seulement déclarative (E1-E3), sans script, hors tunnel, sans session, et
 * valide pour le DSL (aucun secret, hôtes statiques). Une API dont la stratégie n'est pas exportable s'exporte sans
 * stratégie : son import relancera une enquête complète.
 */
export function exportableStrategy(version: { execution: string; network: string; spec: unknown; script_ref: string | null; est_cost_usd: string | number | null }): ApiExportStrategy | null {
  if (version.script_ref !== null || !isRecord(version.spec)) return null;
  if (!(PORTABLE_EXECUTIONS as readonly string[]).includes(version.execution) || !(PORTABLE_NETWORKS as readonly string[]).includes(version.network)) return null;
  let spec: Record<string, unknown> = version.spec;
  if (version.execution === 'agent_fetch') {
    // E4 : spécification propre, sans les références de règles du propriétaire (relues sous son identité seulement : INV12).
    const checked = version.spec['kind'] === 'agent_fetch' ? validateAgentFetchSpec(version.spec) : null;
    if (checked === null || !checked.ok) return null;
    const { rules: _rules, ...portable } = checked.spec;
    spec = portable as Record<string, unknown>;
  } else if (version.spec['kind'] !== 'declarative' || !sessionFree(version.spec) || !validateDeclarativeSpec(version.spec).ok) return null;
  const cost = version.est_cost_usd === null ? null : Number(version.est_cost_usd);
  return {
    execution: version.execution as ApiExportStrategy['execution'],
    network: version.network as ApiExportStrategy['network'],
    spec,
    est_cost_usd: cost === null || !Number.isFinite(cost) ? null : cost,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Lecture : champs connus, refus
// ---------------------------------------------------------------------------------------------------------------

/** Forme connue : `true` = valeur gardée telle quelle ; objet = clés connues ; `[forme]` = chaque élément. */
type Shape = true | { readonly [key: string]: Shape } | readonly [Shape];

/** Champs d'identité, de propriété, d'état ou de session : refusés (jamais ignorés en silence). */
const RESERVED_KEYS = ['owner_id', 'user_id', 'project_id', 'status', 'server_use_allowed', 'requires_session'] as const;

const RULE_KEYS = ['only_if_tunnel_online', 'window', 'max_runs_per_day', 'skip_if_status_in', 'dedup_key', 'diff', 'alert_on'] as const;

const SHAPE: Shape = {
  format: true,
  format_version: true,
  min_runtime_version: true,
  exported_at: true,
  api: {
    slug: true,
    description: true,
    source_url: true,
    input_schema: true,
    output_schema: true,
    output_columns: true,
    views: { columns: true },
    purpose: true,
    legal_basis: true,
    contains_personal_data: true,
    max_cost_usd: true,
    budget_daily_usd: true,
    network_policy: { allow: true },
    alert_targets: [{ ref: true, events: true }],
  },
  strategy: { execution: true, network: true, spec: true, est_cost_usd: true },
  history: [{ version: true, execution: true, network: true, created_by: true, created_at: true }],
  schedules: [{ cron: true, timezone: true, input: true, rules: Object.fromEntries(RULE_KEYS.map((k) => [k, true])), overlap: true, missed: true, enabled: true }],
  fixtures: { items: true },
  integrity: { sha256: true },
};

/** Copie réduite aux champs connus ; `ignored` reçoit le chemin de chaque champ inconnu (`$.api.x`, `$.schedules[0].y`). */
function keepKnown(value: unknown, shape: Shape, path: string, ignored: string[]): unknown {
  if (shape === true) return value;
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return value;
    return value.map((v, i) => keepKnown(v, shape[0] as Shape, `${path}[${i}]`, ignored));
  }
  if (!isRecord(value)) return value;
  const known = shape as { readonly [key: string]: Shape };
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!Object.hasOwn(known, key)) {
      ignored.push(`${path}.${key}`);
      continue;
    }
    out[key] = keepKnown(v, known[key]!, `${path}.${key}`, ignored);
  }
  return out;
}

export type ApiImportErrorCode =
  | 'invalid_export'
  | 'unsupported_format'
  | 'runtime_too_old'
  | 'integrity_mismatch'
  | 'remote_ref'
  | 'invalid_schema'
  | 'invalid_strategy'
  | 'invalid_fixtures';

export type ApiImportCheck =
  | { readonly ok: true; readonly export: ApiExport; readonly ignored: readonly string[] }
  | { readonly ok: false; readonly code: ApiImportErrorCode; readonly message: string };

const fail = (code: ApiImportErrorCode, message: string): ApiImportCheck => ({ ok: false, code, message });

/** Erreur de schéma → code d'import : un `$ref` distant garde son code (INV1). */
function schemaFailure(error: unknown, what: string): ApiImportCheck {
  if (error instanceof SchemaError) return fail(error.code === 'remote_ref' ? 'remote_ref' : 'invalid_schema', `${what} : ${error.message}`);
  throw error;
}

/**
 * Relit un export reçu (fichier ou corps de `POST /api/apis/import`). Aucune I/O, aucune résolution de référence : un
 * `$ref` distant est refusé avant toute compilation. Le document rendu ne contient que les champs connus du format.
 */
export function parseApiExport(input: unknown, options: { readonly runtimeVersion: string }): ApiImportCheck {
  if (!isRecord(input)) return fail('invalid_export', 'objet JSON attendu');
  if (input['format'] !== API_EXPORT_FORMAT) return fail('unsupported_format', `format attendu : ${API_EXPORT_FORMAT}`);
  const version = input['format_version'];
  if (typeof version !== 'string' || !/^\d{1,3}\.\d{1,3}$/.test(version)) return fail('invalid_export', 'format_version : « majeure.mineure » attendue');
  if (!version.startsWith('1.')) return fail('unsupported_format', 'version de format non prise en charge (1.x attendue)');
  // Anti-affectation de masse (08b § 4, cas 4) : un champ d'identité ou d'état n'est pas « inconnu », il est refusé.
  for (const [where, node] of [['$', input], ['$.api', input['api']]] as const) {
    if (!isRecord(node)) continue;
    const reserved = RESERVED_KEYS.find((k) => Object.hasOwn(node, k));
    if (reserved !== undefined) return fail('invalid_export', `${where}.${reserved} : champ réservé (l'import ne choisit ni le propriétaire, ni le statut, ni la session)`);
  }
  const ignored: string[] = [];
  const known = keepKnown(input, SHAPE, '$', ignored);
  if (!validateEnvelope(known)) {
    const e = validateEnvelope.errors?.[0];
    return fail('invalid_export', `enveloppe invalide${e ? ` (${e.instancePath || '/'} ${e.message ?? ''})` : ''}`.trim());
  }
  const doc = known as ApiExport;
  if (parseSemver(options.runtimeVersion) !== undefined && compareSemver(options.runtimeVersion, doc.min_runtime_version) < 0) {
    return fail('runtime_too_old', `ce fichier exige un runtime ${doc.min_runtime_version} ou plus récent`);
  }
  if (exportIntegrity(doc) !== doc.integrity.sha256) return fail('integrity_mismatch', 'empreinte sha256 différente du contenu : fichier modifié ou incomplet');

  // INV5 : un fichier ne fait jamais passer l'API importée par le tunnel. Écarté APRÈS l'empreinte (portée par le fichier
  // tel qu'écrit), listé comme un champ ignoré pour que l'aperçu le montre.
  const allow = doc.api.network_policy?.allow;
  if (allow !== undefined) {
    allow.forEach((m, i) => {
      if (!(PORTABLE_NETWORKS as readonly string[]).includes(m)) ignored.push(`$.api.network_policy.allow[${i}]`);
    });
    doc.api = { ...doc.api, network_policy: { allow: portableNetworkAllow(allow) } };
  }

  const api = doc.api;
  let source: URL;
  try {
    source = new URL(api.source_url);
  } catch {
    return fail('invalid_export', 'api.source_url : URL absolue attendue');
  }
  if (source.username !== '' || source.password !== '') return fail('invalid_export', 'api.source_url : identifiants interdits dans l’URL');

  // INV1 : aucun `$ref` distant, nulle part (schémas, stratégie).
  for (const [what, node] of [['api.input_schema', api.input_schema], ['api.output_schema', api.output_schema], ['strategy.spec', doc.strategy?.spec ?? null]] as const) {
    const remote = findRemoteRefs(node);
    if (remote.length > 0) return fail('remote_ref', `${what} : référence distante refusée (${remote.slice(0, 3).join(', ')})`);
  }
  try {
    assertSchemaAcceptable(api.output_schema);
    compileSchema(api.output_schema);
  } catch (error) {
    return schemaFailure(error, 'api.output_schema');
  }
  try {
    assertInputSchema(api.input_schema);
  } catch (error) {
    return schemaFailure(error, 'api.input_schema');
  }

  if (doc.strategy !== null) {
    const spec = doc.strategy.spec;
    // Domaines de l'API (04b § 2, INV10) : la page de la demande et ses sous-domaines, jamais un voisin.
    const scope = siteScope(source.hostname.toLowerCase());
    if (doc.strategy.execution === 'agent_fetch') {
      // E4 : spécification d'agent_fetch, sans règles (références du propriétaire d'origine) ni champ de session.
      if (spec['kind'] !== 'agent_fetch' || spec['rules'] !== undefined) return fail('invalid_strategy', 'stratégie agent_fetch sans références de règles attendue');
      const agent = validateAgentFetchSpec(spec);
      if (!agent.ok) return fail('invalid_strategy', `stratégie refusée : ${agent.errors[0] ?? 'invalide'}`);
      if (!agent.spec.request.allowed_hosts.every((h) => withinSiteScope(h, scope))) return fail('invalid_strategy', 'stratégie refusée : hôte hors du site de la demande');
    } else {
      if (spec['kind'] !== 'declarative' || !sessionFree(spec)) return fail('invalid_strategy', 'stratégie déclarative sans session attendue');
      const checked = validateDeclarativeSpec(spec, { outputSchema: api.output_schema });
      if (!checked.ok) return fail('invalid_strategy', `stratégie refusée : ${checked.errors[0]?.code ?? 'invalide'} (${checked.errors[0]?.path ?? ''})`);
      if (!checked.spec.request.allowed_hosts.every((h) => withinSiteScope(h, scope))) return fail('invalid_strategy', 'stratégie refusée : hôte hors du site de la demande');
    }
  }

  for (const [i, item] of (doc.fixtures?.items ?? []).entries()) {
    const check = validateOutput(api.output_schema, item);
    if (!check.ok) return fail('invalid_fixtures', `fixtures.items[${i}] : hors du schéma de sortie`);
  }
  return { ok: true, export: doc, ignored };
}
