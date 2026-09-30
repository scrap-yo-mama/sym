// SPDX-License-Identifier: AGPL-3.0-only
// Schéma de transport dérivé du schéma utilisateur, extraction du JSON et validation Ajv finale (INV1, 08 §1).
import { findRemoteRefs } from '@runtime/core';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { LlmError } from './errors.js';
import type { JsonSchema } from './types.js';

type SchemaObject = { [keyword: string]: unknown };

const isRecord = (v: unknown): v is SchemaObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Contraintes que les modes stricts des fournisseurs refusent : déplacées en `description`. */
const MOVED_TO_DESCRIPTION = [
  'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'patternProperties', 'propertyNames', 'default', 'examples',
  'contains', 'minContains', 'maxContains', 'dependentRequired', 'not',
] as const;
const DROPPED = ['$schema', '$id', '$comment'];

/** Un `$ref` qui ne commence pas par `#` est distant : jamais résolu (08b, 03). */
export function assertNoRemoteRefs(schema: unknown): void {
  const [first] = findRemoteRefs(schema);
  if (first !== undefined) throw new LlmError('bad_request', `schéma refusé : $ref distant non résolu (${first})`, { code: 'remote_ref' });
}

function makeNullable(node: JsonSchema): JsonSchema {
  if (!isRecord(node)) return node;
  const type = node['type'];
  if (typeof type === 'string' && !('anyOf' in node)) {
    const out: SchemaObject = { ...node, type: type === 'null' ? 'null' : [type, 'null'] };
    if (Array.isArray(node['enum']) && !node['enum'].includes(null)) out['enum'] = [...node['enum'], null];
    return out;
  }
  if (Array.isArray(type)) {
    const out: SchemaObject = { ...node, type: type.includes('null') ? type : [...type, 'null'] };
    if (Array.isArray(node['enum']) && !node['enum'].includes(null)) out['enum'] = [...node['enum'], null];
    return out;
  }
  return { anyOf: [node, { type: 'null' }] };
}

function convert(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(convert);
  if (!isRecord(node)) return node;
  const out: SchemaObject = {};
  const moved: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (DROPPED.includes(key) || key.startsWith('x-')) continue;
    if ((MOVED_TO_DESCRIPTION as readonly string[]).includes(key)) {
      moved.push(`${key}=${JSON.stringify(value)}`);
      continue;
    }
    if (key === 'properties' && isRecord(value)) continue;
    if (key === 'oneOf') {
      out['anyOf'] = convert(value);
      continue;
    }
    if (key === 'additionalProperties') continue;
    if (key === 'required') continue;
    if (key === '$defs' || key === 'definitions') {
      out[key] = isRecord(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convert(v)])) : value;
      continue;
    }
    out[key] = convert(value);
  }
  if (isRecord(node['properties']) || node['type'] === 'object') {
    const props = isRecord(node['properties']) ? node['properties'] : {};
    const required = new Set(Array.isArray(node['required']) ? (node['required'] as string[]) : []);
    const converted: SchemaObject = {};
    for (const [name, child] of Object.entries(props)) {
      const c = convert(child) as JsonSchema;
      converted[name] = required.has(name) ? c : makeNullable(c);
    }
    out['properties'] = converted;
    out['required'] = Object.keys(converted);
    out['additionalProperties'] = false;
    if (out['type'] === undefined) out['type'] = 'object';
  }
  if (moved.length > 0) {
    const base = typeof out['description'] === 'string' ? `${out['description']} ` : '';
    out['description'] = `${base}(Constraints: ${moved.join('; ')})`;
  }
  return out;
}

/** Tout `required`, optionnels en nullable, `additionalProperties: false`, contraintes non supportées en `description`. */
export function toTransportSchema(schema: JsonSchema): JsonSchema {
  assertNoRemoteRefs(schema);
  return convert(schema) as JsonSchema;
}

/** Racine non objet : enveloppée (`{result: …}`) pour les modes stricts qui exigent un objet. */
export interface WrappedSchema {
  schema: JsonSchema;
  wrapped: boolean;
}

export const WRAP_KEY = 'result';

export function wrapRoot(transport: JsonSchema): WrappedSchema {
  if (isRecord(transport) && transport['type'] === 'object') return { schema: transport, wrapped: false };
  return {
    schema: { type: 'object', properties: { [WRAP_KEY]: transport }, required: [WRAP_KEY], additionalProperties: false },
    wrapped: true,
  };
}

