// SPDX-License-Identifier: AGPL-3.0-only
// Contrôle de FIDÉLITÉ d'une stratégie avant de l'accepter (banc réel, passage 1 : R03 nom vide sur 78 éléments, R04 équipe
// qui reçoit le mode de travail, R07 note et disponibilité absentes, R09 date de début qui reçoit l'organisateur, R10
// étiquettes absentes ; toutes acceptées « conformes au schéma »). Partie PURE, sans I/O ni LLM :
// (a) `fidelityCheck` : contrôle déterministe sur les éléments rendus par les essais :
//     - remplissage par champ : un champ vide sur plus de 20 % des éléments ALORS QUE la page en montre (emplacement relié
//       présent sur au moins 80 % des blocs, ou clé du gisement au nom du champ laissée de côté) ;
//     - deux champs aux mêmes valeurs sur au moins 80 % des éléments (le même emplacement relié deux fois) ;
//     - forme cohérente avec le nom du champ : une date ressemble à une date, une URL à une URL, un e-mail à un e-mail, un
//       nom n'est pas une URL ;
// (b) `fidelitySamples` : 3 éléments échantillonnés (premier, milieu, dernier) avec le fragment de leur source (HTML du bloc,
//     ou objet JSON de l'enregistrement), pour le juge LLM court (packages/agent, `judgeFidelity`), qui ne voit que des
//     DONNÉES NON FIABLES encadrées par un jeton ;
// (c) `fidelityDiff` : le différentiel montré à la nouvelle proposition des emplacements, en CODES seulement (champ, motif,
//     part des éléments, autre champ) : jamais une valeur du site dans le prompt `investigate`.
import type { AnyNode, Document, Element } from 'domhandler';
import { decodeEmbedded } from '../dsl/blobs.js';
import { parseHtml, selectElements } from '../dsl/css.js';
import { extractRecords } from '../dsl/extract.js';
import { queryValues } from '../dsl/jsonpath.js';
import { DEFAULT_DSL_LIMITS, parseJsonBounded } from '../dsl/limits.js';
import type { DeclarativeSpec, FieldSpec } from '../dsl/spec.js';
import type { DataCandidate } from './recon.js';

/** Part maximale d'éléments vides pour un champ que la page montre. */
export const FIDELITY_MAX_EMPTY_SHARE = 0.2;
/** Part d'éléments identiques à partir de laquelle deux champs sont le même emplacement relié deux fois. */
export const FIDELITY_DUPLICATE_SHARE = 0.8;
/** Éléments montrés au juge LLM. */
export const FIDELITY_JUDGE_SAMPLES = 3;
/** Plafond du coût d'un appel du juge (USD), connu avant l'envoi. */
export const FIDELITY_JUDGE_MAX_USD = 0.01;

