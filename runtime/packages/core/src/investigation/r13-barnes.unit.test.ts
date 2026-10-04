// SPDX-License-Identifier: AGPL-3.0-only
// Banc de cas réels, R13 (Barnes, cdc/scrapyomama-runtime/.executed/banc-reel.md) : pages FICTIVES qui reproduisent la
// structure constatée le 2026-10-05 (aucune donnée réelle) :
// - la page de résultats sert les 24 premières cartes (`article#property-APM-…`), chacune avec un carrousel PHOTO
//   (`data-carousel="carousel-APM-…"`), un badge « Nouveauté », un titre « À vendre <type> | <ville> », la ville, des
//   critères en `span` frères DONT CERTAINS MANQUENT (« 4 Chambres », « 163 m² », « 2 salles de bains », « Surfaces
//   extérieures 850 m² ») et un prix ; un compteur « 6197 annonces » ; un bouton « Annonces suivantes »
//   (`javascript:annonces_suivantes()`) qui charge les 24 suivantes en XHR GET (`viewAjax.php?…&begin=24`), fragment HTML ;
// - variante du CDC (fixture « carrousel ») : un carrousel « Nouveautés » de 24 cartes (swiper) dans le document servi, et
//   une liste de résultats de 20 cartes rendue après chargement XHR, avec un compteur « 1 234 biens ».
import { describe, expect, it } from 'vitest';
import { parseHtml } from '../dsl/css.js';
import { extractRecords } from '../dsl/extract.js';
import { DEFAULT_DSL_LIMITS } from '../dsl/limits.js';
import { validateDeclarativeSpec } from '../dsl/spec.js';
import { runDeclarative } from '../exec/declarative.js';
import { analyzeDom, analyzeDomBlocks, detectLoadMore, detectResultCounter } from './dom.js';
import { buildFromProposal, type InvestigationProposal, type ProposalField } from './proposal.js';
import { analyzeCapture, type DataCandidate, type ReconCapture } from './recon.js';

const HOST = 'zz_test_prestige.localhost';
const PAGE = `https://${HOST}/fr/vente/france.html`;
const XHR = `https://${HOST}/views/viewAjax.php?view=viewListing_annonces&ajax=y&action=annonces_suivantes&begin=24&type_moteur=listing`;
const TYPES = ['Appartement', 'Maison', 'Villa', 'Propriété', 'Hôtel particulier', 'Loft'];
const CITIES = ['Le Zz-Luc', 'Zzmougins', 'Paris 16ème', 'Zzbiarritz', 'Saint-Zz-sur-Mer', 'Lyon 6ème', 'Zzannecy'];

/** Une carte de résultat, structure constatée (valeurs fictives). Critères absents selon `i` (terrain, chambres). */
export function prestigeCard(i: number): string {
  const ref = `APM-${87300000 + i}`;
  const type = TYPES[i % TYPES.length]!;
  const city = CITIES[i % CITIES.length]!;
  const slug = city.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const crit = [
    ...(i % 5 === 3 ? [] : [`<span>${2 + (i % 6)} Chambres</span>`]),
    `<span>${60 + ((i * 37) % 900)} m²</span>`,
    `<span>${1 + (i % 4)} salles de bains</span>`,
    ...(i % 3 === 0 ? [`<span>Surfaces extérieures ${(500 + i * 1013).toLocaleString('fr-FR').replace(/\u202f/g, ' ')} m²</span>`] : []),
  ].join(' ');
  return `<article class="col-xl-6 col-lg-6 col-md-6 mb-4" id="property-${ref}"><div class="bg-white mb-2 false"><div class="bc-015-image-container position-relative">
<div class="position-absolute top-0 start-0 d-flex w-100 z-2"><p class="bg-gray-100 p-2 text-uppercase fs-xxs fw-bold me-1 mb-0">Nouveauté</p><button class="ms-auto btn btn-link text-white"><span id="listing-favorite-${ref}" class="fa fa-heart" title="Ajouter à mes favoris"></span></button></div>
<div class="position-relative h-100 glide--ltr glide--carousel" data-carousel="carousel-${ref}"><a href="https://${HOST}/fr/vente/france/${slug}/ref-${ref}.html" title="À vendre ${type} | ${city}" class="bc-015-carousel-link d-block h-100"><div data-glide-el="track" class="glide__track"><div class="glide__slides d-flex">
<div class="glide__slide"><img data-src="https://${HOST}/bdata/property/${i}/a.jpg?width=800" src="https://${HOST}/images/no-picture.jpg" alt="${type}"></div><div class="glide__slide"><img data-src="https://${HOST}/bdata/property/${i}/b.jpg?width=800" src="https://${HOST}/images/no-picture.jpg" alt="${type}"></div></div></div></a>
<div data-glide-el="controls" class="bc-015-carousel-controls position-absolute"><button aria-label="To the left" data-glide-dir="&lt;" class="btn btn-barnes-opacity"><i class="fa-solid fa-chevron-left"></i></button><button aria-label="To the right" data-glide-dir="&gt;" class="btn btn-barnes-opacity"><i class="fa-solid fa-chevron-right"></i></button></div></div></div>
<div class="bc-015-content fs-sm"><a href="https://${HOST}/fr/vente/france/${slug}/ref-${ref}.html" title="À vendre ${type} | ${city}" class="bc-015-content-link d-block text-decoration-none"><div class="fw-bold fs-sm mb-2 text-uppercase mt-3">À vendre ${type} | ${city}</div>
<p class=" mb-2">${city}</p><p class="bc-015-criteria mb-2">${crit}</p><p class="bc-015-prix mb-2"><strong class="me-2">${(400000 + i * 98765).toLocaleString('fr-FR').replace(/\u202f/g, ' ')} €</strong></p></a></div></div></article>`;
}

