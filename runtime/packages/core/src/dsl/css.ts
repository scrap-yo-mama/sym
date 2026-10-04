// SPDX-License-Identifier: AGPL-3.0-only
// HTML (htmlparser2, MIT) + sélecteurs CSS (css-select, BSD-2-Clause) : aucun `eval`, aucune pseudo-classe personnalisée,
// aucune évaluation de script (le contenu des balises <script> reste du texte). Bornes : taille, profondeur de l'arbre, longueur
// et complexité du sélecteur.
import { selectAll, compile as compileCss } from 'css-select';
import type { AnyNode, Document, Element } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { DslError } from './errors.js';
import { assertResponseSize, MAX_SELECTOR_LENGTH, type DslLimits } from './limits.js';

const MAX_SELECTOR_PARTS = 12;

function childrenOf(node: AnyNode): AnyNode[] {
  return 'children' in node ? node.children : [];
}

/** Analyse un HTML. Taille bornée avant analyse, profondeur de l'arbre vérifiée après (parcours itératif). */
export function parseHtml(html: string, limits: DslLimits): Document {
  assertResponseSize(html, limits);
  const doc = parseDocument(html, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  const stack: [AnyNode, number][] = [[doc, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [AnyNode, number];
    if (depth > limits.maxHtmlDepth) throw new DslError('depth_exceeded', `HTML refusé : imbrication > ${limits.maxHtmlDepth}`);
    for (const child of childrenOf(node)) stack.push([child, depth + 1]);
  }
  return doc;
}

const compiled = new Map<string, ReturnType<typeof compileCss<AnyNode, Element>>>();

/** Valide et compile un sélecteur (avec cache). Lève `DslError('invalid_css')`. */
export function compileSelector(selector: string): ReturnType<typeof compileCss<AnyNode, Element>> {
  if (typeof selector !== 'string' || selector.trim() === '') throw new DslError('invalid_css', 'sélecteur CSS : chaîne non vide attendue');
  if (selector.length > MAX_SELECTOR_LENGTH) throw new DslError('invalid_css', `sélecteur CSS trop long (> ${MAX_SELECTOR_LENGTH} caractères)`);
  const parts = selector.split(/[\s>+~,]+/).length;
  if (parts > MAX_SELECTOR_PARTS) throw new DslError('invalid_css', `sélecteur CSS trop complexe (> ${MAX_SELECTOR_PARTS} éléments)`);
  const hit = compiled.get(selector);
  if (hit !== undefined) return hit;
  let fn: ReturnType<typeof compileCss<AnyNode, Element>>;
  try {
    fn = compileCss<AnyNode, Element>(selector, { xmlMode: false, cacheResults: true });
  } catch (cause) {
    throw new DslError('invalid_css', 'sélecteur CSS invalide ou non pris en charge', { cause });
  }
  compiled.set(selector, fn);
  if (compiled.size > 512) compiled.delete(compiled.keys().next().value as string);
  return fn;
}

/** Éléments correspondant au sélecteur, sous `root` (les descendants de `root`), en ordre du document. */
export function selectElements(selector: string, root: Document | Element, maxResults: number): Element[] {
  const fn = compileSelector(selector);
  let found: Element[];
  try {
    found = selectAll<AnyNode, Element>(fn, root);
  } catch (cause) {
    if (cause instanceof RangeError) throw new DslError('depth_exceeded', 'sélecteur CSS : pile épuisée', { cause });
    throw new DslError('invalid_css', 'évaluation du sélecteur impossible', { cause });
  }
  if (found.length > maxResults) throw new DslError('too_many_items', `sélecteur CSS : plus de ${maxResults} résultats`);
  return found;
}

/** Balises dont la frontière sépare deux mots (`84000<br>84140`, deux cellules, deux paragraphes) : jamais collés. */
const WORD_BREAK_TAGS = new Set(['br', 'p', 'div', 'li', 'td', 'th', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'dl', 'dt', 'dd', 'table', 'section', 'article', 'header', 'footer', 'blockquote', 'figcaption', 'hr']);
const SEPARATOR = Symbol('separator');

/**
 * Texte de l'élément (parcours itératif, hors <script> et <style>), plafonné à `maxLength` caractères. Un `<br>` ou la
 * frontière d'un bloc (paragraphe, cellule, élément de liste…) sépare les textes voisins d'une espace (banc réel R06 :
 * « 84000<br>84140 » rendait « 8400084140 ») ; aucune espace n'est ajoutée en tête ni en fin, ni à côté d'une espace.
 */
export function elementText(element: Element, maxLength: number): string {
  let out = '';
  let pending = false;
  const stack: (AnyNode | typeof SEPARATOR)[] = [element];
  while (stack.length > 0) {
    const node = stack.pop() as AnyNode | typeof SEPARATOR;
    if (node === SEPARATOR) {
      pending = true;
      continue;
    }
    if (node.type === 'text') {
      if (pending && out !== '' && node.data !== '' && !/\s$/.test(out) && !/^\s/.test(node.data)) out += ' ';
      if (node.data !== '') pending = false;
      out += node.data;
      if (out.length > maxLength) throw new DslError('value_too_large', 'texte extrait trop long');
    } else if (node.type === 'tag' || node === element || node.type === 'root') {
      const breaks = node !== element && node.type === 'tag' && WORD_BREAK_TAGS.has((node as Element).name);
      if (breaks) {
        pending = true;
        stack.push(SEPARATOR);
      }
      const kids = childrenOf(node);
      for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i] as AnyNode);
    }
  }
  return out;
}

/** Valeur d'un attribut (`undefined` s'il est absent). Noms d'attribut sans espace ni séparateur. */
export function elementAttribute(element: Element, name: string): string | undefined {
  return Object.hasOwn(element.attribs, name) ? element.attribs[name] : undefined;
}

