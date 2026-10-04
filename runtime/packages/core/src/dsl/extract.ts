// SPDX-License-Identifier: AGPL-3.0-only
// Interpréteur d'extraction (04b § 2) : applique les `sources[]` dans l'ordre à UNE réponse, retient la première source conforme.
// Conforme = assez d'enregistrements, aucun champ requis manquant ou mal typé, et sortie valide contre `output_schema` (INV1) si fourni.
// Une source de repli retenue est un signal `escalated` (machine à états, transition 5).
import type { Document, Element } from 'domhandler';
import { decodeEmbedded } from './blobs.js';
import { elementAttribute, elementText, parseHtml, selectElements } from './css.js';
import { DslError, type DslErrorCode } from './errors.js';
import { queryValues } from './jsonpath.js';
import { assertResponseSize, Deadline, parseJsonBounded, resolveLimits, assertJsonWithinLimits, type DslLimits } from './limits.js';
import { applyOperators, compileOperators } from './operators.js';
import type { DeclarativeSpec, FieldLocator, FieldSpec, SourceSpec } from './spec.js';
import { validateOutput } from '../schema/validator.js';

/** Politique des enregistrements non conformes (voir `ExtractOptions.itemPolicy`). */
export type ItemPolicy = 'strict' | 'quarantine';

export interface ResponseInput {
  /** Corps de la réponse, déjà décodé en texte. */
  body: string;
}

export interface ExtractOptions {
  /** `output_schema` : schéma d'UN enregistrement. Sans lui, seuls les `type` et `required` des champs sont contrôlés. */
  outputSchema?: unknown;
  /**
   * `strict` (défaut, enquête : critère « ça marche ») : un enregistrement non conforme écarte la source. `quarantine`
   * (runs, D-49) : les problèmes par enregistrement ne bloquent la source que si AUCUN enregistrement n'est conforme, et
   * ce blocage ne sert qu'à choisir un repli : sans source conforme, les enregistrements de la première source qui en a
   * sont rendus (`ok`). L'exécuteur trie ensuite chaque item (Ajv) et met les non conformes en quarantaine, jamais livrés
   * (INV1) ; le seuil de casse se décide sur le run entier.
   */
  itemPolicy?: ItemPolicy;
  limits?: Partial<DslLimits>;
  now?: () => number;
}

export type ProblemCode = 'no_records' | 'too_few_records' | 'missing_required' | 'type_mismatch' | 'operator_failed' | 'schema_mismatch' | DslErrorCode;

export interface Problem {
  /** Indice de l'enregistrement, `null` pour un problème de source. */
  record: number | null;
  field?: string;
  code: ProblemCode;
  /** Sans valeur issue de la réponse. */
  message: string;
  /** Un problème bloquant écarte la source. */
  blocking: boolean;
}

export interface SourceAttempt {
  source_id: string;
  from: SourceSpec['from'];
  records: number;
  ok: boolean;
  problems: Problem[];
}

export interface ExtractResult {
  ok: boolean;
  records: Record<string, unknown>[];
  source_id: string | null;
  source_index: number;
  /** Une source autre que la première a été utilisée. */
  escalated: boolean;
  attempts: SourceAttempt[];
}

const MAX_PROBLEMS_PER_SOURCE = 50;

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function typeMatches(type: FieldSpec['type'], v: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v);
  }
}

function reduceValues(values: unknown[], field: FieldSpec): unknown {
  if (values.length === 0) return undefined;
  const mode = field.reduce ?? 'first';
  if (mode === 'all') return values;
  if (mode === 'join') return values.map((v) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '')).join(' ');
  return values[0];
}

interface Context {
  limits: DslLimits;
  deadline: Deadline;
  outputSchema: unknown;
  itemPolicy: ItemPolicy;
}

/** Valeurs d'un champ pour un enregistrement JSON : chemin principal, puis replis, première liste non vide. */
function jsonFieldValues(record: unknown, loc: FieldLocator, ctx: Context): unknown[] {
  for (const path of [loc.path, ...(loc.fallback_paths ?? [])]) {
    if (path === undefined) continue;
    const values = queryValues(path, record, ctx);
    if (values.length > 0) return values;
  }
  return [];
}

function htmlFieldValues(element: Element, loc: FieldLocator, ctx: Context): unknown[] {
  const attr = loc.attr ?? 'text';
  const read = (el: Element): string | undefined => (attr === 'text' ? elementText(el, ctx.limits.maxStringLength) : elementAttribute(el, attr));
  const selectors: (string | undefined)[] = [loc.css, ...(loc.fallback_paths ?? [])];
  if (loc.css === undefined) {
    const v = read(element); // pas de sélecteur : l'élément lui-même
    return v === undefined ? [] : [v];
  }
  // `up` : le sélecteur est cherché sous un ancêtre de l'enregistrement (titre du groupe), premier élément trouvé.
  let root: Element = element;
  for (let n = 0; n < (loc.up ?? 0); n += 1) {
    const parent = root.parent;
    if (parent === null || parent.type !== 'tag') return [];
    root = parent as Element;
  }
  for (const selector of selectors) {
    if (selector === undefined) continue;
    const all = selectElements(selector, root, ctx.limits.maxItems);
    const found = loc.up === undefined ? all : all.slice(0, 1);
    const values = found.map(read).filter((v): v is string => v !== undefined);
    if (values.length > 0) return values;
  }
  return [];
}