export function prestigeFragment(from: number, n = 24): string {
  return Array.from({ length: n }, (_, k) => prestigeCard(from + k + 1)).join('\n');
}

export function prestigePage(): string {
  return `<!doctype html><html lang="fr"><head><title>Immobilier de prestige à vendre en France</title><meta name="description" content="Découvrez 6 197 biens immobiliers de prestige à vendre en France."></head><body>
<header><nav><ul><li><a href="/fr/vente.html">Acheter</a></li><li><a href="/fr/location.html">Louer</a></li><li><a href="/fr/agences.html">Agences</a></li><li><a href="/fr/estimation.html">Estimer</a></li><li><a href="/fr/contact.html">Contact</a></li></ul></nav></header>
<main><section><h1>Immobilier de prestige à vendre en France</h1><h2 class="fs-md m-3">6197 biens d'exception à vendre en France</h2></section>
<p class="d d-md-none text-uppercase" id="nbr-listings-found">6197 annonces</p>
<div class="container"><form id="search_form" action="/fr/vente/france.html"><label for="TRI_NOUV">Nouveautés</label><input type="radio" id="TRI_NOUV" name="tri"></form>
<p class="d-none d-md-block text-uppercase fs-xxs py-3 mb-0">6197 annonces</p>
<section id="list-results"><div class="row" id="content_annonces">${prestigeFragment(0)}</div>
<input type="hidden" id="listing_begin" value="24"><input type="hidden" id="listing_limit" value="24">
<div class="text-center"><a href="javascript:annonces_suivantes()" class="btn btn-primary btn-lg fs-xs bc-012-btn-carre" id="button_annonces_suivantes">Annonces suivantes</a></div></section></div></main>
<footer><a href="/fr/mentions.html">Mentions légales</a><a href="/fr/cookies.html">Cookies</a><a href="/fr/plan.html">Plan du site</a><a href="/fr/presse.html">Presse</a><a href="/fr/carrieres.html">Carrières</a></footer></body></html>`;
}

/** Variante du CDC : carrousel « Nouveautés » de 24 cartes (servi), liste de résultats de 20 cartes rendue après XHR. */
function carouselCard(i: number): string {
  return `<div class="swiper-slide"><article class="prop-card"><a href="/fr/vente/zz-${i}.html"><img src="/img/n${i}.jpg" alt=""><h3 class="prop-title">${TYPES[i % TYPES.length]} Zztest ${i}</h3></a><p class="prop-city">${CITIES[i % CITIES.length]}</p><p class="prop-price">${(900000 + i * 1000).toLocaleString('fr-FR').replace(/\u202f/g, ' ')} €</p></article></div>`;
}
function resultCard(i: number): string {
  return `<li class="result-item"><article class="listing-card"><a href="/fr/vente/annonce-${i}.html"><img src="/img/r${i}.jpg" alt=""><h3 class="listing-title">${TYPES[i % TYPES.length]} à vendre Zztest ${i}</h3></a><p class="listing-city">${CITIES[i % CITIES.length]}</p><p class="listing-price">${(300000 + i * 777).toLocaleString('fr-FR').replace(/\u202f/g, ' ')} €</p><p class="listing-specs">${3 + (i % 5)} pièces</p></article></li>`;
}
export function carouselPage(rendered: boolean): string {
  return `<!doctype html><html><body><header><nav><a href="/">Accueil</a><a href="/fr/vente.html">Acheter</a></nav></header><main>
<section class="home-news"><h2>Nouveautés</h2><div class="swiper"><div class="swiper-wrapper">${Array.from({ length: 24 }, (_, k) => carouselCard(k + 1)).join('')}</div><div class="swiper-button-next"></div></div></section>
<section class="search-results"><p class="results-count">1 234 biens correspondent à votre recherche</p><ul id="results" class="results-list">${rendered ? Array.from({ length: 20 }, (_, k) => resultCard(k + 1)).join('') : ''}</ul>
<button type="button" class="load-more" id="load-more">Voir plus de résultats</button></section></main></body></html>`;
}

