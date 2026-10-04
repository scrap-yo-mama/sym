// SPDX-License-Identifier: AGPL-3.0-only
// Compilation d'un essai E4 (`agent_fetch`) conforme en stratégie déclarative à source `html` (constat UX-20, 04b §2,
// 19 §1 « Rejeu E1-E3 : 0 LLM ») : un essai E4 rappelle le LLM à chaque rejeu ; une page HTML statique se rejoue sans lui
// par sélecteurs CSS. Partie PURE (sans I/O) :
// - `condenseHtml` : le HTML capturé, épuré (ni script, ni style, ni commentaire, ni jeton d'URL) et borné, pour le prompt,
//   où il reste une DONNÉE NON FIABLE (balises à jeton posées par l'appelant, packages/agent) ;
// - `HTML_COMPILE_PROPOSAL_SCHEMA` : la réponse fermée du LLM (sélecteur de l'élément répété, par champ un sélecteur, un
//   attribut et des opérateurs de la liste fermée) ; aucune URL, aucun code, aucun hôte ;
// - `buildHtmlStrategy` : le CODE construit la stratégie (requête GET de la page de l'essai, `allowed_hosts` de l'essai,
//   `abs_url` toujours basé sur la page), validée par `validateDeclarativeSpec` (INV10, liste fermée) ;
// - `verifyHtmlStrategy` : l'interpréteur rejoue la stratégie sur le MÊME HTML, sans LLM ; acceptée si elle rend autant
//   d'éléments que l'agent (±0), au moins 95 % de valeurs égales après normalisation des espaces, et une sortie valide
//   contre le schéma d'origine (INV1).
// L'agent E4 ne pagine pas (une page par exécution) : la stratégie compilée ne pagine pas non plus.
import { Parser } from 'htmlparser2';
import { extractRecords } from '../dsl/extract.js';
import { validateDeclarativeSpec, type DeclarativeSpec } from '../dsl/spec.js';
import { validateOutput } from '../schema/validator.js';
import { schemaFieldTypes } from './proposal.js';

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

function operatorSpec(o: HtmlCompileOp, pageUrl: string): string | Record<string, unknown> | null {
  if (!(HTML_COMPILE_OPERATORS as readonly string[]).includes(o.op)) return null;
  switch (o.op) {
    case 'abs_url':
      // Base fixée par le code : la page de l'essai (aucune URL ne vient du modèle).
      return { op: 'abs_url', base: pageUrl };
    case 'regex_extract':
      return { op: 'regex_extract', pattern: o.pattern ?? '', ...(o.group === null ? {} : { group: o.group }) };
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
 * `required` repris du schéma). Chaque texte lu est d'abord normalisé (`collapse_spaces`). Validée par
 * `validateDeclarativeSpec` (sélecteurs compilés, opérateurs, hôte dans `allowed_hosts`, couverture des `required`).
 */
export function buildHtmlStrategy(proposal: HtmlCompileProposal, context: { readonly pageUrl: string; readonly allowedHosts: readonly string[]; readonly outputSchema: unknown }): HtmlStrategyBuild {
  const types = schemaFieldTypes(context.outputSchema);
  const fields: Record<string, unknown> = {};
  for (const [name, t] of types) {
    const proposed = proposal.fields.find((f) => f.field === name);
    if (proposed === undefined) continue;
    if (!SCALARS.has(t.type)) return { ok: false, reason: 'unsupported_field_type', codes: [name] };
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
  if (!check.ok) return { ok: false, reason: 'invalid_spec', codes: [...new Set(check.errors.map((e) => e.code))].slice(0, 10) };
  return { ok: true, spec: check.spec };
}

// ---------------------------------------------------------------------------------------------------- vérification

export type HtmlMismatch = { readonly index: number; readonly field: string; readonly expected: unknown; readonly got: unknown };
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
  return JSON.stringify(value);
}

/**
 * Rejeu SANS LLM de la stratégie sur le HTML capturé, comparé aux éléments de l'agent : même nombre (±0), au moins
 * `HTML_COMPILE_MIN_MATCH` des valeurs égales après normalisation, chaque élément valide contre le schéma d'origine (INV1).
 */
export function verifyHtmlStrategy(spec: DeclarativeSpec, html: string, expected: readonly unknown[], outputSchema: unknown): HtmlVerification {
  const empty = (reason: HtmlDiff['reason'], got = 0): HtmlVerification => ({ ok: false, records: [], diff: { expected: expected.length, got, compared: 0, matched: 0, ratio: 0, mismatches: [], reason } });
  let result: ReturnType<typeof extractRecords>;
  try {
    result = extractRecords(spec, { body: html }, { outputSchema });
  } catch {
    return empty('extraction');
  }
  if (!result.ok) {
    const attempt = result.attempts[0];
    return empty(attempt?.problems.some((p) => p.code === 'schema_mismatch') === true ? 'schema' : 'extraction', attempt?.records ?? 0);
  }
  const got = result.records;
  if (got.length !== expected.length) return { ...empty('count', got.length), records: got };
  if (got.some((r) => !validateOutput(outputSchema, r).ok)) return { ...empty('schema', got.length), records: got };
  const props = (outputSchema as { properties?: Record<string, unknown> } | null)?.properties ?? {};
  const names = Object.keys(props);
  let compared = 0;
  let matched = 0;
  const mismatches: HtmlMismatch[] = [];
  for (const [index, record] of got.entries()) {
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
  const ok = compared > 0 && matched / compared >= HTML_COMPILE_MIN_MATCH;
  return { ok, records: got, diff: { expected: expected.length, got: got.length, compared, matched, ratio, mismatches, reason: ok ? null : 'values' } };
}
