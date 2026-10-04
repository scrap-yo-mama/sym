// SPDX-License-Identifier: AGPL-3.0-only
// Reconnaissance DOM (04b §2, troisième source après l'API JSON et le blob embarqué ; constat Janssens) : une liste HTML
// statique paginée se lit SANS LLM par sélecteurs CSS. Détection déterministe, sans appel au modèle :
// - BLOCS RÉPÉTÉS : éléments de même balise et mêmes classes, au moins `DOM_MIN_BLOCKS` occurrences, hors `nav`, `header`
//   et `footer`, chacun avec du texte et un lien ; le sélecteur des enregistrements est vérifié (il rend exactement ces
//   blocs) ;
// - EMPLACEMENTS (slots) de chaque bloc : textes et attributs utiles (lien, image, `data-*`, date), chacun avec un
//   sous-sélecteur VÉRIFIÉ sur chaque bloc (il désigne le même élément partout), un nom fabriqué par le code, une forme
//   (montant, surface, nombre, nombre et unité, code, date, URL, texte) et les libellés constants de tous les blocs
//   (« chambres », « m² », « ref »). Un emplacement constant sur tous les blocs (décor) est écarté ;
// - PAGINATION : `rel=next`, liens numérotés `/page/N/`, `?page=N`, `?p=N` (ou tout paramètre entier), décalage
//   `?start=10`, bouton « suivant » ; même hôte que la page seulement (INV10). Règles d'arrêt : page vide, page 404, page
//   déjà vue (exécuteur déclaratif), plafond dur.
// Ce que le LLM d'enquête voit d'un bloc : les NOMS d'emplacements et leur description (forme, présence, libellés
// constants), jamais une valeur propre à un enregistrement (08 §4, 17 §6). Fonctions pures, sans I/O.
import type { AnyNode, Document, Element } from 'domhandler';
import { compileSelector, elementText, parseHtml, selectElements } from '../dsl/css.js';
import { DEFAULT_DSL_LIMITS, type DslLimits } from '../dsl/limits.js';

/** Occurrences minimales d'un bloc pour parler de liste. */
export const DOM_MIN_BLOCKS = 5;
/** Plafond dur de pages d'une liste HTML paginée (borne du format, 04b §2). */
export const HTML_LIST_HARD_MAX_PAGES = 200;
const MAX_SLOTS = 24;
const MAX_GROUPS_SCORED = 12;
const MAX_BLOCKS = 500;
const MAX_TEXT = 2_000;

/** Un emplacement d'un bloc répété : sous-sélecteur vérifié (null : le bloc lui-même) et attribut lu (`text` : son texte). */
export type DomSlot = {
  /** Nom fabriqué par le code (`h3`, `a_href`, `div_css_title`) : clé `$.<nom>` du squelette montré au LLM. */
  readonly name: string;
  readonly css: string | null;
  readonly attr: string;
  /** Forme dominante des valeurs (`money`, `area`, `number`, `number_with_unit`, `paren_code`, `code`, `date`, `url`, `text`, `long_text`…), `a|b` si mêlée. */
  readonly shape: string;
  /** Blocs où l'emplacement a une valeur. */
  readonly present: number;
  /** Libellés constants de (presque) tous les blocs : premier mot (« ref ») et dernier mot (« chambres », « m² », « € »). */
  readonly prefix: string | null;
  readonly suffix: string | null;
  /** Séparateur décimal vu dans les valeurs numériques. */
  readonly decimal: '.' | ',';
};

/** Pagination détectée sur la page (même hôte seulement). */
export type DomPagination =
  | { readonly type: 'page_param'; readonly param: string; readonly start: number; readonly last: number | null }
  | { readonly type: 'page_param'; readonly param: 'url.path'; readonly path_pattern: string; readonly start: number; readonly last: number | null }
  | { readonly type: 'offset'; readonly param: string; readonly start: number; readonly step: number; readonly last: number | null }
  | { readonly type: 'next_link'; readonly last: null };