const doc = (html: string) => parseHtml(html, DEFAULT_DSL_LIMITS);

describe('R13 : choix du bloc, compteur, bouton « charger plus »', () => {
  it('carrousel « Nouveautés » de 24 cartes contre liste de résultats de 20 : la liste est retenue, le carrousel reste une alternative pénalisée', () => {
    const all = analyzeDomBlocks(carouselPage(true), PAGE);
    expect(all).not.toBeNull();
    expect(all!.blocks[0]).toMatchObject({ count: 20, hints: { carousel: false, results: true } });
    expect(all!.blocks[0]!.records).toMatch(/listing-card|result-item/);
    const carousel = all!.blocks.find((b) => b.count === 24);
    expect(carousel).toMatchObject({ hints: { carousel: true } });
    expect(analyzeDom(carouselPage(true), PAGE)?.blocks.count).toBe(20);
  });

  it('compteur affiché par le site : « 6197 annonces », « 1 234 biens » ; jamais un critère de carte (« 15 Chambres »)', () => {
    expect(detectResultCounter(doc(prestigePage()))).toBe(6197);
    expect(detectResultCounter(doc(carouselPage(true)))).toBe(1234);
    expect(detectResultCounter(doc('<html><body><ul><li>15 Chambres</li><li>3 salles de bains</li></ul></body></html>'))).toBeNull();
    expect(analyzeDomBlocks(prestigePage(), PAGE)?.counter).toBe(6197);
  });

  it('bouton « charger plus » sans URL (javascript:) : détecté avec un sélecteur vérifié ; un vrai lien « suivant » n’en est pas un', () => {
    expect(detectLoadMore(doc(prestigePage()))).toEqual({ selector: '#button_annonces_suivantes', label: 'Annonces suivantes' });
    expect(detectLoadMore(doc(carouselPage(true)))).toEqual({ selector: '#load-more', label: 'Voir plus de résultats' });
    expect(detectLoadMore(doc('<html><body><a href="/liste?page=2">Voir plus</a></body></html>'))).toBeNull();
  });
});

describe('R13 : emplacements des cartes (critères frères dont certains manquent, préfixe technique, titre « type | ville »)', () => {
  const dom = analyzeDomBlocks(prestigePage(), PAGE)!.blocks[0]!;
  const slot = (pred: (s: (typeof dom.slots)[number]) => boolean) => dom.slots.find(pred);

  it('la liste de 24 cartes est le bloc retenu (le carrousel photo est DANS la carte, il ne la pénalise pas)', () => {
    expect(dom).toMatchObject({ count: 24, hints: { carousel: false } });
  });

  it('critères frères lus par leur libellé, jamais par leur rang : chambres, m², salles de bains, surfaces extérieures distincts', () => {
    const bedrooms = slot((s) => s.suffix === 'Chambres' || /chambres/i.test(s.name));
    const living = slot((s) => s.label === 'm²');
    const land = slot((s) => s.label?.includes('extérieure') === true);
    const baths = slot((s) => /bain/i.test(s.name));
    for (const s of [bedrooms, living, land, baths]) expect(s, JSON.stringify(dom.slots.map((x) => [x.name, x.css, x.suffix]))).toBeDefined();
    const records = extractRecords(
      { schema_version: 1, kind: 'declarative', request: { method: 'GET', url: PAGE, allowed_hosts: [HOST] }, sources: [{ id: 'dom', from: 'html', records: dom.records }], fields: { b: { css: bedrooms!.css!, attr: 'text', type: 'string' }, l: { css: living!.css!, attr: 'text', type: 'string' }, t: { css: land!.css!, attr: 'text', type: 'string' } } } as never,
      { body: prestigePage() },
    );
    expect(records.ok).toBe(true);
    const rows = records.ok ? records.records : [];
    // Carte 3 : ni chambres (i % 5 === 3) ni… ; carte 3 a un terrain (i % 3 === 0) ; la surface habitable reste la surface.
    expect(rows[2]).toMatchObject({ l: expect.stringMatching(/^\d+ m²$/), t: expect.stringMatching(/^Surfaces extérieures/) });
    expect(rows[2]?.['b'] ?? null).toBeNull();
    expect(rows[0]).toMatchObject({ b: '3 Chambres' });
    expect(rows.every((r) => typeof r['l'] === 'string' && !String(r['l']).startsWith('Surfaces'))).toBe(true);
  });

  it('identifiant à préfixe technique (`carousel-APM-…`, `property-APM-…`) : préfixe retiré par le code', () => {
    const carousel = slot((s) => s.attr === 'data-carousel');
    expect(carousel?.strip).toBe('carousel-');
    const id = slot((s) => s.attr === 'id' && s.css === null);
    if (id !== undefined) expect(id.strip).toBe('property-');
  });

  it('titre « À vendre <type> | <ville> » : parties lues séparément (type, ville), libellé de tête constant retiré', () => {
    const parts = dom.slots.filter((s) => s.part !== undefined);
    expect(parts.map((s) => s.part)).toEqual(expect.arrayContaining([expect.objectContaining({ index: 0, sep: '|', lead: 'À vendre' }), expect.objectContaining({ index: 1, sep: '|' })]));
  });
});

