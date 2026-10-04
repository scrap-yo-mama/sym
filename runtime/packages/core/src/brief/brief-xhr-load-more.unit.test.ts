// SPDX-License-Identifier: AGPL-3.0-only
// Dossier d'enquête, indice de pagination « xhr » ou « load more » (constat Barnes) : `{ id: "xhr", kind: "pagination" }`
// était refusé en `brief_invalid_item`. Une liste chargée par XHR / fetch après le rendu, ou un bouton « Annonces
// suivantes » / « Voir plus » / « Load more », est maintenant un indice borné comme les autres : aucune URL hors de la portée
// de l'API (`brief_host_ignored`, 0 requête), aucun balisage, libellé court ; il suit jusqu'à la reconnaissance (préférence de
// source quand le code retrouve le trafic XHR ou le bouton dans la page, sinon `unverified`). Le reste est refusé proprement.
import { describe, expect, test } from 'vitest';
import { finalizeBriefHints, matchBriefHints } from './apply.js';
import { buildBriefDigest, parseHintValue } from './digest.js';
import type { InvestigationBrief } from './schema.js';

const PAGE = 'https://www.agence-zz.example/fr/vente/';
const SCOPE = 'agence-zz.example';
const NOW = new Date('2026-10-05T10:00:00Z');
const card = (i: number) => `<article class="bien"><a href="/fr/bien/zz-${i}/"><h3>Maison ${i}</h3><span class="prix">${i}00 000 €</span></a></article>`;
const HTML = `<html><body><section class="carousel">${card(90)}</section><main class="results">${Array.from({ length: 6 }, (_, i) => card(i + 1)).join('')}</main><button type="button" class="btn-more" data-zz="more">Annonces suivantes</button></body></html>`;

const parse = (value: string) => parseHintValue({ kind: 'pagination', value }, PAGE);

describe('indice de pagination xhr : formes acceptées', () => {
  test.each(['xhr', 'XHR', 'ajax', 'fetch', 'xhr:'])('famille seule : %s', (value) => {
    expect(parse(value)).toEqual({ kind: 'pagination', family: 'xhr', param: null });
  });
  test('phrase qui nomme le XHR (forme probable du constat)', () => {
    expect(parse('Liste chargée en XHR après le rendu (bouton Annonces suivantes)')).toMatchObject({ family: 'xhr', param: null });
    expect(parse('results are loaded by an AJAX request after render')).toMatchObject({ family: 'xhr', param: null });
  });
  test('paramètre de page', () => {
    expect(parse('xhr page')).toEqual({ kind: 'pagination', family: 'xhr', param: 'page' });
    expect(parse('xhr url.query.offset')).toEqual({ kind: 'pagination', family: 'xhr', param: 'url.query.offset' });
  });
  test('requête de la liste : chemin relatif, absolu sur le domaine, méthode facultative ; motif {page}', () => {
    expect(parse('xhr GET /api/search?page={page}')).toMatchObject({ family: 'xhr', pattern: '/api/search?page={page}', host: 'www.agence-zz.example' });
    expect(parse('xhr POST https://api.agence-zz.example/v1/listings')).toMatchObject({ family: 'xhr', endpoint: '/v1/listings', method: 'POST', host: 'api.agence-zz.example' });
    expect(parse('XHR /fr/ajax/annonces')).toMatchObject({ family: 'xhr', endpoint: '/fr/ajax/annonces', method: 'GET' });
  });
});

describe('indice de pagination load more : formes acceptées', () => {
  test.each(['load_more', 'load more', 'Load more', 'load-more', 'charger plus', 'Voir plus', 'show more'])('famille seule : %s', (value) => {
    expect(parse(value)).toMatchObject({ kind: 'pagination', family: 'load_more', param: null });
  });
  test('libellé du bouton, entre guillemets ou après la famille', () => {
    expect(parse('load_more "Annonces suivantes"')).toMatchObject({ family: 'load_more', label: 'Annonces suivantes' });
    expect(parse('bouton « Annonces suivantes »')).toMatchObject({ family: 'load_more', label: 'Annonces suivantes' });
    expect(parse('load more: Annonces suivantes')).toMatchObject({ family: 'load_more', label: 'Annonces suivantes' });
    expect(parse('Load more button "See more results"')).toMatchObject({ family: 'load_more', label: 'See more results' });
  });
  test('sélecteur du bouton', () => {
    expect(parse('load_more button.btn-more')).toMatchObject({ family: 'load_more', selector: 'button.btn-more' });
  });
});