export type DomBlocks = {
  /** Sélecteur CSS des enregistrements, vérifié sur la page. */
  readonly records: string;
  readonly count: number;
  readonly slots: readonly DomSlot[];
};

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'svg', 'math', 'iframe', 'object', 'embed', 'canvas', 'select', 'option', 'button']);
const LANDMARKS = new Set(['nav', 'header', 'footer']);
/** Classe utilisable dans un sélecteur sans échappement (les variantes Tailwind `md:block`, `w-[33px]`, `group/x` sont ignorées). */
const CLASS_OK = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const STATE_CLASSES = new Set(['active', 'current', 'selected', 'hidden', 'show', 'open', 'is-active', 'is-current', 'odd', 'even', 'first', 'last', 'disabled', 'lazy', 'loaded', 'lazyloaded']);
/** Classe utilitaire (Tailwind, Bootstrap) : jamais choisie pour nommer ou désigner si une classe parlante existe. */
const UTILITY =
  /^(?:[a-z]{1,3}-?\d|(?:block|inline|flex|grid|hidden|relative|absolute|fixed|sticky|static|truncate|uppercase|lowercase|capitalize|italic|underline|container|clearfix|group|peer|shadow|rounded|border|transition|duration|ease|delay|transform|cursor|select|pointer|overflow|object|aspect|z|top|left|right|bottom|inset|w|h|min|max|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|space|gap|divide|text|font|leading|tracking|bg|fill|stroke|opacity|items|justify|content|self|place|order|col|row|basis|grow|shrink|float|clear|sr|not|visible|invisible|whitespace|break|line|list|decoration|align|vertical|table|d|g|lg|md|sm|xl|xs|js|out|icon|svg)(?:-|$))/;
const DATA_ATTR = /^data-[a-z0-9_-]{1,40}$/;
const LINK_HREF = (href: string | undefined): boolean => href !== undefined && href.trim() !== '' && !/^\s*(#|javascript:|mailto:|tel:)/i.test(href);

const isTag = (n: AnyNode): n is Element => n.type === 'tag' || n.type === 'script' || n.type === 'style';
const childElements = (el: Element | Document): Element[] => el.children.filter(isTag);
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

function classesOf(el: Element): string[] {
  const raw = el.attribs['class'];
  if (raw === undefined) return [];
  return [...new Set(raw.split(/\s+/).filter((c) => c !== '' && CLASS_OK.test(c) && !STATE_CLASSES.has(c.toLowerCase())))];
}

const signature = (el: Element): string => [el.name, ...classesOf(el).sort()].join('.');

/** Classes parlantes d'abord (non utilitaires), puis les autres, dans l'ordre du document. */
function rankedClasses(el: Element): string[] {
  const cls = classesOf(el);
  return [...cls.filter((c) => !UTILITY.test(c)), ...cls.filter((c) => UTILITY.test(c))];
}

function insideSkipped(el: Element): boolean {
  for (let p = el.parent; p !== null; p = p.parent) {
    if (p.type !== 'tag' && p.type !== 'script' && p.type !== 'style') continue;
    const name = (p as Element).name;
    if (LANDMARKS.has(name) || SKIP_TAGS.has(name)) return true;
  }
  return false;
}

function depthOf(el: Element): number {
  let d = 0;
  for (let p = el.parent; p !== null; p = p.parent) d += 1;
  return d;
}

function isAncestor(a: Element, b: Element): boolean {
  for (let p = b.parent; p !== null; p = p.parent) if (p === a) return true;
  return false;
}

/** Tous les éléments du document (parcours itératif), hors balises sans contenu lisible. */
function allElements(root: Document | Element): Element[] {
  const out: Element[] = [];
  const stack: (Document | Element)[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const kids = childElements(node);
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      const kid = kids[i]!;
      if (SKIP_TAGS.has(kid.name)) continue;
      out.push(kid);
      stack.push(kid);
    }
  }
  return out;
}

function hasLink(el: Element): boolean {
  if (el.name === 'a' && LINK_HREF(el.attribs['href'])) return true;
  return allElements(el).some((e) => e.name === 'a' && LINK_HREF(e.attribs['href']));
}

function textOf(el: Element): string {
  try {
    return collapse(elementText(el, 200_000)).slice(0, MAX_TEXT);
  } catch {
    return '';
  }
}

/** Texte propre de l'élément (nœuds texte directs) : un élément porteur d'un texte, pas un simple conteneur. */
const ownText = (el: Element): string => collapse(el.children.map((c) => (c.type === 'text' ? c.data : '')).join(''));

// ---------------------------------------------------------------------------------------------------- formes

