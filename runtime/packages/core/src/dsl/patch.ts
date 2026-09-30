// Validation d'un patch de réparation RFC 6902 BORNÉ (04b § 2, 04 § 5) : `sources`, `fields`, `pagination` seulement.
// Tout chemin hors de ces trois racines est rejeté, en particulier `request.allowed_hosts`, `request.session` et `output_schema`
// (l'agent ne doit étendre seul ni le périmètre réseau, ni l'identité, ni assouplir le schéma de sortie).
// Le patch est appliqué à une COPIE ; le résultat est revalidé en entier (schéma, JSONPath, CSS, opérateurs, couverture des `required`).
import { createHash } from 'node:crypto';
import { jsonpatch, type JSONValue } from 'json-p3';
import type { JsonPatchOperation } from '../model/types.js';
import { validateDeclarativeSpec, type DeclarativeSpec, type SpecIssue } from './spec.js';

export const PATCHABLE_ROOTS = ['sources', 'fields', 'pagination'] as const;

interface PatchLimits {
  maxOperations: number;
  maxBytes: number;
  maxValueDepth: number;
  maxValueNodes: number;
  maxPathDepth: number;
}

const DEFAULT_PATCH_LIMITS: PatchLimits = { maxOperations: 20, maxBytes: 64 * 1024, maxValueDepth: 16, maxValueNodes: 2_000, maxPathDepth: 12 };

export type PatchRejectionCode =
  | 'invalid_patch'
  | 'too_many_operations'
  | 'patch_too_large'
  | 'forbidden_path'
  | 'forbidden_allowed_hosts'
  | 'forbidden_session'
  | 'forbidden_output_schema'
  | 'patch_not_applicable'
  | 'patched_spec_invalid'
  | 'protected_section_changed'
  | 'noop_patch';

export interface PatchRejection {
  /** Indice de l'opération fautive, `null` pour le patch entier. */
  index: number | null;
  code: PatchRejectionCode;
  message: string;
  /** Problèmes de la stratégie corrigée (`patched_spec_invalid`). */
  issues?: SpecIssue[];
}

export type PatchCheck = { ok: true; spec: DeclarativeSpec; operations: JsonPatchOperation[]; key: string } | { ok: false; rejections: PatchRejection[] };

export interface PatchOptions {
  outputSchema?: unknown;
  limits?: Partial<PatchLimits>;
}

const OPS = new Set(['add', 'remove', 'replace', 'move', 'copy', 'test']);
const OP_KEYS = new Set(['op', 'path', 'from', 'value']);
const POISON = new Set(['__proto__', 'constructor', 'prototype']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Segments d'un pointeur JSON (RFC 6901), ou `undefined` s'il est mal formé. */
function parsePointer(pointer: string): string[] | undefined {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) return undefined;
  const segments = pointer.slice(1).split('/');
  const out: string[] = [];
  for (const raw of segments) {
    if (/~(?![01])/.test(raw)) return undefined;
    out.push(raw.replace(/~1/g, '/').replace(/~0/g, '~'));
  }
  return out;
}

/** Représentation canonique (clés triées) : deux patchs identiques ont la même clé. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Empreinte d'un patch : sert à détecter « le même correctif proposé deux fois » (04 § 5, arrêt de la boucle). */
export function patchKey(operations: readonly JsonPatchOperation[]): string {
  return `sha256:${createHash('sha256').update(canonical(operations)).digest('hex')}`;
}

function valueWithin(value: unknown, limits: PatchLimits): boolean {
  let nodes = 0;
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop() as [unknown, number];
    if (typeof v !== 'object' || v === null) continue;
    nodes += 1;
    if (nodes > limits.maxValueNodes || depth > limits.maxValueDepth) return false;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, depth + 1]);
  }
  return true;
}

function checkPath(pointer: unknown, index: number, what: 'path' | 'from', limits: PatchLimits): PatchRejection | undefined {
  if (typeof pointer !== 'string') return { index, code: 'invalid_patch', message: `opération ${index} : ${what} (pointeur JSON) attendu` };
  const segments = parsePointer(pointer);
  if (segments === undefined) return { index, code: 'invalid_patch', message: `opération ${index} : ${what} n'est pas un pointeur JSON valide` };
  if (segments.length === 0 || segments.length > limits.maxPathDepth) return { index, code: 'forbidden_path', message: `opération ${index} : ${what} vise le document entier ou est trop profond` };
  if (segments.some((s) => POISON.has(s))) return { index, code: 'forbidden_path', message: `opération ${index} : segment interdit dans ${what}` };
  const root = segments[0] as string;
  if ((PATCHABLE_ROOTS as readonly string[]).includes(root)) return undefined;
  if (root === 'request') {
    const sub = segments[1];
    if (sub === 'allowed_hosts') return { index, code: 'forbidden_allowed_hosts', message: `opération ${index} : request.allowed_hosts ne peut pas être modifié par une réparation` };
    if (sub === 'session') return { index, code: 'forbidden_session', message: `opération ${index} : request.session ne peut pas être modifié par une réparation` };
  }
  if (root === 'output_schema') return { index, code: 'forbidden_output_schema', message: `opération ${index} : output_schema ne peut pas être modifié par une réparation` };
  return { index, code: 'forbidden_path', message: `opération ${index} : ${what} hors de sources, fields, pagination` };
}

