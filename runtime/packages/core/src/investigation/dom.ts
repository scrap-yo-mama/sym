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
// - PAGINATION : `rel=next`, liens numérotés `/page/N/`, numéro dans un segment (`page-2.html`, `liste_1.html`),
//   `?page=N`, `?p=N` (ou tout paramètre entier), décalage `?start=10`, lien « suivant » (libellé, flèche, classe `next` :
//   `next-link.ts`), liens relatifs résolus contre la page ; le numéro du lien « suivant » fixe le départ (page de base sans
//   suffixe puis `_1` : départ 0) ; même hôte que la page seulement (INV10). Règles d'arrêt : page vide, page 404, page
//   déjà vue ou doublons (exécuteur déclaratif), plafond dur ;
// - TABLEAUX (banc réel R06, R08) : un `<table>` dont les lignes à cellules `td` sont les enregistrements (ni la ligne
//   d'en-tête en `th`, ni une ligne de total), chaque colonne nommée par le texte de son en-tête, ses sous-éléments (gras,
//   italique, liens) en emplacements de la colonne ;
// - VALEURS EN CLASSE (note « star-rating Three », R07) : une classe propre à certains blocs, à côté d'une classe stable,
//   devient un emplacement `class` lu par le code (mot-nombre, chiffre ou mot) ; un texte tronqué par « ... » dont
//   l'attribut `title` porte la valeur complète fait lire `title` ; un libellé constant court (« In stock ») reste un
//   emplacement (`constant=yes`), jamais requis ;
// - cartes SANS lien (page équipe, R03) : admises si elles portent plusieurs textes ; une carte d'une autre structure que
//   la majorité du groupe (encart, bloc de valeurs) en est écartée quand un sélecteur sait la laisser de côté.
// Ce que le LLM d'enquête voit d'un bloc : les NOMS d'emplacements et leur description (forme, présence, libellés
// constants), jamais une valeur propre à un enregistrement (08 §4, 17 §6). Fonctions pures, sans I/O.
import type { AnyNode, Document, Element } from 'domhandler';
import { compileSelector, elementText, parseHtml, selectElements } from '../dsl/css.js';
import { DEFAULT_DSL_LIMITS, type DslLimits } from '../dsl/limits.js';
import { isNextAnchor } from '../dsl/next-link.js';

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
  /**
   * Même texte sur tous les blocs de la page (« In stock ») : gardé, jamais requis ; `label` : ce texte quand il est un
   * libellé montrable (lettres et espaces, 4 mots au plus), sinon `null`.
   */
  readonly constant?: { readonly label: string | null };
  /**
   * Valeur portée par une classe (`attr: class`, note « star-rating Three ») : classe stable voisine (`anchor`) et position
   * de la classe variable par rapport à elle ; `kind` : mot-nombre (One…Ten), chiffre (`rating-4`) ou mot ; `words` : mots
   * vus (forme `word` seulement, au plus 8).
   */
  readonly classValue?: { readonly anchor: string; readonly position: 'after' | 'before'; readonly kind: 'number_word' | 'number_digit' | 'word'; readonly words: readonly string[] };
  /** Balise de l'élément lu (`h2`, `a`…) : un titre `h1`-`h6` identifie l'enregistrement, quel que soit son sélecteur. */
  readonly tag?: string;
  /** Séparateur qui termine (presque) toutes les valeurs (« Hybrid — ») : retiré par le code. */
  readonly trailing?: string;
  /** Titre du GROUPE de blocs (banc réel R04, équipe d'une offre) : `css` est cherché sous le N-ième ancêtre du bloc. */
  readonly up?: number;
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

// `button` n'est pas sauté : le nom d'une carte d'équipe peut être le texte d'un bouton (R03) ; un bouton n'est jamais
// lui-même un bloc (`NOT_BLOCKS`), et son texte constant (« Ajouter au panier ») n'est qu'un libellé.
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'svg', 'math', 'iframe', 'object', 'embed', 'canvas', 'select', 'option']);
/** Balises jamais choisies comme bloc répété : structure d'un tableau (lu par `detectTables`), contrôles de formulaire. */
const NOT_BLOCKS = new Set(['html', 'body', 'tr', 'td', 'th', 'tbody', 'thead', 'tfoot', 'table', 'button', 'input', 'label', 'form']);
const LANDMARKS = new Set(['nav', 'header', 'footer']);
/** Classe utilisable dans un sélecteur sans échappement (les variantes Tailwind `md:block`, `w-[33px]`, `group/x` sont ignorées). */
const CLASS_OK = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const STATE_CLASSES = new Set(['active', 'current', 'selected', 'hidden', 'show', 'open', 'is-active', 'is-current', 'odd', 'even', 'first', 'last', 'disabled', 'lazy', 'loaded', 'lazyloaded']);
/** Classe utilitaire (Tailwind, Bootstrap) : jamais choisie pour nommer ou désigner si une classe parlante existe. */
const UTILITY =
  /^(?:[a-z]{1,3}-?\d|(?:block|inline|flex|grid|hidden|relative|absolute|fixed|sticky|static|truncate|uppercase|lowercase|capitalize|italic|underline|container|clearfix|group|peer|shadow|rounded|border|transition|duration|ease|delay|transform|cursor|select|pointer|overflow|object|aspect|z|top|left|right|bottom|inset|w|h|min|max|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|space|gap|divide|text|font|leading|tracking|bg|fill|stroke|opacity|items|justify|content|self|place|order|col|row|basis|grow|shrink|float|clear|sr|not|visible|invisible|whitespace|break|line|list|decoration|align|vertical|table|display|small|d|g|lg|md|sm|xl|xs|js|out|icon|svg)(?:-|$))/;
