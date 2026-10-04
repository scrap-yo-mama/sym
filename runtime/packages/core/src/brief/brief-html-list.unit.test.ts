// SPDX-License-Identifier: AGPL-3.0-only
// Dossier d'enquête et liste HTML (constat Janssens) : un sélecteur CSS valide (combinateur `>`, attribut `[data-ref]`,
// `:nth-child`) n'est plus refusé en `brief_invalid_item` ; il est validé par le MÊME analyseur que l'interpréteur et
// confirmé sur la page même quand il désigne plusieurs éléments (les cartes d'une liste). Un indice de pagination peut être un
// motif d'URL des pages ou le sélecteur du lien suivant.
import { describe, expect, test } from 'vitest';
import { matchBriefHints } from './apply.js';
import { buildBriefDigest, parseHintValue } from './digest.js';
import type { InvestigationBrief } from './schema.js';

const PAGE = 'https://www.agence.example/nos-maisons/';
const card = (i: number) => `<article class="item-bien"><a href="/propriete/zz-${i}/" data-ref="ZZ${i}"><h3>Maison ${i}</h3><ul><li>1${i}0 m²</li><li>3 chambres</li></ul><div class="css-title">5${i}0 000 €</div></a></article>`;
const HTML = `<html><body><main>${Array.from({ length: 10 }, (_, i) => card(i + 1)).join('')}</main><nav class="pagination"><a href="/nos-maisons/page/2/" class="page-numbers">2</a><a class="next page-numbers" href="/nos-maisons/page/2/">Suivant</a></nav></body></html>`;

describe('indices de sélecteur : tout sélecteur CSS valide', () => {
  test.each([
    'article.item-bien > a[href*="/propriete/"]',
    'article.item-bien a[data-ref]',
    'div.text-14.font-bold.uppercase.flex.flex-wrap span',
    'ul li:nth-child(2)',
    '.css-title',
    'ul > li + li',
  ])('accepté : %s', (selector) => {
    expect(parseHintValue({ kind: 'selector', value: selector }, PAGE)).toEqual({ kind: 'selector', selector });
  });
  test.each(['div[', '<script>alert(1)</script>', '', 'a'.repeat(301), 'li:has-text(x'])('refusé : %s', (selector) => {
    expect(parseHintValue({ kind: 'selector', value: selector }, PAGE)).toBeNull();
  });
});

describe('indices de pagination : famille, motif d’URL ou lien suivant', () => {
  test('famille et paramètre (forme historique)', () => {
    expect(parseHintValue({ kind: 'pagination', value: 'page_param page' }, PAGE)).toEqual({ kind: 'pagination', family: 'page_param', param: 'page' });
  });
  test('motif de chemin ou d’URL, avec ou sans famille ; l’hôte n’est jamais retenu', () => {
    expect(parseHintValue({ kind: 'pagination', value: 'page_param /nos-maisons/page/{page}/' }, PAGE)).toMatchObject({ family: 'page_param', pattern: '/nos-maisons/page/{page}/' });
    expect(parseHintValue({ kind: 'pagination', value: '/nos-maisons/page/N/' }, PAGE)).toMatchObject({ family: 'page_param', pattern: '/nos-maisons/page/{page}/' });
    expect(parseHintValue({ kind: 'pagination', value: 'https://www.agence.example/nos-maisons/page/{n}/' }, PAGE)).toMatchObject({ pattern: '/nos-maisons/page/{page}/' });
    expect(parseHintValue({ kind: 'pagination', value: '/annonces?page=N' }, PAGE)).toMatchObject({ pattern: '/annonces?page={page}' });
  });
  test('sélecteur du lien suivant', () => {
    expect(parseHintValue({ kind: 'pagination', value: 'next_link a.next' }, PAGE)).toMatchObject({ family: 'next_link', selector: 'a.next' });
    expect(parseHintValue({ kind: 'pagination', value: 'nav.pagination > a.next' }, PAGE)).toMatchObject({ family: 'next_link', selector: 'nav.pagination > a.next' });
  });
  test('rien d’utilisable : refusé', () => {
    expect(parseHintValue({ kind: 'pagination', value: 'clique sur la flèche' }, PAGE)).toBeNull();
  });
});

describe('confirmés sur la page de reconnaissance, rattachés au gisement dom', () => {
  const brief: InvestigationBrief = {
    v: 1,
    hints: [
      { id: 'card', kind: 'selector', value: 'article.item-bien' },
      { id: 'urlref', kind: 'selector', value: 'article.item-bien > a[href*="/propriete/"][data-ref]' },
      { id: 'price', kind: 'selector', value: '.css-title' },
      { id: 'pag', kind: 'pagination', value: 'page_param /nos-maisons/page/{page}/' },
      { id: 'next', kind: 'pagination', value: 'next_link nav.pagination a.next' },
      { id: 'absent', kind: 'selector', value: 'div.absent' },
    ],
  };
  test('plusieurs éléments trouvés = confirmé ; le gisement dom des cartes est désigné', () => {
    const digest = buildBriefDigest(brief, { pageUrl: PAGE, scope: 'agence.example', now: new Date('2026-10-04T10:00:00Z'), sessionOrTunnel: false });
    expect(digest.hints.filter((h) => h.reason === 'brief_invalid_item')).toEqual([]);
    const match = matchBriefHints(digest, null, { candidates: [{ id: 'c2', from: 'dom', method: 'GET', url: PAGE, locator: null, records: 'article.item-bien' }], exchanges: [], html: HTML, pageUrl: PAGE });
    for (const id of ['card', 'urlref', 'price', 'pag', 'next']) expect(match.confirmed.get(id), id).toEqual({ provenance: 'dom', candidates: ['c2'] });
    expect(match.confirmed.has('absent')).toBe(false);
  });
});
