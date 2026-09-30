// SPDX-License-Identifier: AGPL-3.0-only
// Opérateurs de transformation : liste FERMÉE (04b § 2). Ajouter un opérateur = nouvelle `schema_version`.
// Aucune chaîne d'expression, aucune fonction utilisateur : un opérateur est un nom, plus des options validées ici.
import { DslError } from './errors.js';
import { assertBoundedRegex, regexExtract } from './regex.js';

export const OPERATOR_NAMES = [
  'trim',
  'lower',
  'upper',
  'collapse_spaces',
  'to_number',
  'to_integer',
  'to_boolean',
  'parse_date',
  'abs_url',
  'regex_extract',
  'default',
  'map_value',
  'join',
  'first',
  'count',
] as const;
export type OperatorName = (typeof OPERATOR_NAMES)[number];

const DATE_FORMATS = ['iso', 'epoch_s', 'epoch_ms', 'ymd', 'dmy', 'mdy'] as const;
type DateFormat = (typeof DATE_FORMATS)[number];

export type OperatorSpec = OperatorName | ({ op: OperatorName } & Record<string, unknown>);

export interface CompiledOperator {
  name: OperatorName;
  options: Record<string, unknown>;
}

const MAX_OPERATORS_PER_FIELD = 16;
const MAX_MAP_ENTRIES = 200;
const MAX_JOIN_SEPARATOR = 20;