const SHAPE_TESTS: readonly [string, (v: string) => boolean][] = [
  ['email', (v) => /^[^\s@]{1,64}@[^\s@]{1,255}\.[A-Za-z]{2,}$/.test(v)],
  ['money', (v) => /\d/.test(v) && /[€$£¥]|\b(?:EUR|USD|GBP|CHF)\b/.test(v)],
  ['area', (v) => /\d[\d\s.,]*\s*(?:m²|m2|ft²|sq\.?\s?ft|ha)(?![\p{L}\d])/iu.test(v)],
  ['phone', (v) => /^\+?[\d\s().-]{9,20}$/.test(v) && (v.replace(/\D/g, '').length >= 9) && /^[+0(]/.test(v)],
  ['date', (v) => /^\d{4}-\d{2}-\d{2}/.test(v) || /^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/.test(v)],
  ['number', (v) => /^[-+]?[\d\s.,]*\d$/.test(v)],
  ['paren_code', (v) => /^\(\s*[\p{L}\d][\p{L}\d -]{0,11}\s*\)$/u.test(v)],
  ['number_with_unit', (v) => /^[-+]?[\d\s.,]*\d\s*[\p{L}][\p{L}\s]{0,24}$/u.test(v)],
  ['code', (v) => /^[A-Za-z0-9_-]{2,24}$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v)],
];