const compiledOps = new WeakMap<object, ReturnType<typeof compileOperators>>();
function opsOf(field: FieldSpec): ReturnType<typeof compileOperators> {
  let ops = compiledOps.get(field);
  if (ops === undefined) {
    ops = compileOperators(field.ops);
    compiledOps.set(field, ops);
  }
  return ops;
}

function buildRecord(
  spec: DeclarativeSpec,
  source: SourceSpec,
  root: unknown,
  index: number,
  ctx: Context,
  problems: Problem[],
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(spec.fields)) {
    const locator: FieldLocator = { ...field, ...(source.field_overrides?.[name] ?? {}) };
    const raw = source.from === 'html' ? htmlFieldValues(root as Element, locator, ctx) : jsonFieldValues(root, locator, ctx);
    const push = (code: ProblemCode, message: string): void => {
      if (problems.length < MAX_PROBLEMS_PER_SOURCE) problems.push({ record: index, field: name, code, message, blocking: field.required === true });
    };
    let value: unknown = reduceValues(raw, field);
    try {
      value = applyOperators(opsOf(field), value);
    } catch (error) {
      if (!(error instanceof DslError) || error.code !== 'operator_failed') throw error;
      push('operator_failed', `champ « ${name} » : ${error.message}`);
      continue;
    }
    if (value === undefined || value === null) {
      if (field.required === true) push('missing_required', `champ requis « ${name} » absent`);
      continue;
    }
    if (!typeMatches(field.type, value)) {
      push('type_mismatch', `champ « ${name} » : type ${field.type} attendu`);
      // Quarantaine (D-49) : un champ REQUIS mal typé garde sa valeur, pour que la raison du rejet soit `type` (et non
      // `required`) ; l'item sera écarté par Ajv, jamais livré. Un champ facultatif mal typé reste omis, comme à l'enquête.
      if (ctx.itemPolicy === 'quarantine' && field.required === true) setOwn(record, name, value);
      continue;
    }
    setOwn(record, name, value);
  }
  return record;
}

/** Une source : enregistrements et bilan. Un problème de source (chemin, blob, JSON) est décrit dans `problems`, pas levé. */
function runSource(spec: DeclarativeSpec, source: SourceSpec, cache: ParseCache, ctx: Context): { attempt: SourceAttempt; records: Record<string, unknown>[] } {
  const problems: Problem[] = [];
  const done = (records: Record<string, unknown>[]): { attempt: SourceAttempt; records: Record<string, unknown>[] } => {
    const minRecords = Math.max(1, spec.expect?.min_records ?? 1);
    if (records.length === 0) problems.push({ record: null, code: 'no_records', message: 'aucun enregistrement', blocking: true });
    else if (records.length < minRecords) problems.push({ record: null, code: 'too_few_records', message: `moins de ${minRecords} enregistrements`, blocking: true });
    if (ctx.itemPolicy === 'quarantine') relaxPerRecordProblems(ctx.outputSchema, records, problems);
    else if (ctx.outputSchema !== undefined && !problems.some((p) => p.blocking)) checkOutputSchema(ctx.outputSchema, records, problems);
    return { attempt: { source_id: source.id, from: source.from, records: records.length, ok: !problems.some((p) => p.blocking), problems }, records };
  };
  try {
    const roots: unknown[] =
      source.from === 'html'
        ? selectElements(source.records, cache.html(), ctx.limits.maxItems)
        : queryValues(source.records, source.from === 'response' ? cache.json() : cache.embedded(source), ctx);
    if (roots.length > ctx.limits.maxItems) throw new DslError('too_many_items', `plus de ${ctx.limits.maxItems} enregistrements`);
    const records: Record<string, unknown>[] = [];
    roots.forEach((root, i) => {
      ctx.deadline.check();
      records.push(buildRecord(spec, source, root, i, ctx, problems));
    });
    return done(records);
  } catch (error) {
    if (!(error instanceof DslError) || error.code === 'timeout' || error.code === 'response_too_large') throw error;
    problems.push({ record: null, code: error.code, message: error.message, blocking: true });
    return { attempt: { source_id: source.id, from: source.from, records: 0, ok: false, problems }, records: [] };
  }
}

/**
 * Politique `quarantine` (D-49) : les problèmes d'un enregistrement (champ requis absent ou mal typé, opérateur, sortie
 * hors schéma) ne bloquent la source que si AUCUN enregistrement n'est sain ; sinon ils restent décrits, non bloquants,
 * et l'exécuteur écarte ces items (quarantaine). Un problème de source (aucun enregistrement, trop peu) bloque toujours.
 */