const DATA_ATTR = /^data-[a-z0-9_-]{1,40}$/;
const LINK_HREF = (href: string | undefined): boolean => href !== undefined && href.trim() !== '' && !/^\s*(#|javascript:|mailto:|tel:)/i.test(href);

const isTag = (n: AnyNode): n is Element => n.type === 'tag' || n.type === 'script' || n.type === 'style';
const childElements = (el: Element | Document): Element[] => el.children.filter(isTag);
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Classes utilisables d'un élément, sans les classes VARIABLES du groupe en cours d'analyse (`withStableClasses`). */
let variantClasses: ReadonlySet<string> | null = null;

function rawClasses(el: Element): string[] {
  const raw = el.attribs['class'];
  if (raw === undefined) return [];
  return [...new Set(raw.split(/\s+/).filter((c) => c !== '' && CLASS_OK.test(c) && !STATE_CLASSES.has(c.toLowerCase())))];
}

function classesOf(el: Element): string[] {
  const all = rawClasses(el);
  return variantClasses === null ? all : all.filter((c) => !variantClasses!.has(c));
}

/** `fn` voit les éléments sans les classes `variants` (pas d'un chemin, signature des frères, sélecteurs). */
function withStableClasses<T>(variants: ReadonlySet<string>, fn: () => T): T {
  const previous = variantClasses;
  variantClasses = variants;
  try {
    return fn();
  } finally {
    variantClasses = previous;
  }
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

/**
 * Tous les éléments sous `root` (parcours itératif), hors balises sans contenu lisible, dans l'ORDRE DU DOCUMENT : un
 * groupe de blocs se compare tel quel au résultat d'un sélecteur (frères compris : banc réel R08, lignes d'un tableau
 * rendues à l'envers et sélecteur des enregistrements refusé).
 */
function allElements(root: Document | Element): Element[] {
  const out: Element[] = [];
  const stack: Element[] = [];
  const pushKids = (node: Document | Element) => {
    const kids = childElements(node);
    for (let i = kids.length - 1; i >= 0; i -= 1) if (!SKIP_TAGS.has(kids[i]!.name)) stack.push(kids[i]!);
  };
  pushKids(root);
  while (stack.length > 0) {
    const node = stack.pop()!;
    out.push(node);
    pushKids(node);
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
  // Classe parlante SANS balise d'abord (banc réel R02 : l'adresse est un `h3` sur une carte, un `p` sur l'autre gabarit,
  // même classe) ; puis balise et classe, pas complet, parent > enfant, chemin complet.
  const semantic = (el: Element): string[] => classesOf(el).filter((c) => !UTILITY.test(c)).slice(0, 2);
  const base: string[] = [...semantic(last.el).map((c) => `.${c}`), ...last.bare.slice(0, 3), last.css];
  if (parent !== undefined) base.push(...semantic(parent.el).slice(0, 1).map((c) => `.${c} > ${last.css}`), `${parent.bare[0]} > ${last.css}`, `${parent.css} > ${last.css}`);
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


/** Classes variables d'un groupe : présentes dans au plus la moitié des blocs (note « Three », état « sold »). */
function variantsOf(blocks: readonly Element[]): Set<string> {
  const freq = new Map<string, number>();
  for (const block of blocks) {
    const seen = new Set<string>();
    for (const el of [block, ...allElements(block)]) for (const c of rawClasses(el)) seen.add(c);
    for (const c of seen) freq.set(c, (freq.get(c) ?? 0) + 1);
  }
  return new Set([...freq].filter(([, n]) => n <= blocks.length * 0.5).map(([c]) => c));
}

function collectSlots(blocks: readonly Element[], variants: ReadonlySet<string>): RawSlot[] {
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
        // Valeur en classe : une classe variable à côté d'une classe stable (« star-rating Three »).
        const varying = rawClasses(kid).filter((c) => variants.has(c));
        if (varying.length > 0 && classesOf(kid).length > 0) touch(`${key}@class`, kidPath, 'class', i, kid, varying.join(' '));
        walk(kid, kidPath);
      }
    };
    walk(block, []);
  });
  return mergeExclusive([...slots.values()], blocks.length).sort((a, b) => a.order - b.order);
}

/**
 * Emplacements de même élément final (balise, classes, attribut) atteints par des chemins différents selon le bloc, jamais
 * deux dans le même bloc (banc réel R06 : nom de commune en `td > a` sur 150 lignes, en `td > b > a` sur une) : réunis en
 * un seul, au chemin le plus fréquent, dont le sélecteur court (`a`) vaut pour tous les blocs.
 */
function mergeExclusive(raws: RawSlot[], count: number): RawSlot[] {
  // Deux passes : même chemin au rang près (`a` seul dans une cellule, `a:nth-of-type(1)` quand il a un frère : R08, ville
  // du lieu), puis même élément final par des chemins différents (`td > a`, `td > b > a` : R06).
  return mergeBy(mergeBy(raws, count, (raw) => raw.key.replace(/:nth-of-type\(1\)@/, '@')), count, (raw) => {
    const last = raw.path.at(-1);
    return last === undefined ? null : `${signature(last.el)}@${raw.attr}`;
  });
}