export type FidelityIssueCode = 'empty' | 'duplicate' | 'not_a_date' | 'not_a_url' | 'not_an_email' | 'looks_like_url' | 'looks_like_id' | 'judge_wrong' | 'judge_missing';
export type FidelityIssue = {
  readonly field: string;
  readonly code: FidelityIssueCode;
  /** Part des éléments touchés (0 à 1), quand elle a un sens. */
  readonly share?: number;
  /** Autre champ (doublon). */
  readonly other?: string;
};
export type FidelityCheck = { readonly ok: boolean; readonly issues: readonly FidelityIssue[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const round = (x: number): number => Math.round(x * 100) / 100;

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function schemaFields(schema: unknown): { name: string; type: string; description: string }[] {
  const props = isRecord(schema) && isRecord(schema['properties']) ? schema['properties'] : {};
  return Object.entries(props).map(([name, p]) => {
    const t = isRecord(p) ? p['type'] : undefined;
    const type = Array.isArray(t) ? (t.find((x) => x !== 'null') as string | undefined) : (t as string | undefined);
    return { name, type: typeof type === 'string' ? type : 'string', description: isRecord(p) && typeof p['description'] === 'string' ? p['description'] : '' };
  });
}

const DATE_NAME = /(?:^|_)(?:date|dates|start|starts|end|ends|begin|begins|time|datetime|deadline|published|created|updated|day|when|debut|fin)(?:_|$)|_at$|_on$/;
const URL_NAME = /(?:^|_)(?:url|urls|link|href|website|permalink)(?:_|$)/;
const EMAIL_NAME = /(?:^|_)e?mail(?:_|$)/;
const LABEL_NAME = /(?:^|_)(?:name|title|nom|titre|label)(?:_|$)/;
const MONTH = /\b(?:jan|feb|fev|fév|mar|apr|avr|may|mai|jun|juin|jul|juil|aug|aou|aoû|sep|oct|nov|dec|déc)[a-zéû]*\.?\b/i;

/** Valeur qui ressemble à une date ou une heure (ISO, jj/mm/aaaa, mois en lettres avec un nombre, année, hh:mm, époque). */
export function looksLikeDate(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (/\d{4}-\d{2}-\d{2}/.test(s) || /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/.test(s) || /\b\d{1,2}:\d{2}\b/.test(s)) return true;
  if (/\b(?:19|20)\d{2}\b/.test(s)) return true;
  return MONTH.test(s) && /\d/.test(s);
}

/** Identifiant opaque : UUID, ou condensé hexadécimal long (banc réel R05 : `team` valait un UUID). */
const OPAQUE_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24,})$/i;
const ID_NAME = /(?:^|_)(?:id|ids|uuid|guid|ref|reference|code|slug|sku|key|token|hash)(?:_|$)/;
const looksLikeId = (v: unknown): boolean => typeof v === 'string' && OPAQUE_ID.test(v.trim());

const looksLikeUrl = (v: unknown): boolean => typeof v === 'string' && /^(?:https?:\/\/|\/)[^\s]*$/i.test(v.trim());

/** Emplacement du gisement DOM relié à un champ de la stratégie (même sélecteur, même attribut, même ancêtre). */
function slotOfField(candidate: DataCandidate | null | undefined, field: FieldSpec | undefined) {
  if (candidate?.dom === undefined || field === undefined) return undefined;
  return candidate.dom.slots.find((s) => (s.css ?? undefined) === field.css && s.attr === (field.attr ?? 'text') && s.up === field.up);
}