const field = (name: string, type: ProposalField['type'], description: string, required = false): ProposalField => ({ name, type, required, personal: false, description });

describe('R13 : stratégie construite sur la liste, champs justes, pagination XHR du bouton « charger plus »', () => {
  const capture: ReconCapture = {
    mode: 'browser',
    pageUrl: PAGE,
    document: { url: PAGE, status: 200, html: prestigePage(), renderedHtml: prestigePage().replace('</div>\n<input', `${prestigeFragment(24)}</div>\n<input`), bytes: 200_000 },
    exchanges: [{ url: XHR, method: 'GET', requestBody: null, requestContentType: null, status: 200, contentType: 'text/html; charset=UTF-8', body: prestigeFragment(24), bytes: 120_000 }],
    totalBytes: 3_000_000,
    loadMore: { clicked: true, selector: '#button_annonces_suivantes' },
  };
  const candidates = analyzeCapture(capture, [HOST]);
  const dom = candidates.find((c) => c.from === 'dom') as DataCandidate;

  it('candidat DOM : 24 cartes, compteur 6197, pagination XHR par décalage (24, pas de 24) vers l’URL du fragment', () => {
    expect(dom).toMatchObject({ count: 24, counter: 6197 });
    expect(dom.dom?.pagination).toMatchObject({ type: 'offset', param: 'url.query.begin', start: 0, step: 24, next_url: XHR.replace('begin=24', 'begin=0') });
  });

  it('le fragment HTML capturé n’est pas un gisement « API JSON » à part', () => {
    expect(candidates.filter((c) => c.from === 'response')).toEqual([]);
  });

  it('stratégie : page 1 = la page, pages suivantes = l’URL XHR décalée ; plafond dur à la mesure du compteur (259 pages)', () => {
    const slots = dom.dom!.slots;
    const by = (pred: (s: (typeof slots)[number]) => boolean) => `$.${slots.find(pred)!.name}`;
    const proposal: InvestigationProposal = {
      fields: [field('reference', 'string', 'Property reference', true), field('property_type', 'string', 'Type of property'), field('location', 'string', 'City'), field('bedrooms', 'integer', 'Bedrooms'), field('living_area_m2', 'number', 'Living area'), field('price_eur', 'number', 'Price')],
      sources: [
        {
          candidate: dom.id,
          paths: [
            { field: 'reference', path: by((s) => s.attr === 'data-carousel'), ops: [] },
            { field: 'property_type', path: by((s) => s.part?.index === 0), ops: [] },
            { field: 'location', path: by((s) => s.part?.index === 1), ops: [] },
            { field: 'bedrooms', path: by((s) => /chambre/i.test(s.name)), ops: [] },
            { field: 'living_area_m2', path: by((s) => s.suffix === 'm²' && !/ext/i.test(s.name)), ops: [] },
            { field: 'price_eur', path: by((s) => s.shape.startsWith('money')), ops: [] },
          ],
          pagination: { type: 'none', param: null, start: null, has_more_path: null, next_path: null },
        },
      ],
    } as unknown as InvestigationProposal;
    const built = buildFromProposal(proposal, candidates, capture);
    expect(built.ok, JSON.stringify(built)).toBe(true);
    if (!built.ok) return;
    const strategy = built.strategies[0]!;
    expect(strategy.paginated).toBe(true);
    expect(strategy.spec.pagination).toMatchObject({ type: 'offset', param: 'url.query.begin', start: 0, step: 24, next_url: expect.stringContaining('viewAjax.php'), limits: { hard_max_pages: 264 } });
    expect(built.sample[0]).toMatchObject({ reference: 'APM-87300001', property_type: 'Maison', location: 'Zzmougins', bedrooms: 3, price_eur: 498765 });
    expect(built.sample.every((r) => typeof r['living_area_m2'] === 'number' && (r['living_area_m2'] as number) < 1000)).toBe(true);
  });
});

