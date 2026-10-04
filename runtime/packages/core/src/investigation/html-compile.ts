// SPDX-License-Identifier: AGPL-3.0-only
// Compilation d'un essai E4 (`agent_fetch`) conforme en stratégie déclarative à source `html` (constat UX-20, 04b §2,
// 19 §1 « Rejeu E1-E3 : 0 LLM ») : un essai E4 rappelle le LLM à chaque rejeu ; une page HTML statique se rejoue sans lui
// par sélecteurs CSS. Partie PURE (sans I/O) :
// - `condenseHtml` : le HTML capturé, épuré (ni script, ni style, ni commentaire, ni jeton d'URL) et borné, pour le prompt,
//   où il reste une DONNÉE NON FIABLE (balises à jeton posées par l'appelant, packages/agent) ;
// - `HTML_COMPILE_PROPOSAL_SCHEMA` : la réponse fermée du LLM (sélecteur de l'élément répété, par champ un sélecteur, un
//   attribut et des opérateurs de la liste fermée) ; aucune URL, aucun code, aucun hôte ;
// - `htmlCompileSupport` : types du schéma compilables (scalaires, tableaux de scalaires), vérifiés AVANT tout appel au
//   LLM (constat UX-31 : une compilation impossible n'est jamais payée) ;
// - `buildHtmlStrategy` : le CODE construit la stratégie (requête GET de la page de l'essai, `allowed_hosts` de l'essai,
//   `abs_url` toujours basé sur la page, ancres `^`/`$` retirées des motifs : la recherche I-Regexp n'est pas ancrée ; un
//   champ tableau lit TOUS les éléments de son sélecteur), validée par `validateDeclarativeSpec` (INV10, liste fermée) ;
// - `alignHtmlStrategy` : un champ entier, nombre ou booléen écrit en MOT sur la page (« Three », « In stock ») reçoit une
//   table `map_value` déduite par le CODE des éléments de l'agent, jamais proposée par le modèle (constat UX-30) ;
// - `verifyHtmlStrategy` : l'interpréteur rejoue la stratégie sur le MÊME HTML, sans LLM ; acceptée si elle rend autant
//   d'éléments que l'agent (±0), au moins 95 % de valeurs égales après normalisation des espaces, et une sortie valide
//   contre le schéma d'origine (INV1). Un refus porte toujours son différentiel par champ (valeurs, motifs), lu par la
//   nouvelle tentative (constat UX-30 : « extraction, ratio 0 » sans détail).
// L'agent E4 ne pagine pas (une page par exécution) : la stratégie compilée ne pagine pas non plus.
import { Parser } from 'htmlparser2';
import { extractRecords, type ExtractResult } from '../dsl/extract.js';
import { validateDeclarativeSpec, type DeclarativeSpec } from '../dsl/spec.js';
import { validateOutput } from '../schema/validator.js';

/** Part minimale des valeurs de champs égales à celles de l'agent (après normalisation des espaces). */
export const HTML_COMPILE_MIN_MATCH = 0.95;
/** Propositions au plus : la première, puis UNE nouvelle tentative avec le différentiel. */
export const HTML_COMPILE_MAX_PROPOSALS = 2;
/** Opérateurs que le LLM peut demander (sous-ensemble de la liste fermée de 04b §2 ; ni `default` ni `map_value` : aucune valeur fournie par le modèle). */
export const HTML_COMPILE_OPERATORS = ['trim', 'lower', 'upper', 'collapse_spaces', 'to_number', 'to_integer', 'to_boolean', 'parse_date', 'abs_url', 'regex_extract'] as const;
const DATE_FORMATS = ['iso', 'epoch_s', 'epoch_ms', 'ymd', 'dmy', 'mdy'] as const;
const FIELD_NAME = '^[a-z][a-z0-9_]{0,63}$';
const ATTR = '^(text|[A-Za-z_:][A-Za-z0-9_:.-]{0,63})$';