function mergeBy(raws: RawSlot[], count: number, keyOf: (raw: RawSlot) => string | null): RawSlot[] {
  const groups = new Map<string, RawSlot[]>();
  for (const raw of raws) {
    if (raw.path.length === 0) continue;
    const key = keyOf(raw);
    if (key === null) continue;
    groups.set(key, [...(groups.get(key) ?? []), raw]);
  }
  const merged = new Set<RawSlot>();
  const out: RawSlot[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const exclusive = Array.from({ length: count }, (_, i) => group.filter((r) => r.values[i] !== undefined).length).every((n) => n <= 1);
    if (!exclusive) continue;
    // Chemin du plus fréquent ; à fréquence égale, le plus précis (`a:nth-of-type(1)` plutôt que `a`).
    const main = [...group].sort((a, b) => b.values.filter((v) => v !== undefined).length - a.values.filter((v) => v !== undefined).length || b.key.length - a.key.length)[0]!;
    const pick = (i: number) => group.find((r) => r.values[i] !== undefined);
    out.push({
      key: `${main.key}~merged`,
      path: main.path,
      attr: main.attr,
      values: Array.from({ length: count }, (_, i) => pick(i)?.values[i]),
      elements: Array.from({ length: count }, (_, i) => pick(i)?.elements[i]),
      order: Math.min(...group.map((r) => r.order)),
    });
    for (const r of group) merged.add(r);
  }
  return [...raws.filter((r) => !merged.has(r)), ...out];
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'] as const;
const NUMBER_WORD = new RegExp(`^(?:${NUMBER_WORDS.join('|')})$`, 'i');
const NUMBER_DIGIT = /^[A-Za-z_-]{0,20}\d{1,2}[A-Za-z_-]{0,20}$/;
const CLASS_WORD = /^[A-Za-z][A-Za-z_-]{0,30}$/;

/** Valeur en classe d'un emplacement `class` : une seule classe variable par bloc, une classe stable commune, même ordre partout. */
function classValueOf(raw: RawSlot, values: readonly string[]): NonNullable<DomSlot['classValue']> | null {
  if (values.some((v) => v.includes(' '))) return null;
  const elements = raw.elements.filter((e): e is Element => e !== undefined);
  const common = classesOf(elements[0]!).filter((c) => elements.every((e) => classesOf(e).includes(c)));
  const anchor = common.find((c) => !UTILITY.test(c)) ?? common[0];
  if (anchor === undefined) return null;
  const positions = new Set(
    elements.map((e, k) => {
      const all = (e.attribs['class'] ?? '').split(/\s+/).filter((c) => c !== '');
      return all.indexOf(values[k]!) > all.indexOf(anchor) ? 'after' : 'before';
    }),
  );
  if (positions.size !== 1) return null;
  const position = [...positions][0] as 'after' | 'before';
  const distinct = [...new Set(values)];
  if (values.every((v) => NUMBER_WORD.test(v))) return { anchor, position, kind: 'number_word', words: [] };
  if (values.every((v) => NUMBER_DIGIT.test(v))) return { anchor, position, kind: 'number_digit', words: [] };
  if (distinct.length <= 8 && distinct.every((v) => CLASS_WORD.test(v))) return { anchor, position, kind: 'word', words: distinct };
  return null;
}

/**
 * Opérateurs fixés par le CODE pour lire une valeur en classe (`attr: class`) : la classe variable voisine de la classe
 * stable, puis, pour un nombre, la table des mots-nombres (« Three » → 3) ou le chiffre (« rating-4 » → 4). Aucune valeur
 * ne vient du modèle ; une note jamais vue en page 1 se lit pareil.
 */
export function classValueOps(cv: NonNullable<DomSlot['classValue']>, type: string): (string | Record<string, unknown>)[] {
  const token = '([A-Za-z0-9_\\-]+)';
  const pattern = cv.position === 'after' ? `${cv.anchor.replace(/-/g, '\\-')} ${token}` : `${token} ${cv.anchor.replace(/-/g, '\\-')}`;
  const ops: (string | Record<string, unknown>)[] = ['collapse_spaces', { op: 'regex_extract', pattern, group: 1 }];
  if (type !== 'number' && type !== 'integer') return ops;
  if (cv.kind === 'number_word') return [...ops, 'lower', { op: 'map_value', table: Object.fromEntries(NUMBER_WORDS.map((w, k) => [w, k])) }];
  if (cv.kind === 'number_digit') return [...ops, { op: 'regex_extract', pattern: '[0-9]+', group: 0 }, { op: type === 'number' ? 'to_number' : 'to_integer' }];
  return ops;
}

/** Libellé constant montrable au LLM : lettres et espaces, 4 mots au plus (« In stock »), jamais un chiffre. */
const CONSTANT_LABEL = /^[\p{L}][\p{L} '’-]{0,29}$/u;
const ELLIPSIS = /(?:\.\.\.|…)\s*$/;

/**
 * Texte tronqué (« Un titre tres lon... ») dont l'élément porte la valeur complète dans `title` (banc réel R07) : les valeurs
 * de `title`, ou `null` si un seul bloc ne s'y prête pas (title absent, ou qui ne prolonge pas le texte).
 */
function untruncatedTitles(raw: RawSlot): (string | undefined)[] | null {
  const values = raw.values;
  if (!values.some((v) => v !== undefined && ELLIPSIS.test(v))) return null;
  const titles = raw.elements.map((el) => (el === undefined ? undefined : collapse(el.attribs['title'] ?? '')));
  for (const [i, v] of values.entries()) {
    if (v === undefined) continue;
    const t = titles[i];
    if (t === undefined || t === '') return null;
    const stem = collapse(v.replace(ELLIPSIS, ''));
    if (!t.startsWith(stem)) return null;
  }
  return titles;
}

type SlotOptions = {
  readonly maxSlots?: number;
  /** Préfixe du nom (colonne d'un tableau : `exhibition_name_`) et du sélecteur (cellule : `td:nth-child(1)`). */
  readonly namePrefix?: string;
  readonly cssPrefix?: string;
  /** Noms déjà pris (colonnes d'un même tableau). */
  readonly used?: Set<string>;
  /** Valeurs de la cellule entière : un sous-emplacement de même texte partout est redondant. */
  readonly sameAs?: readonly (string | undefined)[];
};

function buildSlots(blocks: readonly Element[], options: SlotOptions = {}): DomSlot[] {
  const variants = variantsOf(blocks);
  return withStableClasses(variants, () => {
    const used = options.used ?? new Set<string>();
    const out: DomSlot[] = [];
    let constants = 0;
    for (const raw of collectSlots(blocks, variants)) {
      const present = raw.values.filter((v): v is string => v !== undefined);
      // Présent dans au moins 30 % des blocs.
      if (present.length < Math.max(2, Math.ceil(blocks.length * 0.3))) continue;
      if (raw.attr === 'src' && options.cssPrefix !== undefined) continue; // icônes d'une cellule de tableau
      let attr = raw.attr;
      let values = present;
      let classValue: NonNullable<DomSlot['classValue']> | null = null;
      if (raw.attr === 'class') {
        classValue = classValueOf(raw, present);
        if (classValue === null) continue;
      }
      // Texte tronqué (« ... ») dont `title` porte la valeur complète : lu dans `title` (avant le contrôle de variabilité :
      // vingt titres tronqués au même préfixe restent vingt titres différents).
      if (attr === 'text') {
        const titles = untruncatedTitles(raw);
        if (titles !== null) {
          attr = 'title';
          values = titles.filter((v): v is string => v !== undefined);
        }
      }
      let constant: DomSlot['constant'] | undefined;
      if (new Set(values).size < 2) {
        // Variable, sauf un libellé court présent sur (presque) tous les blocs (« In stock ») : gardé, jamais requis. Un texte
        // plus long ou une image identique partout est du décor (« Voir la fiche complète du bien »).
        const only = values[0]!;
        const words = only.split(/\s+/).length;
        if (attr !== 'text' || present.length < blocks.length * 0.9 || constants >= 4 || !CONSTANT_LABEL.test(only) || words > 4) continue;
        constant = { label: only };
        constants += 1;
      }
      if (options.sameAs !== undefined && attr === 'text' && raw.values.every((v, i) => v === undefined || v === options.sameAs![i])) continue;
      const css = raw.path.length === 0 ? null : slotSelector(raw, blocks);
      if (raw.path.length > 0 && css === null) continue;
      const shape = classValue !== null ? (classValue.kind === 'word' ? 'class_word' : 'class_number') : dominantShape(values, attr);
      const name = raw.path.length === 0 && options.namePrefix !== undefined ? uniqueName(`${options.namePrefix}${NAME_SAFE(attr)}`, used) : uniqueName(`${options.namePrefix ?? ''}${slotName(raw, new Set())}`, used);
      out.push({
        name,
        tag: (raw.path.at(-1)?.el ?? blocks[0]!).name,
        css: options.cssPrefix === undefined ? css : css === null ? options.cssPrefix : `${options.cssPrefix} ${css}`,
        attr,
        shape,
        present: present.length,
        // Libellé de tête suivi de « : » (« ref : », « Prix : ») ; unité ou devise en fin d'un texte numérique (« m² », « chambres »).
        prefix: attr === 'text' && values.filter((v) => /^[\p{L}][\p{L}'’ -]{0,15}\s*:/u.test(v)).length >= values.length * 0.9 ? constantWord(values, (w) => w[0]) : null,
        suffix: attr === 'text' && /money|area|number/.test(shape) ? constantWord(values, (w) => w.at(-1)) : null,
        decimal: decimalOf(values),
        ...(attr === 'text' && trailingSeparator(values) !== null ? { trailing: trailingSeparator(values)! } : {}),
        ...(constant === undefined ? {} : { constant }),
        ...(classValue === null ? {} : { classValue }),
      });
      if (out.length >= (options.maxSlots ?? MAX_SLOTS)) break;
    }
    return out;
  });
}

/** Séparateur final commun à 90 % des valeurs (« Hybrid — », « Paris | ») : jamais une partie de la valeur. */
function trailingSeparator(values: readonly string[]): string | null {
  const ends = values.map((v) => /\s([—–\-|·•:,/])$/u.exec(v)?.[1] ?? null);
  const first = ends[0];
  return first !== null && first !== undefined && ends.filter((e) => e === first).length >= values.length * 0.9 ? first : null;
}

/** Nom libre parmi `used` (suffixe `_2`, `_3`…), réservé. */
function uniqueName(base: string, used: Set<string>): string {
  let clean = NAME_SAFE(base).slice(0, 48) || 'slot';
  if (!/^[a-z]/.test(clean)) clean = `s_${clean}`;
  let name = clean;
  for (let n = 2; used.has(name); n += 1) name = `${clean}_${n}`;
  used.add(name);
  return name;
}

/** Signatures des descendants d'un bloc (deux niveaux) : sa structure, comparée à celle des autres blocs du groupe. */
function structureOf(el: Element): Set<string> {
  const out = new Set<string>();
  for (const kid of childElements(el)) {
    if (SKIP_TAGS.has(kid.name)) continue;
    out.add(signature(kid));
    for (const grand of childElements(kid)) if (!SKIP_TAGS.has(grand.name)) out.add(`${signature(kid)}>${signature(grand)}`);
  }
  return out;
}

/**
 * Blocs de la structure majoritaire du groupe (banc réel R03 : 3 encarts « valeurs » de même classe que les 78 cartes
 * d'équipe) : la structure majoritaire réunit les signatures présentes dans au moins la moitié des blocs ; un bloc qui en
 * partage moins de la moitié est écarté.
 */
function majorityStructure(blocks: readonly Element[]): Element[] {
  const structures = blocks.map(structureOf);
  const counts = new Map<string, number>();
  for (const s of structures) for (const k of s) counts.set(k, (counts.get(k) ?? 0) + 1);
  const major = new Set([...counts].filter(([, n]) => n >= blocks.length * 0.5).map(([k]) => k));
  if (major.size === 0) return [...blocks];
  return blocks.filter((_, i) => {
    const s = structures[i]!;
    const shared = [...s].filter((k) => major.has(k)).length;
    return shared / Math.max(1, new Set([...s, ...major]).size) >= 0.5;
  });
}

/**
 * Titres de GROUPE (banc réel R04 : offres réunies par équipe sous un titre de section) : les blocs sont répartis entre
 * plusieurs conteneurs (parent, ou grand-parent), et chaque conteneur porte, AVANT ses blocs, un enfant de même signature
 * avec du texte, différent d'un conteneur à l'autre. L'emplacement lit ce titre par un sélecteur cherché sous l'ancêtre
 * (`up`), vérifié sur chaque conteneur (premier élément trouvé = le titre).
 */
function groupHeadingSlots(blocks: readonly Element[], used: Set<string>): DomSlot[] {
  const out: DomSlot[] = [];
  for (const up of [1, 2]) {
    const containers = blocks.map((b) => {
      let c: Element | null = b;
      for (let n = 0; n < up && c !== null; n += 1) c = c.parent !== null && c.parent.type === 'tag' ? (c.parent as Element) : null;
      return c;
    });
    if (containers.some((c) => c === null)) continue;
    const distinct = [...new Set(containers as Element[])];
    if (distinct.length < 2 || distinct.length > blocks.length) continue;
    // Enfants du conteneur placés avant son premier bloc, porteurs d'un texte, sans bloc dedans.
    const headsOf = new Map<Element, Map<string, Element>>();
    for (const c of distinct) {
      const heads = new Map<string, Element>();
      for (const kid of childElements(c)) {
        if (blocks.some((b) => b === kid || isAncestor(kid, b))) break;
        if (SKIP_TAGS.has(kid.name) || textOf(kid) === '') continue;
        if (!heads.has(signature(kid))) heads.set(signature(kid), kid);
      }
      headsOf.set(c, heads);
    }
    const signatures = new Map<string, number>();
    for (const heads of headsOf.values()) for (const sig of heads.keys()) signatures.set(sig, (signatures.get(sig) ?? 0) + 1);
    for (const [sig, n] of signatures) {
      if (n < distinct.length * 0.8) continue;
      const sample = [...headsOf.values()].find((h) => h.has(sig))!.get(sig)!;
      const values = containers.map((c) => {
        const head = headsOf.get(c as Element)?.get(sig);
        return head === undefined ? undefined : textOf(head);
      });
      const present = values.filter((v): v is string => v !== undefined && v !== '');
      if (new Set(present).size < 2 || present.length < blocks.length * 0.8) continue;
      const css = [...rankedClasses(sample).map((c) => '.' + c), [sample.name, ...classesOf(sample)].join('.')].find((candidate) =>
        distinct.every((c) => {
          const head = headsOf.get(c)?.get(sig);
          const found = trySelect(candidate, c, 1_000);
          return found !== null && (head === undefined ? found.length === 0 : found[0] === head);
        }),
      );
      if (css === undefined) continue;
      const semantic = classesOf(sample).find((c) => !UTILITY.test(c));
      out.push({
        name: uniqueName(`group_${semantic === undefined ? sample.name : NAME_SAFE(semantic)}`, used),
        css,
        attr: 'text',
        shape: dominantShape(present, 'text'),
        present: present.length,
        prefix: null,
        suffix: null,
        decimal: decimalOf(present),
        up,
      });
      if (out.length >= 2) return out;
    }
    if (out.length > 0) return out;
  }
  return out;
}

/** Le bloc porte plusieurs textes (nom, poste, lieu) : une carte sans lien reste une carte. */
const textSlots = (el: Element): number => allElements(el).filter((e) => /[\p{L}\p{N}]/u.test(ownText(e))).length;

type ScoredBlocks = DomBlocks & { readonly score: number };

/**
 * Bloc répété le plus probable d'un document : groupes d'éléments de même signature (au moins `DOM_MIN_BLOCKS`, hors
 * `nav`, `header`, `footer`, aucun imbriqué dans un autre, ni structure de tableau ni contrôle de formulaire), chacun avec
 * du texte et un lien, ou au moins deux textes (carte sans lien, R03, score réduit) ; un bloc d'une autre structure que la
 * majorité est écarté quand un sélecteur sait le laisser de côté. Score = occurrences^1,2 × emplacements (une ligne de deux
 * cartes perd face aux cartes), puis le plus extérieur à score égal. `null` : aucune liste.
 */
function scoredRepeatedBlocks(doc: Document): ScoredBlocks | null {
  const groups = new Map<string, Element[]>();
  for (const el of allElements(doc)) {
    if (NOT_BLOCKS.has(el.name)) continue;
    const sig = signature(el);
    const list = groups.get(sig);
    if (list === undefined) groups.set(sig, [el]);
    else if (list.length <= MAX_BLOCKS) list.push(el);
  }
  type Scored = { blocks: Element[]; records: string; slots: DomSlot[]; score: number; text: number; depth: number };
  const prelim: { blocks: Element[]; fallback: Element[] | null; text: number; linkless: boolean }[] = [];
  for (const list of groups.values()) {
    if (list.length < DOM_MIN_BLOCKS || list.length > MAX_BLOCKS) continue;
    const all = list.filter((el) => !insideSkipped(el));
    if (all.length < DOM_MIN_BLOCKS) continue;
    if (all.some((a) => all.some((b) => a !== b && isAncestor(a, b)))) continue;
    // Structure majoritaire d'abord ; le groupe entier en repli si aucun sélecteur ne sait écarter les autres blocs.
    const kept = majorityStructure(all);
    const blocks = kept.length < all.length && kept.length >= DOM_MIN_BLOCKS ? kept : all;
    const texts = blocks.map(textOf);
    const withText = texts.filter((t) => t.length >= 3).length;
    const withLink = blocks.filter(hasLink).length;
    if (withText < blocks.length * 0.8) continue;
    const linkless = withLink < blocks.length * 0.8;
    if (linkless && blocks.filter((b) => textSlots(b) >= 2).length < blocks.length * 0.8) continue;
    const avg = texts.reduce((n, t) => n + t.length, 0) / blocks.length;
    if (avg < 15) continue;
    prelim.push({ blocks, fallback: blocks === all ? null : all, text: avg, linkless });
  }
  prelim.sort((a, b) => b.blocks.length * Math.min(b.text, 400) - a.blocks.length * Math.min(a.text, 400));
  const scored: Scored[] = [];
  for (const entry of prelim.slice(0, MAX_GROUPS_SCORED)) {
    const { text, linkless } = entry;
    let blocks = entry.blocks;
    let records = recordsSelector(doc, blocks);
    // Groupe entier en repli : des blocs d'une autre structure y restent ; son score en tient compte.
    let mixed = 1;
    if (records === null && entry.fallback !== null) {
      mixed = (blocks.length / entry.fallback.length) ** 2;
      blocks = entry.fallback;
      records = recordsSelector(doc, blocks);
    }
    if (records === null) continue;
    const slots = [...buildSlots(blocks)];
    if (slots.length < 2) continue;
    const used = new Set(slots.map((x) => x.name));
    for (const head of groupHeadingSlots(blocks, used)) if (slots.length < MAX_SLOTS + 2) slots.push(head);
    scored.push({ blocks, records, slots, score: blocks.length ** 1.2 * slots.length * (linkless ? 0.6 : 1) * mixed, text, depth: depthOf(blocks[0]!) });
  }
  scored.sort((a, b) => b.score - a.score || b.text - a.text || a.depth - b.depth);
  const best = scored[0];
  return best === undefined ? null : { records: best.records, count: best.blocks.length, slots: best.slots, score: best.score };
}

export function detectRepeatedBlocks(doc: Document): DomBlocks | null {
  const best = scoredRepeatedBlocks(doc);
  return best === null ? null : { records: best.records, count: best.count, slots: best.slots };
}

// ---------------------------------------------------------------------------------------------------- tableaux

const MAX_TABLE_SLOTS = 40;
/** Première cellule d'une ligne de total (en `td`), à laisser hors des enregistrements. */
const TOTAL_ROW = /^(?:total|totaux|totals|ensemble|somme|sum|grand total|moyenne|average|overall)\b/i;

const cellsOf = (tr: Element): Element[] => childElements(tr).filter((c) => c.name === 'td' || c.name === 'th');

/** Lignes d'un tableau (directes, ou sous `thead`, `tbody`, `tfoot`), jamais celles d'un tableau imbriqué. */
function rowsOf(table: Element): Element[] {
  const rows: Element[] = [];
  for (const kid of childElements(table)) {
    if (kid.name === 'tr') rows.push(kid);
    else if (kid.name === 'thead' || kid.name === 'tbody' || kid.name === 'tfoot') for (const r of childElements(kid)) if (r.name === 'tr') rows.push(r);
  }
  return rows;
}

/** Nom d'une colonne tiré de son en-tête (« Superficie (km²) » → `superficie_km2`), sans accent, borné. */
function columnName(text: string, k: number, used: Set<string>): string {
  const folded = text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/²/g, '2').replace(/³/g, '3');
  const base = NAME_SAFE(folded).slice(0, 32).replace(/_+$/, '') || `col_${k + 1}`;
  return uniqueName(base, used);
}

/**
 * Tableau le plus probable du document (banc réel R06, R08) : lignes à cellules `td` (au moins `DOM_MIN_BLOCKS`, même nombre
 * de cellules pour 80 % d'entre elles), sans la ligne d'en-tête (cellules `th`) ni une ligne de total finale ; sélecteur
 * des lignes vérifié (`tr:has(> td)`) ; un emplacement par colonne (texte de la cellule, nommé par l'en-tête) et par
 * sous-élément utile de la cellule (gras, italique, lien, attribut `data-*`). Score comparable à celui des blocs répétés.
 */
function scoredTable(doc: Document): ScoredBlocks | null {
  let best: ScoredBlocks | null = null;
  for (const table of trySelect('table', doc, 500) ?? []) {
    if (insideSkipped(table)) continue;
    const rows = rowsOf(table);
    let data = rows.filter((r) => cellsOf(r).some((c) => c.name === 'td'));
    if (data.length < DOM_MIN_BLOCKS) continue;
    const counts = new Map<number, number>();
    for (const r of data) counts.set(cellsOf(r).length, (counts.get(cellsOf(r).length) ?? 0) + 1);
    const [cols] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    if (cols < 2) continue;
    const regular = data.filter((r) => cellsOf(r).length === cols);
    if (regular.length < DOM_MIN_BLOCKS || regular.length < data.length * 0.8) continue;
    data = regular;
    let notLast = false;
    const lastRow = data.at(-1)!;
    if (TOTAL_ROW.test(textOf(cellsOf(lastRow)[0]!))) {
      const siblings = lastRow.parent === null ? [] : childElements(lastRow.parent as Element);
      if (siblings.at(-1) !== lastRow) continue;
      data = data.slice(0, -1);
      notLast = true;
    }
    if (data.length < DOM_MIN_BLOCKS) continue;
    const avg = data.reduce((n, r) => n + textOf(r).length, 0) / data.length;
    if (avg < 8) continue;
    const id = table.attribs['id'];
    const tableSels = [...(id !== undefined && CLASS_OK.test(id) ? [`table#${id}`] : []), ...rankedClasses(table).slice(0, 2).map((c) => `table.${c}`), 'table'];
    const tail = `tr:has(> td)${notLast ? ':not(:last-child)' : ''}`;
    let records: string | null = null;
    for (const t of tableSels) {
      for (const css of [`${t} > tbody > ${tail}`, `${t} > ${tail}`, `${t} ${tail}`]) {
        const found = trySelect(css, doc);
        if (found !== null && sameSet(found, data)) {
          records = css;
          break;
        }
      }
      if (records !== null) break;
    }
    if (records === null) continue;
    const header = rows
      .slice(0, rows.indexOf(data[0]!))
      .reverse()
      .find((r) => cellsOf(r).length > 0 && cellsOf(r).every((c) => c.name === 'th'));
    const used = new Set<string>();
    const headerCells = header === undefined ? [] : cellsOf(header);
    const slots: DomSlot[] = [];
    for (let k = 0; k < cols && slots.length < MAX_TABLE_SLOTS; k += 1) {
      const cells = data.map((r) => cellsOf(r)[k]!);
      const tags = new Set(cells.map((c) => c.name));
      const cellCss = tags.size === 1 ? `${cells[0]!.name}:nth-child(${k + 1})` : `:nth-child(${k + 1})`;
      const name = columnName(headerCells[k] === undefined ? '' : textOf(headerCells[k]!), k, used);
      const texts = cells.map((c) => textOf(c));
      const present = texts.filter((t) => t !== '');
      if (present.length >= Math.max(2, Math.ceil(cells.length * 0.3)) && new Set(present).size >= 2) {
        const shape = dominantShape(present, 'text');
        slots.push({
          name,
          css: cellCss,
          attr: 'text',
          shape,
          present: present.length,
          prefix: null,
          suffix: /money|area|number/.test(shape) ? constantWord(present, (w) => w.at(-1)) : null,
          decimal: decimalOf(present),
        });
      }
      const subs = buildSlots(cells, { maxSlots: 6, namePrefix: `${name}_`, cssPrefix: cellCss, used, sameAs: texts.map((t) => (t === '' ? undefined : t)) });
      for (const s of subs) if (slots.length < MAX_TABLE_SLOTS) slots.push(s);
    }
    if (slots.length < 2) continue;
    const score = data.length ** 1.2 * slots.length;
    if (best === null || score > best.score) best = { records, count: data.length, slots, score };
  }
  return best;
}

/** Tableau le plus probable du document (lignes, colonnes nommées par l'en-tête), ou `null`. */
export function detectTables(doc: Document): DomBlocks | null {
  const best = scoredTable(doc);
  return best === null ? null : { records: best.records, count: best.count, slots: best.slots };
}

// ---------------------------------------------------------------------------------------------------- pagination

const normalizedPath = (p: string): string => (p.endsWith('/') ? p : `${p}/`);
/** Dernier fichier « d'index » d'un répertoire : la page 1 d'une liste dont les suivantes sont `page-N.html`. */
const INDEX_FILE = /^(?:|index\.[a-z]{2,5}|default\.[a-z]{2,5})$/i;
const PAGE_WORD = /(?:^|[^a-z])(?:page|pages|p|pg|seite|pagina|strona)(?:[^a-z]|$)/i;

/** Numéro de page d'un chemin : la dernière suite de chiffres du dernier segment non vide (`/page/2/`, `page-2.html`, `liste_1.html`). */
function numberedPath(pathname: string): { readonly template: string; readonly number: number; readonly dir: string; readonly segment: string } | null {
  const segments = pathname.split('/');
  let i = segments.length - 1;
  while (i > 0 && segments[i] === '') i -= 1;
  const seg = segments[i] ?? '';
  const m = /^(|.*?\D)(\d{1,5})(\D*)$/.exec(seg);
  if (m === null || i === 0) return null;
  const segment = `${m[1]}{page}${m[3]}`;
  const template = [...segments.slice(0, i), segment, ...segments.slice(i + 1)].join('/');
  return { template, number: Number(m[2]), dir: `${segments.slice(0, i).join('/')}/`, segment };
}

/**
 * Pagination d'une page de liste (même hôte que la page, jamais un autre domaine : INV10). Les liens sont résolus contre
 * la page (liens relatifs `page-2.html`). Ordre : numéro dans le chemin (`/page/2/`, `page-2.html`, `liste_1.html`), puis
 * paramètre entier de la requête (`?page=2`, `?p=2`, décalage `?start=10`), enfin le lien « suivant » seul (`rel=next`,
 * libellé, flèche, classe : `next-link.ts`). Le numéro du lien « suivant » fixe le départ (page de base, puis `_1` :
 * départ 0) ; sinon une page 2 liée fixe le départ à 1. `last` : plus grand numéro vu.
 */
export function detectDomPagination(doc: Document, pageUrl: string, recordCount: number): DomPagination | null {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  const links: { url: URL; next: boolean }[] = [];
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
    const next = isNextAnchor(el);
    if (el.name === 'a' || next) links.push({ url, next });
  }
  const pagePath = normalizedPath(page.pathname);
  const pageDir = page.pathname.slice(0, page.pathname.lastIndexOf('/') + 1);
  const pageLast = page.pathname.slice(page.pathname.lastIndexOf('/') + 1);
  // Page de départ déjà numérotée (`/liste/page/2/`, `page-3.html`) : son propre gabarit et son numéro.
  const own = numberedPath(page.pathname);
  type Seen = { nums: Set<number>; next: Set<number> };
  const byTemplate = new Map<string, Seen>();
  const byParam = new Map<string, Seen>();
  const pageParams = new URLSearchParams(page.search);
  const note = (map: Map<string, Seen>, key: string, n: number, next: boolean) => {
    const seen = map.get(key) ?? { nums: new Set<number>(), next: new Set<number>() };
    seen.nums.add(n);
    if (next) seen.next.add(n);
    map.set(key, seen);
  };
  for (const { url, next } of links) {
    const numbered = numberedPath(url.pathname);
    if (numbered !== null && url.search === page.search) {
      const prefix = numbered.template.slice(0, numbered.template.indexOf('{page}'));
      const sameDir = numbered.dir === pageDir;
      const bare = numbered.segment.replace(/[-_.]?\{page\}/, '');
      // Segment tout en chiffres (`/page/2/`) sous le chemin de la page ; un numéro collé à un nom (`p0001`, `page-2.html`)
      // ne vaut que dans le répertoire de la page, avec un lien « suivant », le même nom de fichier, ou un mot « page ».
      const pure = /^\{page\}$/.test(numbered.segment) || PAGE_WORD.test(numbered.segment.replace('{page}', ''));
      const sameList =
        numbered.template === own?.template ||
        (pure && normalizedPath(prefix).startsWith(pagePath) && prefix.length - pagePath.length <= 24) ||
        (sameDir && (next || bare === pageLast || (INDEX_FILE.test(pageLast) && PAGE_WORD.test(numbered.segment.replace('{page}', '')))));
      if (sameList) note(byTemplate, numbered.template, numbered.number, next);
    }
    if (normalizedPath(url.pathname) !== pagePath) continue;
    for (const [name, value] of url.searchParams) {
      if (!/^\d{1,7}$/.test(value) || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) continue;
      const others = [...url.searchParams].filter(([n]) => n !== name);
      const same = others.length === [...pageParams].filter(([n]) => n !== name).length && others.every(([n, v]) => pageParams.get(n) === v);
      if (same) note(byParam, name, Number(value), next);
    }
  }
  const lastOf = (set: Set<number>): number | null => (set.size === 0 ? null : Math.max(...set));
  const ownNumber = own?.number ?? null;
  // Gabarits de chemin : celui du lien « suivant » d'abord, puis le plus fourni.
  const paths = [...byTemplate.entries()]
    .map(([template, seen]) => {
      const mine = template === own?.template && ownNumber !== null;
      const start = mine ? (seen.nums.has(ownNumber + 1) ? ownNumber : null) : seen.next.size > 0 ? Math.min(...seen.next) - 1 : seen.nums.has(2) ? 1 : null;
      return { template, seen, start };
    })
    .filter((p): p is { template: string; seen: Seen; start: number } => p.start !== null && p.start >= 0)
    .sort((a, b) => b.seen.next.size - a.seen.next.size || b.seen.nums.size - a.seen.nums.size);
  const path = paths[0];
  const params = [...byParam.entries()].sort((a, b) => b[1].next.size - a[1].next.size || b[1].nums.size - a[1].nums.size);
  // Le gabarit qui porte le lien « suivant » l'emporte : chemin, sinon paramètre (un paramètre suivi bat un chemin sans lien suivant).
  const paramHasNext = params.some(([, seen]) => seen.next.size > 0);
  if (path !== undefined && (path.seen.next.size > 0 || !paramHasNext)) return { type: 'page_param', param: 'url.path', path_pattern: path.template, start: path.start, last: lastOf(path.seen.nums) };
  for (const [name, { nums, next }] of params) {
    const current = pageParams.get(name);
    if (next.size > 0 && current !== null && /^\d{1,7}$/.test(current) && next.has(Number(current) + 1)) return { type: 'page_param', param: `url.query.${name}`, start: Number(current), last: lastOf(nums) };
    if (nums.has(2) || nums.has(1)) return { type: 'page_param', param: `url.query.${name}`, start: 1, last: lastOf(nums) };
    const step = Math.min(...nums);
    if (step > 1 && [...nums].every((v) => v % step === 0) && (recordCount === 0 || step === recordCount || nums.size >= 2)) {
      return { type: 'offset', param: `url.query.${name}`, start: 0, step, last: lastOf(nums) };
    }
  }
  return links.some((l) => l.next) ? { type: 'next_link', last: null } : null;
}

/**
 * Liste lisible d'un HTML (servi, ou rendu par Chromium) : bloc répété ou tableau (le meilleur score), et pagination ;
 * `null` si aucune liste n'y est lisible.
 */
export function analyzeDom(html: string, pageUrl: string, limits: DslLimits = DEFAULT_DSL_LIMITS): { blocks: DomBlocks; pagination: DomPagination | null } | null {
  let doc: Document;
  try {
    doc = parseHtml(html, limits);
  } catch {
    return null;
  }
  const repeated = scoredRepeatedBlocks(doc);
  const table = scoredTable(doc);
  const best = repeated === null ? table : table === null ? repeated : table.score > repeated.score ? table : repeated;
  if (best === null) return null;
  const blocks: DomBlocks = { records: best.records, count: best.count, slots: best.slots };
  return { blocks, pagination: detectDomPagination(doc, pageUrl, blocks.count) };
}

/**
 * Description d'un emplacement montrée au LLM d'enquête (valeur du squelette) : sorte, forme, présence et libellés
 * constants, jamais une valeur propre à un bloc. Un libellé constant de tous les blocs (« In stock ») est montré
 * (`value=`) : il n'est la valeur d'aucun enregistrement en propre.
 */
export function slotDescription(slot: DomSlot, count: number): string {
  const kind = slot.attr === 'text' ? 'text' : slot.attr === 'href' ? 'link' : slot.attr === 'src' ? 'image' : `attribute ${slot.attr}`;
  return [
    kind,
    `shape=${slot.shape}`,
    `present=${slot.present}/${count}`,
    ...(slot.prefix === null ? [] : [`prefix=${slot.prefix}`]),
    ...(slot.suffix === null ? [] : [`suffix=${slot.suffix}`]),
    ...(slot.constant === undefined ? [] : ['constant=yes', ...(slot.constant.label === null ? [] : [`value=${slot.constant.label}`])]),
    ...(slot.up === undefined ? [] : ['scope=group']),
  ].join(';');
}

/** Pagination seule d'une page HTML (même hôte), sans exiger de bloc répété détecté : page d'un essai E4 compilé. */
export function detectHtmlPagination(html: string, pageUrl: string, recordCount: number, limits: DslLimits = DEFAULT_DSL_LIMITS): DomPagination | null {
  try {
    return detectDomPagination(parseHtml(html, limits), pageUrl, recordCount);
  } catch {
    return null;
  }
}