describe('R13 : exécution de la pagination « charger plus » (next_url), avec et sans la session du site', () => {
  const capture: ReconCapture = {
    mode: 'browser',
    pageUrl: PAGE,
    document: { url: PAGE, status: 200, html: prestigePage(), renderedHtml: null, bytes: 200_000 },
    exchanges: [{ url: XHR, method: 'GET', requestBody: null, requestContentType: null, status: 200, contentType: 'text/html', body: prestigeFragment(24), bytes: 120_000 }],
    totalBytes: 3_000_000,
    loadMore: { clicked: true, selector: '#button_annonces_suivantes' },
  };
  const candidates = analyzeCapture(capture, [HOST]);
  const dom = candidates.find((c) => c.from === 'dom') as DataCandidate;
  const link = dom.dom!.slots.find((s) => s.attr === 'href')!;
  const built = buildFromProposal(
    { fields: [field('listing_url', 'string', 'Listing URL', true)], sources: [{ candidate: dom.id, paths: [{ field: 'listing_url', path: `$.${link.name}`, ops: [] }], pagination: { type: 'none', param: null, start: null, has_more_path: null, next_path: null } }] } as InvestigationProposal,
    candidates,
    capture,
  );
  const spec = built.ok ? built.strategies[0]!.spec : (null as never);
  /** Site : 100 biens ; le fragment XHR exige le cookie de session posé par la page (sinon « Session timed out »). */
  const site = (withSession: boolean) => {
    const seen: string[] = [];
    const transport = async (request: { url: string }) => {
      seen.push(request.url);
      const url = new URL(request.url);
      if (url.pathname === '/fr/vente/france.html') return { status: 200, headers: { 'content-type': 'text/html' }, body: prestigePage(), url: request.url };
      if (!withSession) return { status: 200, headers: { 'content-type': 'text/html' }, body: "Session timed out<br><a href='/'>Refresh this page.</a>", url: request.url };
      const begin = Number(url.searchParams.get('begin'));
      const body = begin >= 100 ? 'nodata' : prestigeFragment(begin, Math.min(24, 100 - begin));
      return { status: 200, headers: { 'content-type': 'text/html' }, body, url: request.url };
    };
    return { seen, transport };
  };

  it('avec la session (E2, cookies de la page) : page 1 puis begin=24, 48, 72, 96 ; 100 biens, arrêt sur page vide', async () => {
    const { seen, transport } = site(true);
    const r = await runDeclarative({ spec, input: {}, transport, signal: new AbortController().signal });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.records).toHaveLength(100);
    expect(r.stop).toBe('records_empty');
    expect(seen[0]).toBe(PAGE);
    expect(seen.slice(1).map((u) => new URL(u).searchParams.get('begin'))).toEqual(['24', '48', '72', '96', '120']);
  });

  it('sans la session (E1) : la page 2 ne rend rien, la liste s’arrête à 24 (le contrôle de complétude contre le compteur le verra)', async () => {
    const { transport } = site(false);
    const r = await runDeclarative({ spec, input: {}, transport, signal: new AbortController().signal });
    expect(r.ok).toBe(true);
    if (r.ok) expect({ records: r.records.length, stop: r.stop, pages: r.pages }).toEqual({ records: 24, stop: 'records_empty', pages: 2 });
  });

  it('next_url hors allowed_hosts : refusé à l’enregistrement', () => {
    const bad = { ...spec, pagination: { ...spec.pagination!, next_url: 'https://zz_test_ailleurs.localhost/x?begin=0' } };
    expect(validateDeclarativeSpec(bad).ok).toBe(false);
  });
});