function admitsNull(node: unknown): boolean {
  if (node === true) return true;
  if (!isRecord(node)) return false;
  if (Object.keys(node).length === 0) return true;
  const type = node['type'];
  if (type === 'null' || (Array.isArray(type) && type.includes('null'))) return true;
  if (Array.isArray(node['enum']) && node['enum'].includes(null)) return true;
  if ('const' in node && node['const'] === null) return true;
  for (const key of ['anyOf', 'oneOf']) {
    const variants = node[key];
    if (Array.isArray(variants) && variants.some(admitsNull)) return true;
  }
  return false;
}

function resolveLocalRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#')) return undefined;
  let cur: unknown = root;
  for (const part of ref.slice(1).split('/').filter(Boolean)) {
    if (!isRecord(cur)) return undefined;
    cur = cur[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return cur;
}

/**
 * Inverse du « optionnel => nullable » du schéma de transport : un `null` sur une propriété facultative que le schéma
 * d'origine n'admet pas à null est retiré. Guidé par le schéma d'origine ; les `anyOf` ne sont pas parcourus.
 */
export function restoreOptionals(value: unknown, schema: unknown, root: unknown = schema, depth = 0): unknown {
  if (depth > 64) return value;
  let node = schema;
  if (isRecord(node) && typeof node['$ref'] === 'string') node = resolveLocalRef(root, node['$ref']);
  if (!isRecord(node)) return value;
  if (Array.isArray(value)) {
    return isRecord(node['items']) ? value.map((v) => restoreOptionals(v, node['items'], root, depth + 1)) : value;
  }
  if (!isRecord(value)) return value;
  const props = isRecord(node['properties']) ? node['properties'] : {};
  const required = new Set(Array.isArray(node['required']) ? (node['required'] as string[]) : []);
  const out: SchemaObject = {};
  for (const [key, child] of Object.entries(value)) {
    const childSchema = props[key];
    if (child === null && childSchema !== undefined && !required.has(key) && !admitsNull(childSchema)) continue;
    out[key] = childSchema === undefined ? child : restoreOptionals(child, childSchema, root, depth + 1);
  }
  return out;
}

// Ajv 8, 2020-12. Aucun chargement distant (pas de `loadSchema`). Formats non validés (ajv-formats hors stack).
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const cache = new WeakMap<object, ValidateFunction>();

export interface ValidationFailure {
  ok: false;
  errors: string[];
}

/** Erreurs Ajv résumées sans valeurs (les valeurs peuvent venir d'une page). */
export function summarizeErrors(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).slice(0, 10).map((e) => `${e.instancePath === '' ? '(racine)' : e.instancePath} ${e.message ?? 'invalide'}`);
}

export function compileOriginal(schema: SchemaObject): ValidateFunction {
  const hit = cache.get(schema);
  if (hit !== undefined) return hit;
  assertNoRemoteRefs(schema);
  const copy: SchemaObject = { ...schema };
  delete copy['$schema']; // traité comme 2020-12
  try {
    const validate = ajv.compile(copy);
    cache.set(schema, validate);
    return validate;
  } catch (cause) {
    throw new LlmError('bad_request', 'schéma utilisateur invalide', { code: 'invalid_schema', cause });
  }
}

/** Validation FINALE contre le schéma d'origine (INV1). */
export function validateOriginal(schema: JsonSchema, value: unknown): { ok: true; value: unknown } | ValidationFailure {
  if (schema === true) return { ok: true, value };
  if (schema === false) return { ok: false, errors: ['schéma `false` : rien ne valide'] };
  const validate = compileOriginal(schema);
  const restored = restoreOptionals(value, schema);
  if (validate(restored)) return { ok: true, value: restored };
  return { ok: false, errors: summarizeErrors(validate) };
}

/** Extrait un JSON d'un texte (S4) : texte entier, bloc ```json, puis premier objet ou tableau équilibré. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const attempts: string[] = [trimmed];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1] !== undefined) attempts.push(fence[1].trim());
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* suivant */
    }
  }
  for (let start = 0; start < trimmed.length; start += 1) {
    const open = trimmed[start];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    for (let i = start; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new SyntaxError('aucun JSON exploitable dans le texte');
}