const ALLOWED_OPTIONS: Record<OperatorName, readonly string[]> = {
  trim: [], lower: [], upper: [], collapse_spaces: [], to_boolean: [], first: [], count: [],
  to_number: ['decimal'],
  to_integer: ['decimal'],
  parse_date: ['format'],
  abs_url: ['base'],
  regex_extract: ['pattern', 'group'],
  default: ['value'],
  map_value: ['table', 'default'],
  join: ['separator'],
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isScalar = (v: unknown): v is string | number | boolean | null => v === null || ['string', 'number', 'boolean'].includes(typeof v);

function bad(code: 'unknown_operator' | 'invalid_spec', message: string): never {
  throw new DslError(code, message);
}

/** Valide la liste d'opérateurs d'un champ et la normalise. Lève `DslError` (opérateur inconnu, option invalide). */
export function compileOperators(ops: readonly unknown[] | undefined): CompiledOperator[] {
  if (ops === undefined) return [];
  if (!Array.isArray(ops)) bad('invalid_spec', 'ops : tableau attendu');
  if (ops.length > MAX_OPERATORS_PER_FIELD) bad('invalid_spec', `ops : plus de ${MAX_OPERATORS_PER_FIELD} opérateurs`);
  return ops.map((raw, index): CompiledOperator => {
    const spec: Record<string, unknown> | undefined = typeof raw === 'string' ? { op: raw } : isRecord(raw) ? raw : undefined;
    if (spec === undefined) bad('unknown_operator', `ops[${index}] : nom ou objet { op } attendu`);
    const name = spec['op'];
    if (typeof name !== 'string' || !(OPERATOR_NAMES as readonly string[]).includes(name)) {
      bad('unknown_operator', `ops[${index}] : opérateur inconnu (liste fermée)`);
    }
    const opName = name as OperatorName;
    const { op: _op, ...options } = spec;
    for (const key of Object.keys(options)) {
      if (!ALLOWED_OPTIONS[opName].includes(key)) bad('invalid_spec', `ops[${index}] (${opName}) : option inconnue « ${key} »`);
    }
    validateOptions(opName, options, index);
    return { name: opName, options };
  });
}

function validateOptions(name: OperatorName, o: Record<string, unknown>, index: number): void {
  const where = `ops[${index}] (${name})`;
  switch (name) {
    case 'to_number':
    case 'to_integer':
      if (o['decimal'] !== undefined && o['decimal'] !== '.' && o['decimal'] !== ',') bad('invalid_spec', `${where} : decimal vaut "." ou ","`);
      break;
    case 'parse_date':
      if (o['format'] !== undefined && !(DATE_FORMATS as readonly unknown[]).includes(o['format'])) bad('invalid_spec', `${where} : format hors liste (${DATE_FORMATS.join(', ')})`);
      break;
    case 'abs_url': {
      if (typeof o['base'] !== 'string') bad('invalid_spec', `${where} : base (URL http ou https) requise`);
      let url: URL;
      try {
        url = new URL(o['base']);
      } catch {
        bad('invalid_spec', `${where} : base invalide`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') bad('invalid_spec', `${where} : base http ou https seulement`);
      break;
    }
    case 'regex_extract': {
      if (typeof o['pattern'] !== 'string') bad('invalid_spec', `${where} : pattern requis`);
      assertBoundedRegex(o['pattern']);
      const g = o['group'];
      if (g !== undefined && (!Number.isInteger(g) || (g as number) < 0 || (g as number) > 9)) bad('invalid_spec', `${where} : group entier de 0 à 9`);
      break;
    }
    case 'default':
      if (!('value' in o) || !isScalar(o['value'])) bad('invalid_spec', `${where} : value scalaire requise`);
      break;
    case 'map_value': {
      const table = o['table'];
      if (!isRecord(table)) bad('invalid_spec', `${where} : table objet requise`);
      const entries = Object.entries(table);
      if (entries.length === 0 || entries.length > MAX_MAP_ENTRIES) bad('invalid_spec', `${where} : table de 1 à ${MAX_MAP_ENTRIES} entrées`);
      if (!entries.every(([, v]) => isScalar(v))) bad('invalid_spec', `${where} : valeurs scalaires seulement`);
      if (o['default'] !== undefined && !isScalar(o['default'])) bad('invalid_spec', `${where} : default scalaire`);
      break;
    }
    case 'join':
      if (o['separator'] !== undefined && (typeof o['separator'] !== 'string' || o['separator'].length > MAX_JOIN_SEPARATOR)) {
        bad('invalid_spec', `${where} : separator chaîne de ${MAX_JOIN_SEPARATOR} caractères au plus`);
      }
      break;
    default:
      break;
  }
}

function fail(name: OperatorName, why: string): never {
  throw new DslError('operator_failed', `opérateur ${name} : ${why}`);
}

function needString(name: OperatorName, v: unknown): string {
  if (typeof v !== 'string') fail(name, 'chaîne attendue');
  return v as string;
}

function toNumber(name: OperatorName, v: unknown, decimal: string): number {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail(name, 'nombre fini attendu');
    return v;
  }
  let s = needString(name, v).replace(/[\s\u00a0\u202f]/g, '').replace(/[€$£¥]|EUR|USD|GBP/gi, '');
  if (decimal === ',') s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(s)) fail(name, 'nombre non reconnu');
  const n = Number(s);
  if (!Number.isFinite(n)) fail(name, 'nombre hors limites');
  return n;
}

const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 'oui', 'vrai']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'non', 'faux']);

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function parseDate(v: unknown, format: DateFormat): string {
  const name: OperatorName = 'parse_date';
  if (format === 'epoch_s' || format === 'epoch_ms') {
    const n = typeof v === 'number' ? v : Number(needString(name, v).trim());
    if (!Number.isFinite(n)) fail(name, 'horodatage non reconnu');
    const d = new Date(format === 'epoch_s' ? n * 1000 : n);
    if (Number.isNaN(d.getTime())) fail(name, 'horodatage hors limites');
    return d.toISOString();
  }
  const s = needString(name, v).trim();
  if (format === 'iso') {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
    if (m === null) return fail(name, 'date ISO 8601 non reconnue');
    const [, y, mo, d, hh, mi, ss, zone] = m;
    if (!validYmd(Number(y), Number(mo), Number(d))) fail(name, 'date inexistante');
    if (hh === undefined) return `${y}-${mo}-${d}`;
    if (Number(hh) > 23 || Number(mi) > 59 || Number(ss ?? 0) > 59) fail(name, 'heure inexistante');
    if (zone === undefined) return `${y}-${mo}-${d}T${hh}:${mi}:${ss ?? '00'}`;
    const parsed = new Date(s.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    if (Number.isNaN(parsed.getTime())) fail(name, 'date non reconnue');
    return parsed.toISOString();
  }
  const pattern = format === 'ymd' ? /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/ : /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/;
  const m = pattern.exec(s);
  if (m === null) return fail(name, 'date non reconnue');
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const [y, mo, d] = format === 'ymd' ? [a, b, c] : format === 'dmy' ? [c, b, a] : [c, a, b];
  if (!validYmd(y, mo, d)) fail(name, 'date inexistante');
  return `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}`;
}

function absUrl(v: unknown, base: string): string {
  const s = needString('abs_url', v).trim();
  let url: URL;
  try {
    url = new URL(s, base);
  } catch {
    return fail('abs_url', 'URL non reconnue');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('abs_url', 'http ou https seulement');
  return url.href;
}

const isNil = (v: unknown): v is null | undefined => v === null || v === undefined;

function applyScalar(op: CompiledOperator, v: unknown): unknown {
  const o = op.options;
  switch (op.name) {
    case 'trim':
      return needString('trim', v).trim();
    case 'lower':
      return needString('lower', v).toLowerCase();
    case 'upper':
      return needString('upper', v).toUpperCase();
    case 'collapse_spaces':
      return needString('collapse_spaces', v).replace(/\s+/g, ' ').trim();
    case 'to_number':
      return toNumber('to_number', v, (o['decimal'] as string | undefined) ?? '.');
    case 'to_integer': {
      const n = toNumber('to_integer', v, (o['decimal'] as string | undefined) ?? '.');
      if (!Number.isInteger(n)) fail('to_integer', 'entier attendu');
      return n;
    }
    case 'to_boolean': {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number' && (v === 0 || v === 1)) return v === 1;
      const s = needString('to_boolean', v).trim().toLowerCase();
      if (TRUE_WORDS.has(s)) return true;
      if (FALSE_WORDS.has(s)) return false;
      return fail('to_boolean', 'booléen non reconnu');
    }
    case 'parse_date':
      return parseDate(v, (o['format'] as DateFormat | undefined) ?? 'iso');
    case 'abs_url':
      return absUrl(v, o['base'] as string);
    case 'regex_extract': {
      const hit = regexExtract(needString('regex_extract', v), o['pattern'] as string, (o['group'] as number | undefined) ?? 0);
      return hit === undefined ? fail('regex_extract', 'aucun appariement') : hit;
    }
    case 'map_value': {
      const key = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : fail('map_value', 'valeur scalaire attendue');
      const table = o['table'] as Record<string, unknown>;
      if (Object.hasOwn(table, key)) return table[key];
      if ('default' in o) return o['default'];
      return fail('map_value', 'valeur absente de la table');
    }
    default:
      return v;
  }
}

/** Applique la liste d'opérateurs à une valeur (un tableau est traité élément par élément, sauf `join`, `first`, `count`). */
export function applyOperators(ops: readonly CompiledOperator[], input: unknown): unknown {
  let value = input;
  for (const op of ops) {
    if (op.name === 'default') {
      if (isNil(value) || value === '') value = op.options['value'];
      continue;
    }
    if (op.name === 'count') {
      value = Array.isArray(value) ? value.length : isNil(value) ? 0 : 1;
      continue;
    }
    if (isNil(value)) continue; // valeur absente : seuls `default` et `count` agissent
    if (op.name === 'first') {
      value = Array.isArray(value) ? value[0] : value;
      continue;
    }
    if (op.name === 'join') {
      if (!Array.isArray(value)) fail('join', 'tableau attendu');
      const parts = (value as unknown[]).map((x) => (isScalar(x) && x !== null ? String(x) : fail('join', 'éléments scalaires attendus')));
      value = parts.join((op.options['separator'] as string | undefined) ?? ' ');
      continue;
    }
    value = Array.isArray(value) ? value.map((x) => applyScalar(op, x)) : applyScalar(op, value);
  }
  return value;
}