const keyName = (path: string): string =>
  path
    .replace(/\[\*\]|\[\d+\]/g, '')
    .split(/[.[\]'"]+/)
    .filter((p) => p !== '' && p !== '$')
    .at(-1)
    ?.toLowerCase() ?? '';

/** Le gisement porte une clé ou un emplacement au nom du champ, laissé de côté par la stratégie. */
function unmappedMatch(candidate: DataCandidate | null | undefined, spec: DeclarativeSpec | null | undefined, field: string): boolean {
  if (candidate === null || candidate === undefined) return false;
  const used = new Set(Object.values(spec?.fields ?? {}).flatMap((f) => [f.path ?? '', f.css ?? '']));
  const target = field.toLowerCase();
  for (const key of Object.keys(candidate.skeleton)) {
    if (used.has(key)) continue;
    const slot = candidate.dom?.slots.find((s) => `$.${s.name}` === key);
    if (slot !== undefined && used.has(slot.css ?? '')) continue;
    const name = slot === undefined ? keyName(key) : slot.name;
    if (name === target || (target.length >= 4 && name.split('_').includes(target)) || (name.length >= 4 && target.split('_').includes(name))) return true;
  }
  return false;
}

/**
 * Contrôle déterministe de fidélité (a) sur les éléments rendus par les essais d'une stratégie. `spec` et `candidate` (le
 * gisement de la stratégie) disent si la page MONTRE un champ vide : emplacement relié présent sur 80 % des blocs, ou clé
 * du gisement au nom du champ que la stratégie ne lit pas. Sans eux, seuls doublons et formes sont jugés.
 */
export function fidelityCheck(input: {
  readonly records: readonly Record<string, unknown>[];
  readonly outputSchema: unknown;
  readonly spec?: DeclarativeSpec | null;
  readonly candidate?: DataCandidate | null;
}): FidelityCheck {
  const records = input.records;
  const issues: FidelityIssue[] = [];
  if (records.length === 0) return { ok: true, issues };
  const fields = schemaFields(input.outputSchema);
  const n = records.length;
  for (const f of fields) {
    const values = records.map((r) => r[f.name]);
    const filled = values.filter((v) => !isEmpty(v));
    const emptyShare = (n - filled.length) / n;
    if (emptyShare > FIDELITY_MAX_EMPTY_SHARE) {
      const mapped = input.spec?.fields[f.name];
      const slot = slotOfField(input.candidate, mapped);
      const shown = (slot !== undefined && input.candidate !== null && input.candidate !== undefined && slot.present >= input.candidate.count * 0.8) || (mapped === undefined && unmappedMatch(input.candidate, input.spec, f.name));
      if (shown) issues.push({ field: f.name, code: 'empty', share: round(emptyShare) });
    }
    if (filled.length === 0) continue;
    const share = (pred: (v: unknown) => boolean) => filled.filter((v) => !pred(v)).length / filled.length;
    const name = f.name.toLowerCase();
    if (f.type === 'string' && (DATE_NAME.test(name) || /\bdate\b/i.test(f.description)) && !URL_NAME.test(name)) {
      const bad = share(looksLikeDate);
      if (bad > FIDELITY_MAX_EMPTY_SHARE) issues.push({ field: f.name, code: 'not_a_date', share: round(bad) });
    } else if (f.type === 'string' && URL_NAME.test(name)) {
      const bad = share(looksLikeUrl);
      if (bad > FIDELITY_MAX_EMPTY_SHARE) issues.push({ field: f.name, code: 'not_a_url', share: round(bad) });
    } else if (f.type === 'string' && EMAIL_NAME.test(name)) {
      const bad = share((v) => typeof v === 'string' && v.includes('@'));
      if (bad > FIDELITY_MAX_EMPTY_SHARE) issues.push({ field: f.name, code: 'not_an_email', share: round(bad) });
    } else if (f.type === 'string' && LABEL_NAME.test(name)) {
      const urls = filled.filter(looksLikeUrl).length / filled.length;
      if (urls >= 0.5) issues.push({ field: f.name, code: 'looks_like_url', share: round(urls) });
    }
    // Un libellé (équipe, département, lieu, nom…) qui reçoit un identifiant opaque : la clé de liaison a été lue à la place du libellé.
    if (f.type === 'string' && !ID_NAME.test(name) && !URL_NAME.test(name)) {
      const ids = filled.filter(looksLikeId).length / filled.length;
      if (ids >= 0.5) issues.push({ field: f.name, code: 'looks_like_id', share: round(ids) });
    }
  }
  // Doublons : deux champs texte aux mêmes valeurs (hors URL : un lien de fiche et un lien « postuler » peuvent coïncider).
  const texts = fields.filter((f) => f.type === 'string');
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i]!.name;
      const b = texts[j]!.name;
      const both = records.filter((r) => !isEmpty(r[a]) && !isEmpty(r[b]));
      if (both.length < Math.max(2, n * 0.5)) continue;
      const same = both.filter((r) => String(r[a]).trim() === String(r[b]).trim() && !looksLikeUrl(r[a]));
      if (same.length >= both.length * FIDELITY_DUPLICATE_SHARE) {
        const s = round(same.length / both.length);
        issues.push({ field: a, code: 'duplicate', share: s, other: b }, { field: b, code: 'duplicate', share: s, other: a });
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------------------------------- échantillon du juge

export type FidelitySample = {
  /** Valeurs extraites par le code (enregistrement de la stratégie). */
  readonly record: Record<string, unknown>;
  /** Fragment de la source de cet enregistrement : HTML épuré du bloc, ou JSON de l'objet. DONNÉE NON FIABLE. */
  readonly fragment: string;
  readonly kind: 'html' | 'json';
};

const KEPT_ATTRS = new Set(['class', 'href', 'src', 'alt', 'title', 'datetime', 'content', 'itemprop', 'aria-label', 'data-sort-value']);
const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'embed', 'canvas']);
const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** HTML épuré d'un élément (balises, texte, attributs utiles ; liens sans requête), borné à `maxChars`. */
export function condenseElement(root: Element, maxChars: number): string {
  let out = '';
  const push = (s: string): boolean => {
    if (out.length + s.length > maxChars) return false;
    out += s;
    return true;
  };
  type Item = AnyNode | { close: string };
  const stack: Item[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if ('close' in node) {
      if (!push(`</${node.close}>`)) break;
      continue;
    }
    if (node.type === 'text') {
      const t = node.data.replace(/\s+/g, ' ');
      if (t.trim() !== '' && !push(escapeText(t))) break;
      continue;
    }
    if (node.type !== 'tag') continue;
    const el = node as Element;
    if (SKIPPED.has(el.name)) continue;
    const attrs = Object.entries(el.attribs)
      .filter(([k, v]) => KEPT_ATTRS.has(k) && v.trim() !== '')
      .map(([k, v]) => ` ${k}="${escapeText(k === 'href' || k === 'src' ? (v.split(/[?#]/, 1)[0] ?? '') : v.replace(/\s+/g, ' ').trim()).replace(/"/g, '&quot;').slice(0, 120)}"`)
      .join('');
    if (!push(`<${el.name}${attrs}>`)) break;
    stack.push({ close: el.name });
    for (let i = el.children.length - 1; i >= 0; i -= 1) stack.push(el.children[i]!);
  }
  return out;
}

function ancestor(el: Element, up: number): Element | null {
  let cur: Element | null = el;
  for (let k = 0; k < up && cur !== null; k += 1) cur = cur.parent !== null && cur.parent.type === 'tag' ? (cur.parent as Element) : null;
  return cur;
}

/**
 * Échantillon du juge (b) : la stratégie relue SANS LLM sur le corps capturé (`body` : page HTML, réponse JSON, page qui
 * porte le blob), puis les éléments premier, du milieu et dernier, chacun avec le fragment de sa source. Un champ lu sous un
 * ancêtre (`up`, titre de groupe) ajoute ce titre au fragment. `[]` si la stratégie ne rend rien sur ce corps.
 */
export function fidelitySamples(spec: DeclarativeSpec, body: string, outputSchema: unknown, options: { readonly count?: number; readonly maxChars?: number } = {}): FidelitySample[] {
  const count = options.count ?? FIDELITY_JUDGE_SAMPLES;
  const maxChars = options.maxChars ?? 1_200;
  const source = spec.sources[0];
  if (source === undefined) return [];
  let records: Record<string, unknown>[];
  try {
    const out = extractRecords({ ...spec, sources: [source] }, { body }, { outputSchema, itemPolicy: 'quarantine' });
    if (!out.ok) return [];
    records = out.records;
  } catch {
    return [];
  }
  let roots: unknown[];
  try {
    if (source.from === 'html') {
      roots = selectElements(source.records, parseHtml(body, DEFAULT_DSL_LIMITS), DEFAULT_DSL_LIMITS.maxItems);
    } else if (source.from === 'embedded') {
      const doc: Document = parseHtml(body, DEFAULT_DSL_LIMITS);
      roots = queryValues(source.records, decodeEmbedded(doc, source.locator!, DEFAULT_DSL_LIMITS), { limits: DEFAULT_DSL_LIMITS });
    } else {
      roots = queryValues(source.records, parseJsonBounded(body, DEFAULT_DSL_LIMITS), { limits: DEFAULT_DSL_LIMITS });
    }
  } catch {
    return [];
  }
  if (roots.length !== records.length || records.length === 0) return [];
  const picks = [...new Set([0, Math.floor((records.length - 1) / 2), records.length - 1])].slice(0, count);
  const grouped = Object.values(spec.fields).filter((f) => f.up !== undefined && f.css !== undefined);
  return picks.map((i) => {
    const root = roots[i];
    if (source.from !== 'html') return { record: records[i]!, fragment: JSON.stringify(root).slice(0, maxChars), kind: 'json' as const };
    const el = root as Element;
    const heads = grouped
      .map((f) => {
        const top = ancestor(el, f.up!);
        const head = top === null ? undefined : selectElements(f.css!, top, 1_000)[0];
        return head === undefined ? '' : `<group_heading>${condenseElement(head, 200)}</group_heading>`;
      })
      .join('');
    return { record: records[i]!, fragment: `${heads}${condenseElement(el, Math.max(200, maxChars - heads.length))}`, kind: 'html' as const };
  });
}

// ---------------------------------------------------------------------------------------------------- différentiel

const MESSAGES: Record<FidelityIssueCode, (i: FidelityIssue) => string> = {
  empty: (i) => `empty on ${Math.round((i.share ?? 1) * 100)}% of records although the page shows it: map it to the slot or key that holds it`,
  duplicate: (i) => `same values as "${i.other}" on ${Math.round((i.share ?? 1) * 100)}% of records: one of the two reads the wrong slot`,
  not_a_date: (i) => `${Math.round((i.share ?? 1) * 100)}% of values do not look like a date: wrong slot or key`,
  not_a_url: (i) => `${Math.round((i.share ?? 1) * 100)}% of values are not URLs: wrong slot or key`,
  not_an_email: (i) => `${Math.round((i.share ?? 1) * 100)}% of values are not e-mail addresses: wrong slot or key`,
  looks_like_url: (i) => `${Math.round((i.share ?? 1) * 100)}% of values are URLs, not a name: wrong slot or key`,
  looks_like_id: (i) => `${Math.round((i.share ?? 1) * 100)}% of values are opaque identifiers, not a label: a joined path such as "$.<key>~<field>" holds the label`,
  judge_wrong: () => 'a reviewer compared the values with the source blocks and found them wrong: wrong slot or key',
  judge_missing: () => 'a reviewer found the value in the source blocks while the extraction left it empty',
};

/**
 * Différentiel montré à la nouvelle proposition des emplacements (c) : par champ, le motif en anglais, la part des éléments
 * et l'autre champ ; aucune valeur du site. Borné à 20 lignes.
 */
export function fidelityDiff(issues: readonly FidelityIssue[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const i of issues) {
    const key = `${i.field}/${i.code}/${i.other ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- field "${i.field}": ${MESSAGES[i.code](i)}`);
    if (lines.length >= 20) break;
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------- champs requis

/**
 * Champs requis absents d'éléments rendus en politique `quarantine` (banc réel R02 : la vérification de la règle d'arrêt
 * atteint des pages au second gabarit de carte, sans le champ que la page 1 montrait partout) : nom et nombre d'éléments.
 */
export function missingRequiredFields(records: readonly Record<string, unknown>[], schema: unknown): { readonly field: string; readonly records: number }[] {
  const required = isRecord(schema) && Array.isArray(schema['required']) ? (schema['required'] as unknown[]).filter((r): r is string => typeof r === 'string') : [];
  return required.map((field) => ({ field, records: records.filter((r) => isEmpty(r[field])).length })).filter((m) => m.records > 0);
}

/** Schéma de sortie sans ces champs parmi les requis (un champ que la page ne montre pas toujours devient facultatif). */
export function relaxRequired(schema: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const required = Array.isArray(schema['required']) ? (schema['required'] as unknown[]).filter((r) => typeof r === 'string' && !fields.includes(r)) : [];
  return { ...schema, required };
}

/** Stratégie déclarative dont ces champs ne sont plus requis (l'extraction stricte ne casse plus sur leur absence). */
export function relaxSpecRequired(spec: DeclarativeSpec, fields: readonly string[]): DeclarativeSpec {
  const next: Record<string, FieldSpec> = {};
  for (const [name, field] of Object.entries(spec.fields)) {
    if (!fields.includes(name) || field.required !== true) {
      next[name] = field;
      continue;
    }
    const { required: _required, ...rest } = field;
    next[name] = rest;
  }
  return { ...spec, fields: next };
}