describe('formes refusées proprement (brief_invalid_item)', () => {
  test.each([
    'xhr javascript:alert(1)',
    'xhr ftp://agence-zz.example/list',
    'xhr <script>alert(1)</script>',
    'load_more <img src=x onerror=alert(1)>',
    `load_more "${'a'.repeat(81)}"`,
    'load_more https://www.agence-zz.example/more',
    'clique sur la flèche',
  ])('%s', (value) => {
    expect(parse(value)).toBeNull();
    const digest = buildBriefDigest({ v: 1, hints: [{ id: 'p', kind: 'pagination', value }] }, { pageUrl: PAGE, scope: SCOPE, now: NOW, sessionOrTunnel: false });
    expect(digest.hints[0]).toMatchObject({ decision: 'ignored', reason: 'brief_invalid_item' });
  });
});

describe('digest et reconnaissance', () => {
  const brief: InvestigationBrief = {
    v: 1,
    hints: [
      { id: 'xhr', kind: 'pagination', value: 'xhr' },
      { id: 'xhrapi', kind: 'pagination', value: 'xhr GET /api/search?page={page}' },
      { id: 'more', kind: 'pagination', value: 'load_more "Annonces suivantes"' },
      { id: 'moresel', kind: 'pagination', value: 'load_more button.btn-more' },
      { id: 'evil', kind: 'pagination', value: 'xhr https://tiers-zz.example/api/list' },
      { id: 'ip', kind: 'pagination', value: 'xhr http://169.254.169.254/latest' },
    ],
  };
  const digest = buildBriefDigest(brief, { pageUrl: PAGE, scope: SCOPE, now: NOW, sessionOrTunnel: false });
  const byId = new Map(digest.hints.map((h) => [h.id, h]));

  test('acceptés : jamais sondés (rapprochés de la reconnaissance) ; hôte hors portée ou IP : écarté, 0 requête', () => {
    for (const id of ['xhr', 'xhrapi', 'more', 'moresel']) expect(byId.get(id), id).toMatchObject({ decision: 'match_in_recon', reason: null });
    expect(byId.get('evil')).toMatchObject({ decision: 'ignored', reason: 'brief_host_ignored' });
    expect(byId.get('ip')).toMatchObject({ decision: 'ignored', reason: 'brief_host_ignored' });
    expect(digest.hints.filter((h) => h.decision === 'probe')).toEqual([]);
  });

  const candidates = [
    { id: 'c1', from: 'dom' as const, method: 'GET', url: PAGE, locator: null, records: 'main.results article.bien' },
    { id: 'c2', from: 'dom' as const, method: 'GET', url: PAGE, locator: null, records: 'section.carousel article.bien' },
    { id: 'c3', from: 'response' as const, method: 'GET', url: 'https://www.agence-zz.example/api/search?page=1&zz=1', locator: null },
  ];

  test('XHR vu par la reconnaissance : la source XHR devient la préférence ; bouton retrouvé : sources dom de la page', () => {
    const match = matchBriefHints(digest, null, { candidates, exchanges: [{ url: candidates[2]!.url, method: 'GET' }], html: HTML, pageUrl: PAGE });
    expect(match.confirmed.get('xhr')).toEqual({ provenance: 'traffic', candidates: ['c3'] });
    expect(match.confirmed.get('xhrapi')).toEqual({ provenance: 'traffic', candidates: ['c3'] });
    expect(match.confirmed.get('more')).toEqual({ provenance: 'dom', candidates: ['c1', 'c2'] });
    expect(match.confirmed.get('moresel')).toEqual({ provenance: 'dom', candidates: ['c1', 'c2'] });
  });

  test('rien de retrouvé : non vérifiés, transmis tels quels (état unverified), jamais refusés', () => {
    const match = matchBriefHints(digest, null, { candidates: candidates.slice(0, 2), exchanges: [], html: '<html><body><main class="results"></main></body></html>', pageUrl: PAGE });
    const states = new Map(finalizeBriefHints(digest, null, match, null).map((h) => [h.id, h]));
    for (const id of ['xhr', 'xhrapi', 'more', 'moresel']) expect(states.get(id), id).toMatchObject({ state: 'unverified', reason: 'brief_unverifiable' });
  });
});