function relaxPerRecordProblems(schema: unknown, records: Record<string, unknown>[], problems: Problem[]): void {
  if (problems.some((p) => p.blocking && p.record === null)) return;
  const bad = new Set(problems.filter((p) => p.blocking && p.record !== null).map((p) => p.record as number));
  if (schema !== undefined) {
    for (const [i, record] of records.entries()) {
      if (bad.has(i)) continue;
      const check = validateOutput(schema, record);
      if (check.ok) continue;
      bad.add(i);
      if (problems.length < MAX_PROBLEMS_PER_SOURCE) problems.push({ record: i, code: 'schema_mismatch', message: 'sortie hors output_schema', blocking: true });
    }
  }
  if (records.length > 0 && bad.size >= records.length) return;
  for (const p of problems) if (p.record !== null) p.blocking = false;
}

function checkOutputSchema(schema: unknown, records: Record<string, unknown>[], problems: Problem[]): void {
  for (const [i, record] of records.entries()) {
    const check = validateOutput(schema, record);
    if (check.ok) continue;
    const detail = check.errors.map((e) => `${e.path} : ${e.message}`).slice(0, 3).join(' ; ');
    problems.push({ record: i, code: 'schema_mismatch', message: `sortie hors output_schema (${detail})`, blocking: true });
    if (problems.length >= MAX_PROBLEMS_PER_SOURCE) break;
  }
}

class ParseCache {
  readonly #body: string;
  readonly #limits: DslLimits;
  #json: { value: unknown } | undefined;
  #html: Document | undefined;
  readonly #embedded = new Map<string, unknown>();

  constructor(body: string, limits: DslLimits) {
    this.#body = body;
    this.#limits = limits;
  }

  json(): unknown {
    this.#json ??= { value: parseJsonBounded(this.#body, this.#limits) };
    return this.#json.value;
  }

  html(): Document {
    this.#html ??= parseHtml(this.#body, this.#limits);
    return this.#html;
  }

  embedded(source: SourceSpec): unknown {
    const key = JSON.stringify(source.locator);
    if (!this.#embedded.has(key)) {
      if (source.locator === undefined) throw new DslError('invalid_spec', 'source embedded sans locator');
      const blob = decodeEmbedded(this.html(), source.locator, this.#limits);
      // Un blob décodé (Nuxt, Apollo) peut être un graphe partagé : sa taille développée est déjà bornée par le décodeur ;
      // on ne le reparcourt pas (un graphe partagé serait reparcouru en entier). Les blobs JSON purs sont déjà bornés à l'analyse.
      if (source.locator.kind === 'json_ld' || source.locator.kind === 'next_data' || source.locator.kind === 'script_id') assertJsonWithinLimits(blob, this.#limits);
      this.#embedded.set(key, blob);
    }
    return this.#embedded.get(key);
  }
}

/**
 * Extrait les enregistrements d'une réponse avec la stratégie déclarative.
 * Lève `DslError` pour un dépassement de limite globale (`response_too_large`, `timeout`) ; une source défaillante est décrite dans `attempts`.
 */
export function extractRecords(spec: DeclarativeSpec, response: ResponseInput, options: ExtractOptions = {}): ExtractResult {
  const limits = resolveLimits(spec.limits, options.limits);
  assertResponseSize(response.body, limits);
  const ctx: Context = { limits, deadline: new Deadline(limits.timeoutMs, options.now), outputSchema: options.outputSchema, itemPolicy: options.itemPolicy ?? 'strict' };
  const cache = new ParseCache(response.body, limits);
  const attempts: SourceAttempt[] = [];
  /** Quarantaine : première source qui a des enregistrements, tous non conformes (aucun problème de source). */
  let unsorted: { index: number; records: Record<string, unknown>[] } | undefined;
  for (const [index, source] of spec.sources.entries()) {
    const { attempt, records } = runSource(spec, source, cache, ctx);
    attempts.push(attempt);
    if (attempt.ok) return { ok: true, records, source_id: source.id, source_index: index, escalated: index > 0, attempts };
    if (ctx.itemPolicy === 'quarantine' && unsorted === undefined && records.length > 0 && !attempt.problems.some((p) => p.blocking && p.record === null)) unsorted = { index, records };
  }
  // Quarantaine (D-49) : le blocage d'une source ne sert qu'à choisir un repli. Si aucune source n'a d'item conforme sur
  // CETTE page, ses enregistrements sont rendus à l'exécuteur : le seuil de casse se décide sur le run entier (tri Ajv,
  // `rejectionVerdict` : 0 conforme sur tout le run casse toujours), jamais page par page.
  if (unsorted !== undefined) {
    const source = spec.sources[unsorted.index] as SourceSpec;
    return { ok: true, records: unsorted.records, source_id: source.id, source_index: unsorted.index, escalated: unsorted.index > 0, attempts };
  }
  return { ok: false, records: [], source_id: null, source_index: -1, escalated: false, attempts };
}