/** Réponse structurée du LLM (toutes les propriétés requises, `null` pour l'absence : sortie stricte S1). */
export const HTML_COMPILE_PROPOSAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['records', 'fields'],
  properties: {
    records: { type: 'string', minLength: 1, maxLength: 300 },
    fields: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'css', 'attr', 'ops'],
        properties: {
          field: { type: 'string', pattern: FIELD_NAME },
          css: { type: ['string', 'null'], maxLength: 300 },
          attr: { type: ['string', 'null'], pattern: ATTR },
          ops: {
            type: 'array',
            maxItems: 4,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['op', 'pattern', 'group', 'decimal', 'format'],
              properties: {
                op: { enum: [...HTML_COMPILE_OPERATORS] },
                pattern: { type: ['string', 'null'], maxLength: 200 },
                group: { type: ['integer', 'null'], minimum: 0, maximum: 9 },
                decimal: { enum: ['.', ',', null] },
                format: { enum: [...DATE_FORMATS, null] },
              },
            },
          },
        },
      },
    },
  },
} as const;

export type HtmlCompileOp = { readonly op: string; readonly pattern: string | null; readonly group: number | null; readonly decimal: '.' | ',' | null; readonly format: string | null };
export type HtmlCompileField = { readonly field: string; readonly css: string | null; readonly attr: string | null; readonly ops: readonly HtmlCompileOp[] };
export type HtmlCompileProposal = { readonly records: string; readonly fields: readonly HtmlCompileField[] };

/** Lecture défensive de la réponse (déjà validée par la couche LLM contre `HTML_COMPILE_PROPOSAL_SCHEMA`). */
export function parseHtmlCompileProposal(value: unknown): HtmlCompileProposal | null {
  const v = value as Partial<HtmlCompileProposal> | null;
  if (v === null || typeof v !== 'object' || typeof v.records !== 'string' || !Array.isArray(v.fields)) return null;
  return v as HtmlCompileProposal;
}

// ---------------------------------------------------------------------------------------------------- HTML épuré

/** Éléments dont tout le contenu est retiré (code, styles, médias embarqués, en-tête du document). */
const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'head', 'svg', 'math', 'iframe', 'object', 'embed', 'canvas']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** Attributs utiles à un sélecteur ou à une valeur ; tout autre attribut (style, événements…) est retiré. */
const KEPT_ATTRS = new Set(['id', 'class', 'href', 'src', 'alt', 'title', 'datetime', 'content', 'itemprop', 'itemtype', 'rel', 'role', 'aria-label', 'hidden', 'aria-hidden', 'name', 'value', 'type', 'lang']);
const MAX_ATTR_CHARS = 120;

