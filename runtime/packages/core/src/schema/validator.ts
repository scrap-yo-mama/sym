// SPDX-License-Identifier: AGPL-3.0-only
// Validation des `input_schema` / `output_schema` fournis par l'utilisateur (INV1) : Ajv 8, JSON Schema 2020-12.
// Aucun `$ref` distant n'est jamais résolu : le refus a lieu avant toute compilation, donc sans aucune requête sortante.
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import type { UserJsonSchema } from '../model/types.js';

export const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

export type SchemaErrorCode = 'invalid_schema' | 'remote_ref' | 'schema_too_deep' | 'schema_too_large';

/** Erreur de schéma utilisateur : `code` stable, message sans valeur de données. */
export class SchemaError extends Error {
  readonly code: SchemaErrorCode;
  constructor(code: SchemaErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SchemaError';
    this.code = code;
  }
}

export interface SchemaLimits {
  /** Profondeur maximale d'imbrication du document schéma (objets et tableaux). */
  maxDepth: number;
  /** Taille maximale du schéma sérialisé en JSON, en octets. */
  maxBytes: number;
  /** Nombre maximal de noeuds (objets et tableaux) du schéma. */
  maxNodes: number;
}

export const DEFAULT_SCHEMA_LIMITS: SchemaLimits = { maxDepth: 32, maxBytes: 256 * 1024, maxNodes: 5_000 };

/** Nombre maximal d'erreurs rapportées par `validateOutput`. */
export const MAX_REPORTED_ERRORS = 20;
const CACHE_SIZE = 256;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Chemins des `$ref` / `$dynamicRef` qui ne sont pas un fragment local (`#...`). */
export function findRemoteRefs(schema: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > 256) {
      found.push(path); // trop profond pour être inspecté : refusé par prudence
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}/${i}`, depth + 1));
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if ((key === '$ref' || key === '$dynamicRef') && typeof value === 'string' && !value.startsWith('#')) found.push(`${path}/${key}`);
      walk(value, `${path}/${key}`, depth + 1);
    }
  };
  walk(schema, '#', 0);
  return found;
}

function measure(schema: unknown, limits: SchemaLimits): void {
  let nodes = 0;
  const walk = (node: unknown, depth: number): void => {
    if (depth > limits.maxDepth) throw new SchemaError('schema_too_deep', `schéma refusé : profondeur > ${limits.maxDepth}`);
    if (typeof node !== 'object' || node === null) return;
    nodes += 1;
    if (nodes > limits.maxNodes) throw new SchemaError('schema_too_large', `schéma refusé : plus de ${limits.maxNodes} noeuds`);
    for (const child of Array.isArray(node) ? node : Object.values(node)) walk(child, depth + 1);
  };
  walk(schema, 1);
}

/** Refus avant toute compilation : forme, taille, profondeur, `$ref` distant. Aucune requête réseau. */
export function assertSchemaAcceptable(schema: unknown, limits: SchemaLimits = DEFAULT_SCHEMA_LIMITS): asserts schema is UserJsonSchema {
  if (typeof schema !== 'boolean' && !isRecord(schema)) throw new SchemaError('invalid_schema', 'schéma refusé : objet ou booléen attendu');
  measure(schema, limits);
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(schema), 'utf8');
  } catch (cause) {
    throw new SchemaError('invalid_schema', 'schéma refusé : non sérialisable en JSON', { cause });
  }
  if (size > limits.maxBytes) throw new SchemaError('schema_too_large', `schéma refusé : ${size} octets > ${limits.maxBytes}`);
  const declared = isRecord(schema) ? schema['$schema'] : undefined;
  if (declared !== undefined && (typeof declared !== 'string' || declared.replace(/#$/, '') !== DRAFT_2020_12)) {
    throw new SchemaError('remote_ref', 'schéma refusé : seul JSON Schema 2020-12 est accepté ($schema)');
  }
  const remote = findRemoteRefs(schema);
  if (remote.length > 0) throw new SchemaError('remote_ref', `schéma refusé : référence distante non résolue (${remote.slice(0, 3).join(', ')})`);
}

// Aucun `loadSchema`, aucun chargement de méta-schéma externe. Formats non validés (ajv-formats hors stack).
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const cache = new Map<string, ValidateFunction>();

/** Compile (avec cache) un schéma utilisateur. Lève `SchemaError` ; ne fait jamais de requête réseau. */
export function compileSchema(schema: unknown, limits: SchemaLimits = DEFAULT_SCHEMA_LIMITS): ValidateFunction {
  assertSchemaAcceptable(schema, limits);
  const key = JSON.stringify(schema);
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit); // LRU
    return hit;
  }
  const copy = isRecord(schema) ? { ...schema } : schema;
  if (isRecord(copy)) delete copy['$schema']; // déjà vérifié : 2020-12
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(copy);
  } catch (cause) {
    throw new SchemaError('invalid_schema', `schéma invalide : ${cause instanceof Error ? cause.message : 'compilation impossible'}`, { cause });
  }
  cache.set(key, validate);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return validate;
}

/** Vide le cache de compilation (tests). */
export function clearSchemaCache(): void {
  cache.clear();
}

export interface ValidationIssue {
  /** Pointeur JSON vers la donnée fautive (`(racine)` si la racine). */
  path: string;
  keyword: string;
  /** Message lisible, sans valeur de donnée (les valeurs peuvent venir d'une page). */
  message: string;
}

export type ValidationResult = { ok: true } | { ok: false; errors: ValidationIssue[] };

function toIssue(e: ErrorObject): ValidationIssue {
  const path = e.instancePath === '' ? '(racine)' : e.instancePath;
  let message = e.message ?? 'invalide';
  const params = e.params as Record<string, unknown>;
  if (e.keyword === 'required') message = `propriété requise absente : ${String(params['missingProperty'])}`;
  else if (e.keyword === 'additionalProperties') message = `propriété non autorisée : ${String(params['additionalProperty'])}`;
  else if (e.keyword === 'type') message = `type attendu : ${Array.isArray(params['type']) ? params['type'].join(' | ') : String(params['type'])}`;
  else if (e.keyword === 'enum') message = 'valeur hors de la liste autorisée';
  return { path, keyword: e.keyword, message };
}

/** Validation FINALE d'une sortie contre le schéma d'origine (INV1). Lève `SchemaError` si le schéma est inacceptable. */
export function validateOutput(schema: unknown, data: unknown): ValidationResult {
  const validate = compileSchema(schema);
  if (validate(data)) return { ok: true };
  return { ok: false, errors: (validate.errors ?? []).slice(0, MAX_REPORTED_ERRORS).map(toIssue) };
}

/** Une erreur par ligne : `chemin : message`. */
export function formatIssues(errors: readonly ValidationIssue[]): string {
  return errors.map((e) => `${e.path} : ${e.message}`).join('\n');
}