function shapeOfValue(value: string, attr: string): string {
  if (attr === 'href' || attr === 'src') return 'url';
  if (/^https?:\/\//i.test(value)) return 'url';
  for (const [name, test] of SHAPE_TESTS) if (test(value)) return name;
  return value.length > 80 ? 'long_text' : 'text';
}

function dominantShape(values: readonly string[], attr: string): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(shapeOfValue(v, attr), (counts.get(shapeOfValue(v, attr)) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [first, second] = ranked;
  if (first === undefined) return 'text';
  return second !== undefined && second[1] >= Math.max(1, values.length * 0.1) ? `${first[0]}|${second[0]}` : first[0];
}

/** Mot d'un libellé montrable : lettres (et symboles d'unité ou de devise), court ; jamais une valeur propre à un bloc. */
const LABEL = /^[\p{L}²€$£¥%][\p{L}²€$£¥%'’-]{0,15}$/u;

function constantWord(values: readonly string[], pick: (words: string[]) => string | undefined): string | null {
  if (values.length < DOM_MIN_BLOCKS) return null;
  const counts = new Map<string, number>();
  for (const v of values) {
    const words = v.split(/\s+/).filter((w) => w !== '');
    if (words.length < 2) continue;
    const w = pick(words)?.replace(/^[^\p{L}²€$£¥%]+|[^\p{L}²€$£¥%]+$/gu, '');
    if (w !== undefined && LABEL.test(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best !== undefined && best[1] >= values.length * 0.9 ? best[0] : null;
}

function decimalOf(values: readonly string[]): '.' | ',' {
  const comma = values.some((v) => /\d,\d{1,2}(?!\d)/.test(v));
  const dot = values.some((v) => /\d\.\d{1,2}(?!\d)/.test(v));
  const dotThousands = values.some((v) => /\d\.\d{3}(?!\d)/.test(v) && !/\d,\d{3}(?!\d)/.test(v) && /\d\.\d{3}\.\d{3}|\d\.\d{3},\d/.test(v));
  return (comma && !dot) || dotThousands ? ',' : '.';
}

// ---------------------------------------------------------------------------------------------------- sélecteurs

/** Même ensemble d'éléments, même ordre. */
const sameSet = (a: readonly Element[], b: readonly Element[]): boolean => a.length === b.length && a.every((e, i) => e === b[i]);

function trySelect(selector: string, root: Document | Element, max = MAX_BLOCKS * 4): Element[] | null {
  try {
    compileSelector(selector);
    return selectElements(selector, root, max);
  } catch {
    return null;
  }
}

/** Sélecteur des enregistrements : une classe parlante, puis la signature complète, puis parent > enfant ; vérifié. */
function recordsSelector(doc: Document, group: readonly Element[]): string | null {
  const first = group[0]!;
  const candidates = [...rankedClasses(first).map((c) => `${first.name}.${c}`), [first.name, ...classesOf(first)].join('.')];
  const parent = first.parent;
  if (parent !== null && parent.type === 'tag') {
    const p = parent as Element;
    const pc = rankedClasses(p)[0];
    candidates.push(`${p.name}${pc === undefined ? '' : `.${pc}`} > ${[first.name, ...classesOf(first)].join('.')}`);
  }
  for (const css of candidates) {
    const found = trySelect(css, doc);
    if (found !== null && sameSet(found, group)) return css;
  }
  return null;
}

type Step = { readonly el: Element; readonly css: string; readonly bare: readonly string[] };

/** Pas d'un chemin : balise et classes, `:nth-of-type` seulement si des frères ont la même signature. */
function stepOf(el: Element): Step {
  const parent = el.parent as Element | Document | null;
  const siblings = parent === null ? [el] : childElements(parent as Element);
  const sig = signature(el);
  const sameSig = siblings.filter((s) => signature(s) === sig);
  const sameTag = siblings.filter((s) => s.name === el.name);
  const base = [el.name, ...classesOf(el)].join('.');
  const css = sameSig.length > 1 ? `${base}:nth-of-type(${sameTag.indexOf(el) + 1})` : base;
  const bare = [...rankedClasses(el).map((c) => `${el.name}.${c}`), el.name];
  return { el, css, bare };
}

type RawSlot = { key: string; path: Step[]; attr: string; values: (string | undefined)[]; elements: (Element | undefined)[]; order: number };

/** Valeur lue par l'interpréteur pour un emplacement (texte ou attribut), vide si absente. */
const readSlot = (el: Element, attr: string): string => (attr === 'text' ? textOf(el) : (el.attribs[attr] ?? '').trim());

/**
 * Sous-sélecteur qui désigne, dans CHAQUE bloc, l'élément de l'emplacement (premier trouvé), et aucun élément porteur
 * d'une autre valeur là où l'emplacement manque (une carte sans surface ne doit pas lire ses chambres à la place). Formes
 * essayées, de la plus courte à la plus précise : classe parlante, balise, pas complet, parent > enfant, chemin complet ;
 * puis chacune avec `:not(.classe)` des éléments voisins qui la trompent.
 */
function slotSelector(slot: RawSlot, blocks: readonly Element[]): string | null {
  const last = slot.path.at(-1)!;
  const parent = slot.path.at(-2);
  const base: string[] = [...last.bare.slice(0, 3), last.css];
  if (parent !== undefined) base.push(`${parent.bare[0]} > ${last.css}`, `${parent.css} > ${last.css}`);
  base.push(slot.path.map((s) => s.css).join(' > '));
  const own = new Set(slot.elements.flatMap((el) => (el === undefined ? [] : classesOf(el))));
  /** `exact` : un seul élément trouvé par bloc (aucun voisin qui pourrait prendre sa place sur une autre page). */
  const check = (css: string): { ok: boolean; exact: boolean; others: Element[] } => {
    const others: Element[] = [];
    let ok = true;
    for (const [i, block] of blocks.entries()) {
      const found = trySelect(css, block, 1_000);
      if (found === null) return { ok: false, exact: false, others: [] };
      const want = slot.elements[i];
      const got = found[0];
      if (want !== undefined ? got !== want : got !== undefined && readSlot(got, slot.attr) !== '') {
        ok = false;
        if (got !== undefined) others.push(got);
      }
      for (const extra of found.slice(1)) if (extra !== want) others.push(extra);
    }
    return { ok, exact: ok && others.length === 0, others };
  };
  const loose: string[] = [];
  const retry: string[] = [];
  for (const css of [...new Set(base)]) {
    const result = check(css);
    if (result.exact) return css;
    if (result.ok) loose.push(css);
    const foreign = [...new Set(result.others.flatMap((el) => classesOf(el)).filter((c) => !own.has(c)))];
    for (const c of foreign.slice(0, 3)) retry.push(`${css}:not(.${c})`);
  }
  for (const css of retry) if (check(css).exact) return css;
  for (const css of retry) if (check(css).ok) return css;
  return loose[0] ?? null;
}

const NAME_SAFE = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function slotName(slot: RawSlot, used: Set<string>): string {
  const last = slot.path.at(-1);
  let base = last === undefined ? 'item' : last.el.name;
  const semantic = last === undefined ? undefined : classesOf(last.el).find((c) => !UTILITY.test(c));
  if (semantic !== undefined) base = `${base}_${NAME_SAFE(semantic)}`;
  if (slot.attr !== 'text') base = `${base}_${NAME_SAFE(slot.attr)}`;
  base = NAME_SAFE(base).slice(0, 48) || 'slot';
  if (!/^[a-z]/.test(base)) base = `s_${base}`;
  let name = base;
  for (let n = 2; used.has(name); n += 1) name = `${base}_${n}`;
  used.add(name);
  return name;
}

/** Attributs lus d'un élément : lien, image, date, `data-*` (valeur non vide et courte). */
function attributesOf(el: Element): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, raw] of Object.entries(el.attribs)) {
    const value = raw.trim();
    if (value === '' || value.length > 500) continue;
    if ((name === 'href' && el.name === 'a' && LINK_HREF(value)) || (name === 'src' && el.name === 'img') || (name === 'datetime' && el.name === 'time') || DATA_ATTR.test(name)) out.push([name, value]);
  }
  return out;
}

function collectSlots(blocks: readonly Element[]): RawSlot[] {
  const slots = new Map<string, RawSlot>();
  let order = 0;
  const touch = (key: string, path: Step[], attr: string, i: number, el: Element, value: string) => {
    let slot = slots.get(key);
    if (slot === undefined) {
      slot = { key, path, attr, values: blocks.map(() => undefined), elements: blocks.map(() => undefined), order: order++ };
      slots.set(key, slot);
    }
    if (slot.values[i] === undefined) {
      slot.values[i] = value;
      slot.elements[i] = el;
    }
  };
  blocks.forEach((block, i) => {
    for (const [name, value] of attributesOf(block)) touch(`@${name}`, [], name, i, block, value);
    const walk = (node: Element, path: Step[]) => {
      for (const kid of childElements(node)) {
        if (SKIP_TAGS.has(kid.name)) continue;
        const kidPath = [...path, stepOf(kid)];
        if (kidPath.length > 10) continue;
        const key = kidPath.map((s) => s.css).join(' > ');
        if (/[\p{L}\p{N}]/u.test(ownText(kid))) {
          const text = textOf(kid);
          if (text !== '') touch(`${key}@text`, kidPath, 'text', i, kid, text);
        }
        for (const [name, value] of attributesOf(kid)) touch(`${key}@${name}`, kidPath, name, i, kid, value);
        walk(kid, kidPath);
      }
    };
    walk(block, []);
  });
  return [...slots.values()].sort((a, b) => a.order - b.order);
}

function buildSlots(blocks: readonly Element[]): DomSlot[] {
  const used = new Set<string>();
  const out: DomSlot[] = [];
  for (const raw of collectSlots(blocks)) {
    const values = raw.values.filter((v): v is string => v !== undefined);
    // Présent dans au moins 30 % des blocs, et variable : un texte identique partout est du décor (« Voir la fiche »).
    if (values.length < Math.max(2, Math.ceil(blocks.length * 0.3))) continue;
    if (new Set(values).size < 2) continue;
    const css = raw.path.length === 0 ? null : slotSelector(raw, blocks);
    if (raw.path.length > 0 && css === null) continue;
    out.push({
      name: slotName(raw, used),
      css,
      attr: raw.attr,
      shape: dominantShape(values, raw.attr),
      present: values.length,
      // Libellé de tête suivi de « : » (« ref : », « Prix : ») ; unité ou devise en fin d'un texte numérique (« m² », « chambres »).
      prefix: raw.attr === 'text' && values.filter((v) => /^[\p{L}][\p{L}'’ -]{0,15}\s*:/u.test(v)).length >= values.length * 0.9 ? constantWord(values, (w) => w[0]) : null,
      suffix: raw.attr === 'text' && /money|area|number/.test(dominantShape(values, raw.attr)) ? constantWord(values, (w) => w.at(-1)) : null,
      decimal: decimalOf(values),
    });
    if (out.length >= MAX_SLOTS) break;
  }
  return out;
}

/**
 * Bloc répété le plus probable d'un document : groupes d'éléments de même signature (au moins `DOM_MIN_BLOCKS`, hors
 * `nav`, `header`, `footer`, aucun imbriqué dans un autre), chacun avec un lien et du texte ; score = occurrences^1,2 ×
 * emplacements (une ligne de deux cartes perd face aux cartes), puis le plus extérieur à score égal. `null` : aucune liste.
 */
export function detectRepeatedBlocks(doc: Document): DomBlocks | null {
  const groups = new Map<string, Element[]>();
  for (const el of allElements(doc)) {
    if (el.name === 'html' || el.name === 'body') continue;
    const sig = signature(el);
    const list = groups.get(sig);
    if (list === undefined) groups.set(sig, [el]);
    else if (list.length <= MAX_BLOCKS) list.push(el);
  }
  type Scored = { blocks: Element[]; records: string; slots: DomSlot[]; score: number; text: number; depth: number };
  const prelim: { blocks: Element[]; text: number }[] = [];
  for (const list of groups.values()) {
    if (list.length < DOM_MIN_BLOCKS || list.length > MAX_BLOCKS) continue;
    const blocks = list.filter((el) => !insideSkipped(el));
    if (blocks.length < DOM_MIN_BLOCKS) continue;
    if (blocks.some((a) => blocks.some((b) => a !== b && isAncestor(a, b)))) continue;
    const texts = blocks.map(textOf);
    const withText = texts.filter((t) => t.length >= 3).length;
    const withLink = blocks.filter(hasLink).length;
    if (withText < blocks.length * 0.8 || withLink < blocks.length * 0.8) continue;
    const avg = texts.reduce((n, t) => n + t.length, 0) / blocks.length;
    if (avg < 15) continue;
    prelim.push({ blocks, text: avg });
  }
  prelim.sort((a, b) => b.blocks.length * Math.min(b.text, 400) - a.blocks.length * Math.min(a.text, 400));
  const scored: Scored[] = [];
  for (const { blocks, text } of prelim.slice(0, MAX_GROUPS_SCORED)) {
    const records = recordsSelector(doc, blocks);
    if (records === null) continue;
    const slots = buildSlots(blocks);
    if (slots.length < 2) continue;
    scored.push({ blocks, records, slots, score: blocks.length ** 1.2 * slots.length, text, depth: depthOf(blocks[0]!) });
  }
  scored.sort((a, b) => b.score - a.score || b.text - a.text || a.depth - b.depth);
  const best = scored[0];
  return best === undefined ? null : { records: best.records, count: best.blocks.length, slots: best.slots };
}

// ---------------------------------------------------------------------------------------------------- pagination

const NEXT_TEXT = /^(?:suivant|suivante|page suivante|next|next page|weiter|siguiente|successivo|›|»|>|→|>>)$/i;

const normalizedPath = (p: string): string => (p.endsWith('/') ? p : `${p}/`);

/**
 * Pagination d'une page de liste (même hôte que la page, jamais un autre domaine : INV10). Ordre : numéros de page dans le
 * chemin (`/page/2/`), paramètre entier de la requête (`?page=2`, `?p=2`, décalage `?start=10`), puis `rel=next` seul.
 * Les liens « suivant » (texte, `aria-label`, `rel`) et numérotés comptent tous. `last` : plus grand numéro vu.
 */
export function detectDomPagination(doc: Document, pageUrl: string, recordCount: number): DomPagination | null {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  const links: URL[] = [];
  let relNext = false;
  for (const el of trySelect('a[href], link[href]', doc, 20_000) ?? []) {
    const href = el.attribs['href'];
    if (!LINK_HREF(href)) continue;
    let url: URL;
    try {
      url = new URL(href!, page);
    } catch {
      continue;
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname !== page.hostname || url.username !== '' || url.password !== '') continue;
    url.hash = '';
    const rel = (el.attribs['rel'] ?? '').toLowerCase().split(/\s+/);
    const label = collapse(el.attribs['aria-label'] ?? textOf(el));
    if (rel.includes('next')) relNext = true;
    if (rel.includes('next') || NEXT_TEXT.test(label) || el.name === 'a') links.push(url);
  }
  const pagePath = normalizedPath(page.pathname);
  // Page de départ déjà numérotée (`/liste/page/2/`) : son propre gabarit et son numéro.
  const own = /^(.*\/)(\d{1,5})(\/?)$/.exec(page.pathname);
  const ownTemplate = own === null ? null : `${own[1]}{page}${own[3]}`;
  const ownNumber = own === null ? null : Number(own[2]);
  // Numéro dans le chemin : `/liste/page/2/` (segment entier, préfixe = chemin de la page).
  const byTemplate = new Map<string, Set<number>>();
  // Paramètre entier : même chemin, autres paramètres identiques à ceux de la page.
  const byParam = new Map<string, Set<number>>();
  const pageParams = new URLSearchParams(page.search);
  for (const url of links) {
    const segments = url.pathname.split('/');
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (!/^\d{1,5}$/.test(segments[i]!)) continue;
      const template = [...segments.slice(0, i), '{page}', ...segments.slice(i + 1)].join('/');
      const prefix = template.slice(0, template.indexOf('{page}'));
      const sameList = template === ownTemplate || (normalizedPath(prefix).startsWith(pagePath) && prefix.length - pagePath.length <= 24);
      if (url.search === page.search && sameList) {
        const set = byTemplate.get(template) ?? new Set<number>();
        set.add(Number(segments[i]));
        byTemplate.set(template, set);
      }
      break;
    }
    if (normalizedPath(url.pathname) !== pagePath) continue;
    for (const [name, value] of url.searchParams) {
      if (!/^\d{1,7}$/.test(value) || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) continue;
      const others = [...url.searchParams].filter(([n]) => n !== name);
      const same = others.length === [...pageParams].filter(([n]) => n !== name).length && others.every(([n, v]) => pageParams.get(n) === v);
      if (!same) continue;
      const set = byParam.get(name) ?? new Set<number>();
      set.add(Number(value));
      byParam.set(name, set);
    }
  }
  const lastOf = (set: Set<number>): number | null => (set.size === 0 ? null : Math.max(...set));
  const paths = [...byTemplate.entries()]
    .filter(([t, s]) => (t === ownTemplate && ownNumber !== null ? s.has(ownNumber + 1) : s.has(2)))
    .sort((a, b) => b[1].size - a[1].size);
  if (paths[0] !== undefined) {
    const [template, set] = paths[0];
    return { type: 'page_param', param: 'url.path', path_pattern: template, start: template === ownTemplate && ownNumber !== null ? ownNumber : 1, last: lastOf(set) };
  }
  const params = [...byParam.entries()].sort((a, b) => b[1].size - a[1].size);
  for (const [name, set] of params) {
    if (set.has(2) || set.has(1)) return { type: 'page_param', param: `url.query.${name}`, start: 1, last: lastOf(set) };
    const step = Math.min(...set);
    if (step > 1 && [...set].every((v) => v % step === 0) && (recordCount === 0 || step === recordCount || set.size >= 2)) {
      return { type: 'offset', param: `url.query.${name}`, start: 0, step, last: lastOf(set) };
    }
  }
  return relNext ? { type: 'next_link', last: null } : null;
}

/** Bloc répété et pagination d'un HTML (servi, ou rendu par Chromium) ; `null` si aucune liste n'y est lisible. */
export function analyzeDom(html: string, pageUrl: string, limits: DslLimits = DEFAULT_DSL_LIMITS): { blocks: DomBlocks; pagination: DomPagination | null } | null {
  let doc: Document;
  try {
    doc = parseHtml(html, limits);
  } catch {
    return null;
  }
  const blocks = detectRepeatedBlocks(doc);
  if (blocks === null) return null;
  return { blocks, pagination: detectDomPagination(doc, pageUrl, blocks.count) };
}

/**
 * Description d'un emplacement montrée au LLM d'enquête (valeur du squelette) : sorte, forme, présence et libellés
 * constants, jamais une valeur propre à un bloc.
 */
export function slotDescription(slot: DomSlot, count: number): string {
  const kind = slot.attr === 'text' ? 'text' : slot.attr === 'href' ? 'link' : slot.attr === 'src' ? 'image' : `attribute ${slot.attr}`;
  return [kind, `shape=${slot.shape}`, `present=${slot.present}/${count}`, ...(slot.prefix === null ? [] : [`prefix=${slot.prefix}`]), ...(slot.suffix === null ? [] : [`suffix=${slot.suffix}`])].join(';');
}

/** Pagination seule d'une page HTML (même hôte), sans exiger de bloc répété détecté : page d'un essai E4 compilé. */
export function detectHtmlPagination(html: string, pageUrl: string, recordCount: number, limits: DslLimits = DEFAULT_DSL_LIMITS): DomPagination | null {
  try {
    return detectDomPagination(parseHtml(html, limits), pageUrl, recordCount);
  } catch {
    return null;
  }
}
