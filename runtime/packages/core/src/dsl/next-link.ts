// SPDX-License-Identifier: AGPL-3.0-only
// Lien « page suivante » d'une page HTML (banc réel R07, R08) : reconnu de façon DÉTERMINISTE, par la même règle à la
// reconnaissance (dom.ts) et au rejeu (exécuteur déclaratif, pagination `next_link` sans `rel=next`) :
// - `rel="next"` sur un `a` ou un `link` ;
// - libellé du lien (aria-label, sinon texte, sinon `title`) : « suivant », « next », « page suivante », « weiter »… ou
//   une flèche seule (« › », « » », « → », « > », « >> ») ;
// - classe « next » sur le lien ou sur son parent (`li.next > a`, `a.pagination-next`).
// Le lien rendu est une DONNÉE de la page : l'appelant le résout contre l'URL courante et vérifie l'hôte (INV10).
import type { Document, Element } from 'domhandler';
import { elementText, selectElements } from './css.js';

const NEXT_WORDS = /^(?:suivant|suivante|page suivante|suiv|next|next page|nextpage|weiter|nächste|nachste|siguiente|successivo|successiva|volgende|próxima|proxima|seguinte|następna)$/i;
const NEXT_ARROWS = /^(?:›|»|→|>|>>|›»|»»|⟩|⇨|⇢|⟶)$/;
const NEXT_CLASS = /(?:^|[-_])next(?:$|[-_])|^next/i;
const LINK_HREF = (href: string | undefined): boolean => href !== undefined && href.trim() !== '' && !/^\s*(#|javascript:|mailto:|tel:)/i.test(href);

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Libellé « suivant » (mot ou flèche seule), flèches et ponctuation de fin ignorées autour d'un mot. */
function isNextLabel(label: string): boolean {
  const l = collapse(label);
  if (l === '' || l.length > 40) return false;
  if (NEXT_ARROWS.test(l)) return true;
  const word = l.replace(/^[‹«<←\s]+/u, '').replace(/[\s›»>→⟩.:]+$/u, '').trim();
  return NEXT_WORDS.test(word);
}

function textOf(el: Element): string {
  try {
    return collapse(elementText(el, 2_000));
  } catch {
    return '';
  }
}

const classes = (el: Element | null): string[] => (el === null ? [] : (el.attribs['class'] ?? '').split(/\s+/).filter((c) => c !== ''));

/** Le lien `el` (un `a` ou un `link` à `href` utilisable) désigne la page suivante. */
export function isNextAnchor(el: Element): boolean {
  if (!LINK_HREF(el.attribs['href'])) return false;
  const rel = (el.attribs['rel'] ?? '').toLowerCase().split(/\s+/);
  if (rel.includes('next')) return true;
  if (el.name !== 'a') return false;
  const aria = el.attribs['aria-label'];
  const label = aria !== undefined && aria.trim() !== '' ? aria : textOf(el) || (el.attribs['title'] ?? '');
  if (isNextLabel(label)) return true;
  const parent = el.parent !== null && el.parent.type === 'tag' ? (el.parent as Element) : null;
  // Classe « next » : sur le lien, ou sur un parent qui ne contient que ce lien (`li.next > a`), jamais un conteneur large.
  if (classes(el).some((c) => NEXT_CLASS.test(c))) return true;
  return parent !== null && parent.name === 'li' && classes(parent).some((c) => NEXT_CLASS.test(c));
}

/**
 * `href` brut du premier lien « suivant » du document (ordre du document) : `rel=next` d'abord, puis libellé ou classe.
 * `undefined` : aucun. Valeur NON FIABLE : à résoudre et à vérifier (hôte) par l'appelant.
 */
export function findNextHref(doc: Document, maxLinks = 20_000): string | undefined {
  let links: Element[];
  try {
    links = selectElements('a[href], link[href]', doc, maxLinks);
  } catch {
    return undefined;
  }
  const rel = links.find((el) => (el.attribs['rel'] ?? '').toLowerCase().split(/\s+/).includes('next') && LINK_HREF(el.attribs['href']));
  const hit = rel ?? links.find((el) => isNextAnchor(el));
  return hit?.attribs['href']?.trim();
}