/** Structure et chemins du patch, sans l'appliquer. */
function checkPatchShape(patch: unknown, limits: PatchLimits = DEFAULT_PATCH_LIMITS): PatchRejection[] {
  if (!Array.isArray(patch) || patch.length === 0) return [{ index: null, code: 'invalid_patch', message: 'patch : tableau non vide attendu' }];
  if (patch.length > limits.maxOperations) return [{ index: null, code: 'too_many_operations', message: `patch : plus de ${limits.maxOperations} opérations` }];
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(patch), 'utf8');
  } catch {
    return [{ index: null, code: 'invalid_patch', message: 'patch : non sérialisable en JSON' }];
  }
  if (size > limits.maxBytes) return [{ index: null, code: 'patch_too_large', message: `patch : plus de ${limits.maxBytes} octets` }];
  const rejections: PatchRejection[] = [];
  for (const [i, op] of (patch as unknown[]).entries()) {
    if (!isRecord(op) || typeof op['op'] !== 'string' || !OPS.has(op['op'])) {
      rejections.push({ index: i, code: 'invalid_patch', message: `opération ${i} : op parmi add, remove, replace, move, copy, test` });
      continue;
    }
    const extra = Object.keys(op).find((k) => !OP_KEYS.has(k));
    if (extra !== undefined) rejections.push({ index: i, code: 'invalid_patch', message: `opération ${i} : propriété « ${extra} » inconnue` });
    const bad = checkPath(op['path'], i, 'path', limits);
    if (bad !== undefined) rejections.push(bad);
    if (op['op'] === 'move' || op['op'] === 'copy') {
      const badFrom = checkPath(op['from'], i, 'from', limits);
      if (badFrom !== undefined) rejections.push(badFrom);
    } else if ('from' in op) {
      rejections.push({ index: i, code: 'invalid_patch', message: `opération ${i} : from ne vaut que pour move et copy` });
    }
    if (op['op'] === 'add' || op['op'] === 'replace' || op['op'] === 'test') {
      if (!('value' in op) || op['value'] === undefined) rejections.push({ index: i, code: 'invalid_patch', message: `opération ${i} : value requise` });
      else if (!valueWithin(op['value'], limits)) rejections.push({ index: i, code: 'patch_too_large', message: `opération ${i} : value trop profonde ou trop grosse` });
    } else if ('value' in op) {
      rejections.push({ index: i, code: 'invalid_patch', message: `opération ${i} : value ne vaut pas pour ${op['op']}` });
    }
  }
  return rejections;
}

const PROTECTED: (keyof DeclarativeSpec)[] = ['schema_version', 'kind', 'request', 'steps', 'expect', 'limits'];

/**
 * Valide un patch de réparation contre la stratégie courante. Succès : la stratégie corrigée (copie), validée en entier.
 * Échec : les rejets, sans effet de bord sur `current`.
 */
export function validateRepairPatch(current: DeclarativeSpec, patch: unknown, options: PatchOptions = {}): PatchCheck {
  const limits: PatchLimits = { ...DEFAULT_PATCH_LIMITS, ...options.limits };
  const shape = checkPatchShape(patch, limits);
  if (shape.length > 0) return { ok: false, rejections: shape };
  const operations = patch as JsonPatchOperation[];

  let patched: DeclarativeSpec;
  try {
    const copy = structuredClone(current) as unknown as JSONValue;
    patched = jsonpatch.apply(operations as unknown as jsonpatch.OpObject[], copy) as unknown as DeclarativeSpec;
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 200) : 'erreur inconnue';
    return { ok: false, rejections: [{ index: null, code: 'patch_not_applicable', message: `patch inapplicable : ${reason}` }] };
  }

  for (const key of PROTECTED) {
    if (canonical((patched as unknown as Record<string, unknown>)[key]) !== canonical((current as unknown as Record<string, unknown>)[key])) {
      return { ok: false, rejections: [{ index: null, code: 'protected_section_changed', message: `la section « ${key} » a changé : interdit` }] };
    }
  }
  if (canonical(patched) === canonical(current)) return { ok: false, rejections: [{ index: null, code: 'noop_patch', message: 'le patch ne change rien' }] };

  const check = validateDeclarativeSpec(patched, options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema });
  if (!check.ok) return { ok: false, rejections: [{ index: null, code: 'patched_spec_invalid', message: 'la stratégie corrigée est invalide', issues: check.errors }] };
  return { ok: true, spec: check.spec, operations, key: patchKey(operations) };
}