const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string): string => escapeText(s).replace(/"/g, '&quot;');
/** Lien réduit à son chemin : ni requête, ni fragment (jetons d'URL, 08 §4 mesure 5). */
const linkPath = (s: string): string => s.split(/[?#]/, 1)[0] ?? '';

export type CondensedHtml = { readonly html: string; readonly truncated: boolean };

/**
 * HTML capturé, épuré pour le prompt de compilation : balises et texte visibles, attributs utiles aux sélecteurs (`class`,
 * `id`, `data-*`…), liens réduits à leur chemin, espaces normalisés ; ni script, ni style, ni commentaire. Borné à
 * `maxChars` caractères (limite d'entrée de l'essai E4). `mapText` : masquage appliqué à chaque texte et valeur d'attribut.
 */
export function condenseHtml(html: string, options: { readonly maxChars: number; readonly mapText?: (text: string) => string }): CondensedHtml {
  const map = options.mapText ?? ((s: string) => s);
  const out: string[] = [];
  let size = 0;
  let truncated = false;
  let skipDepth = 0;
  const push = (s: string) => {
    if (truncated) return;
    if (size + s.length > options.maxChars) {
      truncated = true;
      return;
    }
    out.push(s);
    size += s.length;
  };
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (skipDepth > 0) {
          if (!VOID.has(name)) skipDepth += 1;
          return;
        }
        if (SKIPPED.has(name)) {
          if (!VOID.has(name)) skipDepth = 1;
          return;
        }
        const kept: string[] = [];
        for (const [key, raw] of Object.entries(attrs)) {
          if (!KEPT_ATTRS.has(key) && !/^data-[a-z0-9_-]{1,40}$/.test(key)) continue;
          let value = key === 'href' || key === 'src' ? linkPath(raw) : raw;
          value = map(value.replace(/\s+/g, ' ').trim()).slice(0, MAX_ATTR_CHARS);
          kept.push(value === '' && (key === 'hidden' || key === 'class') ? (key === 'hidden' ? ' hidden' : '') : ` ${key}="${escapeAttr(value)}"`);
        }
        push(`<${name}${kept.join('')}>`);
      },
      ontext(text) {
        if (skipDepth > 0) return;
        const clean = text.replace(/\s+/g, ' ');
        if (clean.trim() === '') return;
        push(escapeText(map(clean)));
      },
      onclosetag(name) {
        if (skipDepth > 0) {
          if (!VOID.has(name)) skipDepth -= 1;
          return;
        }
        if (SKIPPED.has(name) || VOID.has(name)) return;
        push(`</${name}>`);
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  return { html: out.join(''), truncated };
}

// ---------------------------------------------------------------------------------------------------- construction

export type HtmlStrategyBuild =
  | { readonly ok: true; readonly spec: DeclarativeSpec }
  | { readonly ok: false; readonly reason: 'operator_not_allowed' | 'unsupported_field_type' | 'invalid_spec'; readonly codes: readonly string[] };

const SCALARS = new Set(['string', 'number', 'integer', 'boolean']);

/** Type JSON Schema d'une propriété (premier type non nul d'une union), ou `null`. */
function typeOf(prop: unknown): string | null {
  const t = (prop as { type?: unknown } | null)?.type;
  const one = Array.isArray(t) ? t.find((x) => x !== 'null') : t;
  return typeof one === 'string' ? one : null;
}

type HtmlFieldType = { readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'array'; readonly required: boolean };

/** Champs du schéma lus par la compilation : scalaires et tableaux de scalaires ; `null` pour un type non compilable. */
function htmlFieldTypes(schema: unknown): Map<string, HtmlFieldType | null> {
  const s = schema as { properties?: Record<string, unknown>; required?: unknown } | null;
  const required = new Set(Array.isArray(s?.required) ? s.required.filter((r): r is string => typeof r === 'string') : []);
  const out = new Map<string, HtmlFieldType | null>();
  for (const [name, prop] of Object.entries(s?.properties ?? {})) {
    const t = typeOf(prop) ?? 'string';
    if (SCALARS.has(t)) out.set(name, { type: t as HtmlFieldType['type'], required: required.has(name) });
    else if (t === 'array' && SCALARS.has(typeOf((prop as { items?: unknown }).items) ?? 'string')) out.set(name, { type: 'array', required: required.has(name) });
    else out.set(name, null);
  }
  return out;
}

/**
 * Types du schéma de sortie compilables en déclaratif `html` : scalaires (chaîne, nombre, entier, booléen) et tableaux de
 * scalaires (un sélecteur multiple). Vérifié AVANT tout appel au LLM (constat UX-31) ; sinon, les champs en cause.
 */
export function htmlCompileSupport(outputSchema: unknown): { readonly ok: true } | { readonly ok: false; readonly fields: readonly string[] } {
  const fields = [...htmlFieldTypes(outputSchema).entries()].filter(([, t]) => t === null).map(([name]) => name);
  return fields.length === 0 ? { ok: true } : { ok: false, fields };
}

/**
 * Motif proposé, sans ancre : la recherche I-Regexp n'est pas ancrée et `^`, `$` y sont des caractères littéraux ; un
 * modèle qui les écrit veut une ancre (constat UX-30, `^(.{0,20}).*$` : « aucun appariement »). Les retirer élargit la
 * recherche ; la vérification sans LLM juge le résultat.
 */
const unanchored = (pattern: string): string => pattern.replace(/^\^/, '').replace(/(?<!\\)\$$/, '');

function operatorSpec(o: HtmlCompileOp, pageUrl: string): string | Record<string, unknown> | null {
  if (!(HTML_COMPILE_OPERATORS as readonly string[]).includes(o.op)) return null;
  switch (o.op) {
    case 'abs_url':
      // Base fixée par le code : la page de l'essai (aucune URL ne vient du modèle).
      return { op: 'abs_url', base: pageUrl };
    case 'regex_extract':
      return { op: 'regex_extract', pattern: unanchored(o.pattern ?? ''), ...(o.group === null ? {} : { group: o.group }) };
    case 'to_number':
    case 'to_integer':
      return o.decimal === null ? o.op : { op: o.op, decimal: o.decimal };
    case 'parse_date':
      return o.format === null ? o.op : { op: o.op, format: o.format };
    default:
      return o.op;
  }
}

/**
 * Stratégie déclarative à source `html` construite par le code depuis la proposition : requête GET de la page de l'essai
 * E4 (`pageUrl`, `allowedHosts` de sa spec), une source `html`, un champ par propriété du schéma d'origine (type et
 * `required` repris du schéma ; un tableau de scalaires lit tous les éléments de son sélecteur, `reduce: all`, opérateurs
 * appliqués à chacun). Chaque texte lu est d'abord normalisé (`collapse_spaces`). Validée par `validateDeclarativeSpec`
 * (sélecteurs compilés, opérateurs, hôte dans `allowed_hosts`, couverture des `required`) ; les codes de refus portent
 * le champ en cause (`invalid_regex@/fields/nom/ops/1`), lus par la nouvelle tentative.
 */
export function buildHtmlStrategy(proposal: HtmlCompileProposal, context: { readonly pageUrl: string; readonly allowedHosts: readonly string[]; readonly outputSchema: unknown }): HtmlStrategyBuild {
  const support = htmlCompileSupport(context.outputSchema);
  if (!support.ok) return { ok: false, reason: 'unsupported_field_type', codes: support.fields };
  const types = htmlFieldTypes(context.outputSchema);
  const fields: Record<string, unknown> = {};
  for (const [name, t] of types) {
    const proposed = proposal.fields.find((f) => f.field === name);
    if (proposed === undefined || t === null) continue;
    const ops: (string | Record<string, unknown>)[] = [];
    for (const o of proposed.ops) {
      const spec = operatorSpec(o, context.pageUrl);
      if (spec === null) return { ok: false, reason: 'operator_not_allowed', codes: [String(o.op)] };
      ops.push(spec);
    }
    if (ops[0] !== 'collapse_spaces') ops.unshift('collapse_spaces');
    const css = proposed.css === null || proposed.css.trim() === '' ? undefined : proposed.css;
    fields[name] = {
      ...(css === undefined ? {} : { css }),
      ...(proposed.attr === null ? {} : { attr: proposed.attr }),
      type: t.type,
      ...(t.type === 'array' ? { reduce: 'all' } : {}),
      ...(t.required ? { required: true } : {}),
      ops,
    };
  }
  const raw = {
    schema_version: 1,
    kind: 'declarative',
    request: { method: 'GET', url: context.pageUrl, allowed_hosts: [...context.allowedHosts] },
    sources: [{ id: 'page', from: 'html', records: proposal.records }],
    fields,
    limits: { max_response_bytes: 5_000_000, timeout_ms: 15_000 },
  };
  if (Object.keys(fields).length === 0) return { ok: false, reason: 'invalid_spec', codes: ['no_fields'] };
  const check = validateDeclarativeSpec(raw, { outputSchema: context.outputSchema });
  if (!check.ok) return { ok: false, reason: 'invalid_spec', codes: [...new Set(check.errors.map((e) => (/^\/(fields|sources)\//.test(e.path) ? `${e.code}@${e.path}` : e.code)))].slice(0, 10) };
  return { ok: true, spec: check.spec };
}

// ---------------------------------------------------------------------------------------------------- alignement

/** Opérateurs de conversion d'un texte : la table d'un champ remplace celui qui échoue (et ce qui le suit). */
const CONVERSIONS = new Set(['to_number', 'to_integer', 'to_boolean', 'parse_date']);
/** Entrées d'une table au plus ; une table n'a jamais plus d'une entrée pour deux éléments (sinon elle recopierait les valeurs). */
const MAX_MAP_ENTRIES = 50;
const MAX_MAP_KEY = 200;
const opName = (o: unknown): string => (typeof o === 'string' ? o : String((o as { op?: unknown } | null)?.op ?? ''));

function matchesType(type: string, v: unknown): boolean {
  if (type === 'integer') return typeof v === 'number' && Number.isInteger(v);
  if (type === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (type === 'boolean') return typeof v === 'boolean';
  return false;
}

function quarantined(spec: DeclarativeSpec, html: string, outputSchema: unknown): ExtractResult | null {
  try {
    return extractRecords(spec, { body: html }, { outputSchema, itemPolicy: 'quarantine' });
  } catch {
    return null;
  }
}

/**
 * Tables de correspondance déduites par le CODE (constat UX-30) : un champ entier, nombre ou booléen dont la conversion
 * échoue sur la page (note « Three », disponibilité « In stock ») est relu en texte (opérateurs d'avant la conversion), puis
 * reçoit `map_value` : texte lu → valeur rendue par l'agent pour le même élément. Aucune valeur ne vient du modèle. La
 * table n'est posée que si chaque texte a une seule valeur, que chaque élément de l'agent est couvert, et qu'elle compte au
 * plus une entrée pour deux éléments (une note, un état ; jamais une table qui recopierait les prix). Sinon le champ reste
 * tel quel et la vérification dit pourquoi. Le résultat est revalidé (liste fermée) ; la vérification sans LLM décide.
 */
export function alignHtmlStrategy(spec: DeclarativeSpec, html: string, expected: readonly unknown[], outputSchema: unknown): DeclarativeSpec {
  const first = quarantined(spec, html, outputSchema);
  if (first === null || !first.ok || first.records.length !== expected.length || expected.length === 0) return spec;
  const failing = new Set(
    (first.attempts[first.source_index]?.problems ?? []).filter((p) => p.field !== undefined && (p.code === 'type_mismatch' || p.code === 'operator_failed')).map((p) => p.field as string),
  );
  let fields = spec.fields;
  for (const name of failing) {
    const field = spec.fields[name];
    if (field === undefined || !['integer', 'number', 'boolean'].includes(field.type)) continue;
    const ops = field.ops ?? [];
    const cut = ops.findIndex((o) => CONVERSIONS.has(opName(o)));
    const textOps = cut === -1 ? [...ops] : ops.slice(0, cut);
    const probe = quarantined({ ...spec, fields: { ...spec.fields, [name]: { ...field, type: 'string', required: false, ops: textOps } } }, html, undefined);
    if (probe === null || !probe.ok || probe.records.length !== expected.length) continue;
    const table = new Map<string, unknown>();
    let usable = true;
    for (const [i, record] of probe.records.entries()) {
      const want = (expected[i] as Record<string, unknown> | undefined)?.[name];
      if (want === undefined || want === null) continue;
      const text = record[name];
      if (typeof text !== 'string' || text === '' || text.length > MAX_MAP_KEY || !matchesType(field.type, want) || (table.has(text) && table.get(text) !== want)) {
        usable = false;
        break;
      }
      table.set(text, want);
    }
    if (!usable || table.size === 0 || table.size > MAX_MAP_ENTRIES || table.size > Math.max(1, Math.floor(expected.length / 2))) continue;
    fields = { ...fields, [name]: { ...field, ops: [...textOps, { op: 'map_value', table: Object.fromEntries(table) }] } };
  }
  if (fields === spec.fields) return spec;
  const check = validateDeclarativeSpec({ ...spec, fields }, { outputSchema });
  return check.ok ? check.spec : spec;
}

// ---------------------------------------------------------------------------------------------------- vérification

export type HtmlMismatch = { readonly index: number; readonly field: string; readonly expected: unknown; readonly got: unknown };
/** Motif d'extraction par champ (code de l'interpréteur, nombre d'éléments touchés) : jamais de valeur. */
export type HtmlProblem = { readonly field: string | null; readonly code: string; readonly records: number };
export type HtmlDiff = {
  /** Éléments rendus par l'agent, puis par la stratégie. */
  readonly expected: number;
  readonly got: number;
  /** Valeurs comparées (au moins un côté présent) et valeurs égales ; `ratio` = égales / comparées. */
  readonly compared: number;
  readonly matched: number;
  readonly ratio: number;
  /** Premières différences (au plus 10) : valeurs de la page, DONNÉES NON FIABLES, jamais journalisées. */
  readonly mismatches: readonly HtmlMismatch[];
  /** Motifs de l'interpréteur par champ (au plus 10), en mode strict : opérateur en échec, type, champ requis absent… */
  readonly problems: readonly HtmlProblem[];
  /** Raison du refus (code stable), `null` si la stratégie est acceptée. */
  readonly reason: 'extraction' | 'schema' | 'count' | 'values' | null;
};
export type HtmlVerification = { readonly ok: boolean; readonly records: readonly Record<string, unknown>[]; readonly diff: HtmlDiff };

const MAX_MISMATCHES = 10;

/** Valeur comparable : espaces normalisés, nombre et booléen en texte ; absence = `null`. */
function normalized(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? null : JSON.stringify(value.map((v) => normalized(v)));
  return JSON.stringify(value);
}

/** Motifs du mode strict regroupés par champ et code (au plus 10), sans valeur. */
function problemSummary(result: ExtractResult): HtmlProblem[] {
  const counts = new Map<string, HtmlProblem>();
  for (const p of result.attempts[0]?.problems ?? []) {
    const key = `${p.field ?? ''}/${p.code}`;
    counts.set(key, { field: p.field ?? null, code: p.code, records: (counts.get(key)?.records ?? 0) + 1 });
  }
  return [...counts.values()].slice(0, MAX_MISMATCHES);
}

/**
 * Rejeu SANS LLM de la stratégie sur le HTML capturé, comparé aux éléments de l'agent : même nombre (±0), au moins
 * `HTML_COMPILE_MIN_MATCH` des valeurs égales après normalisation, chaque élément valide contre le schéma d'origine (INV1),
 * et aucun motif bloquant de l'interpréteur en mode strict. Un refus porte toujours son différentiel : les éléments sont
 * relus en mode quarantaine pour comparer les valeurs champ par champ, et les motifs du mode strict sont résumés par champ
 * (constat UX-30 : 20/20 éléments refusés en « extraction, ratio 0 » sans rien dire à la nouvelle tentative).
 */
export function verifyHtmlStrategy(spec: DeclarativeSpec, html: string, expected: readonly unknown[], outputSchema: unknown): HtmlVerification {
  const fail = (reason: HtmlDiff['reason'], got: number, problems: HtmlProblem[] = []): HtmlVerification => ({
    ok: false,
    records: [],
    diff: { expected: expected.length, got, compared: 0, matched: 0, ratio: 0, mismatches: [], problems, reason },
  });
  let strict: ExtractResult;
  try {
    strict = extractRecords(spec, { body: html }, { outputSchema });
  } catch {
    return fail('extraction', 0);
  }
  const problems = strict.ok ? [] : problemSummary(strict);
  const loose = strict.ok ? strict : quarantined(spec, html, outputSchema);
  if (loose === null || !loose.ok || loose.records.length === 0) return fail(problems.some((p) => p.code === 'schema_mismatch') ? 'schema' : 'extraction', strict.attempts[0]?.records ?? 0, problems);
  const got = loose.records;
  const props = (outputSchema as { properties?: Record<string, unknown> } | null)?.properties ?? {};
  const names = Object.keys(props);
  let compared = 0;
  let matched = 0;
  const mismatches: HtmlMismatch[] = [];
  for (const [index, record] of got.entries()) {
    if (index >= expected.length) break;
    const want = (expected[index] ?? {}) as Record<string, unknown>;
    for (const field of names) {
      const a = normalized(want[field]);
      const b = normalized(record[field]);
      if (a === null && b === null) continue;
      compared += 1;
      if (a === b) matched += 1;
      else if (mismatches.length < MAX_MISMATCHES) mismatches.push({ index, field, expected: want[field] ?? null, got: record[field] ?? null });
    }
  }
  const ratio = compared === 0 ? 0 : Math.round((matched / compared) * 1e4) / 1e4;
  const valuesOk = compared > 0 && matched / compared >= HTML_COMPILE_MIN_MATCH;
  const schemaOk = got.every((r) => validateOutput(outputSchema, r).ok);
  const reason: HtmlDiff['reason'] =
    got.length !== expected.length ? 'count' : !valuesOk ? 'values' : !schemaOk || problems.some((p) => p.code === 'schema_mismatch') ? 'schema' : !strict.ok ? 'extraction' : null;
  return { ok: reason === null, records: got, diff: { expected: expected.length, got: got.length, compared, matched, ratio, mismatches, problems, reason } };
}
