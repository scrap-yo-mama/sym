// SPDX-License-Identifier: AGPL-3.0-only
// Banc de cas réels, passage 1 (cdc/scrapyomama-runtime/.executed/banc-reel.md) : reconnaissance DOM sur des pages FICTIVES
// qui reproduisent la structure des cas R02, R03, R06, R07 et R08 (aucune donnée réelle) :
// - R07 (catalogue paginé `page-N.html`, lien « next » relatif dans `li.next`, note en classe CSS, titre tronqué par « ... »
//   dont le titre complet est dans l'attribut `title`, disponibilité identique sur toute la page) ;
// - R08 (tableau paginé : en-tête `th`, lignes `tr`, page de base sans suffixe puis `_1`, `_2`…, lien « Next ») ;
// - R06 (tableau Wikipédia : en-tête en `th`, ligne de total en `th`, nom parfois en gras, population « 92 188 (2023) »,
//   superficie à virgule, deux codes postaux séparés par `<br>`) ;
// - R02 (deux gabarits de carte : l'adresse dans `h3` ou dans `p`, même classe) ;
// - R03 (cartes d'équipe sans lien, nom dans un `button`).
import { describe, expect, it } from 'vitest';
import { parseHtml } from '../dsl/css.js';
import { extractRecords } from '../dsl/extract.js';
import { DEFAULT_DSL_LIMITS } from '../dsl/limits.js';
import { analyzeDom, detectDomPagination } from './dom.js';
import { buildFromProposal, type InvestigationProposal, type ProposalField } from './proposal.js';
import { analyzeCapture, type DataCandidate, type ReconCapture } from './recon.js';

const doc = (html: string) => parseHtml(html, DEFAULT_DSL_LIMITS);
const capture = (url: string, html: string): ReconCapture => ({ mode: 'static', pageUrl: url, document: { url, status: 200, html, renderedHtml: null, bytes: html.length }, exchanges: [], totalBytes: html.length });
const NONE = { type: 'none', param: null, start: null, has_more_path: null, next_path: null } as const;
const field = (name: string, type: ProposalField['type'], required = false): ProposalField => ({ name, type, required, personal: false, description: `Field ${name}` });
const slotOf = (c: DataCandidate, pred: (key: string, description: string) => boolean): string => {
  const hit = Object.entries(c.skeleton).find(([k, d]) => pred(k, d));
  if (hit === undefined) throw new Error(`aucun emplacement : ${JSON.stringify(c.skeleton)}`);
  return hit[0];
};

// ---------------------------------------------------------------------------------------------------- R07
const R07_HOST = 'zz_test_catalogue.localhost';
const R07_URL = `https://${R07_HOST}/catalogue/category/zz-default_15/index.html`;
const WORDS = ['One', 'Two', 'Three', 'Four', 'Five'];
const longTitle = (i: number) => `Livre fictif Zztest numero ${i} : une histoire inventee pour le banc de test, tome ${i}`;

function catalogue(n: number, options: { next?: string } = {}): string {
  const pods = Array.from({ length: 20 }, (_, k) => {
    const i = (n - 1) * 20 + k + 1;
    const title = longTitle(i);
    return `<li class="col-xs-6"><article class="product_pod"><div class="image_container"><a href="../../../zz-livre-${i}_${900 + i}/index.html"><img src="../../../../media/cache/${i}.jpg" alt="${title}" class="thumbnail"></a></div>
<p class="star-rating ${WORDS[i % 5]}"><i class="icon-star"></i><i class="icon-star"></i></p>
<h3><a href="../../../zz-livre-${i}_${900 + i}/index.html" title="${title}">${title.slice(0, 22)}...</a></h3>
<div class="product_price"><p class="price_color">£${(10 + (i % 40)).toFixed(2)}</p><p class="instock availability"><i class="icon-ok"></i> In stock</p><form><button type="submit" class="btn btn-primary btn-block">Add to basket</button></form></div></article></li>`;
  }).join('\n');
  const next = options.next ?? `<li class="next"><a href="page-${n + 1}.html">next</a></li>`;
  return `<html><head><title>Zz catalogue</title></head><body><header><nav><ul><li><a href="/index.html">Accueil Zztest</a></li></ul></nav></header>
<div class="side_categories"><ul>${['Voyage', 'Mystere', 'Histoire', 'Poesie', 'Cuisine', 'Sport'].map((c, k) => `<li><a href="../zz-${c.toLowerCase()}_${k + 2}/index.html">${c} Zztest</a></li>`).join('')}</ul></div>
<form class="form-horizontal"><strong>152</strong> results - showing <strong>1</strong> to <strong>20</strong>.</form>
<section><ol class="row">${pods}</ol><div><ul class="pager"><li class="current">Page ${n} of 8</li>${next}</ul></div></section></body></html>`;
}

describe('R07 : catalogue paginé page-N.html, note en classe, titre tronqué, disponibilité constante', () => {
  it('pagination : lien « next » relatif `page-2.html` depuis `index.html` → motif de chemin, départ à 1', () => {
    expect(detectDomPagination(doc(catalogue(1)), R07_URL, 20)).toEqual({ type: 'page_param', param: 'url.path', path_pattern: '/catalogue/category/zz-default_15/page-{page}.html', start: 1, last: 2 });
    // Page 3 déjà numérotée : son propre gabarit, son numéro.
    expect(detectDomPagination(doc(catalogue(3)), R07_URL.replace('index.html', 'page-3.html'), 20)).toMatchObject({ path_pattern: '/catalogue/category/zz-default_15/page-{page}.html', start: 3 });
  });

  it('libellés « suivant », « › », « » », rel=next, segment et paramètre : même hôte seulement', () => {
    const at = (next: string, url = R07_URL) => detectDomPagination(doc(catalogue(1, { next })), url, 20);
    expect(at('<li><a href="page-2.html">Suivant ›</a></li>')).toMatchObject({ path_pattern: '/catalogue/category/zz-default_15/page-{page}.html', start: 1 });
    expect(at('<li><a href="page-2.html">»</a></li>')).toMatchObject({ path_pattern: '/catalogue/category/zz-default_15/page-{page}.html' });
    expect(at('<li><a href="page-2.html" aria-label="Next page">›</a></li>')).toMatchObject({ param: 'url.path' });
    expect(at('<li><a href="?pg=2">›</a></li>')).toMatchObject({ type: 'page_param', param: 'url.query.pg', start: 1 });
    // Lien « suivant » sans numéro lisible : pagination par le lien suivant.
    expect(at('<li class="next"><a href="zz-suite-abc.html">Suivant</a></li>')).toEqual({ type: 'next_link', last: null });
    // Liens de fiches numérotés (`/product/p0001`) : jamais une pagination ; le lien « suivant » `?page=2` l'emporte.
    const products = `<main>${Array.from({ length: 20 }, (_, k) => `<article class="product"><h2><a href="/product/p${String(k + 1).padStart(4, '0')}">Produit fictif ${k}</a></h2><span>${k},00 €</span></article>`).join('')}</main><nav><a rel="next" class="next" href="/?page=2">Suivant</a></nav>`;
    expect(detectDomPagination(doc(`<html><body>${products}</body></html>`), `https://${R07_HOST}/`, 20)).toEqual({ type: 'page_param', param: 'url.query.page', start: 1, last: 2 });
    // Un autre domaine n'est jamais une pagination (INV10).
    expect(at(`<li class="next"><a href="https://evil.zz_test.localhost/catalogue/category/zz-default_15/page-2.html">next</a></li>`)).toBeNull();
  });

  it('emplacements : note lue dans la classe (mot → nombre), titre complet dans `title`, disponibilité constante gardée', () => {
    const html = catalogue(1);
    const candidates = analyzeCapture(capture(R07_URL, html), [R07_HOST]);
    const dom = candidates.find((c) => c.from === 'dom')!;
    expect(dom).toMatchObject({ count: 20 });
    const rating = slotOf(dom, (_k, d) => d.includes('shape=class_number'));
    const title = slotOf(dom, (k, d) => k.startsWith('$.a') && d.startsWith('attribute title'));
    const availability = slotOf(dom, (_k, d) => d.includes('constant=yes'));
    // Ce que voit le LLM : jamais la valeur propre d'une carte (le titre, le prix) ; le libellé constant reste montrable.
    const shown = JSON.stringify(dom.skeleton);
    expect(shown).not.toContain('Zztest numero');
    expect(shown).not.toContain('£');
    const proposal: InvestigationProposal = {
      fields: [field('title', 'string', true), field('price_gbp', 'number', true), field('rating', 'integer', true), field('availability', 'string', true), field('url', 'string', true)],
      sources: [
        {
          candidate: dom.id,
          paths: [
            { field: 'title', path: title, ops: [] },
            { field: 'price_gbp', path: slotOf(dom, (_k, d) => d.includes('shape=money')), ops: [] },
            { field: 'rating', path: rating, ops: [] },
            { field: 'availability', path: availability, ops: [] },
            { field: 'url', path: slotOf(dom, (_k, d) => d.startsWith('link')), ops: [] },
          ],
          pagination: NONE,
        },
      ],
    };
    const built = buildFromProposal(proposal, candidates, capture(R07_URL, html));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.strategies[0]!.spec.pagination).toMatchObject({ type: 'page_param', param: 'url.path', path_pattern: '/catalogue/category/zz-default_15/page-{page}.html', start: 1 });
    // Un libellé constant de la page 1 n'est jamais requis (une autre page peut dire « Out of stock » ou rien).
    expect((built.outputSchema as { required: string[] }).required).not.toContain('availability');
    expect(built.sample[0]).toEqual({ title: longTitle(1), price_gbp: 11, rating: 2, availability: 'In stock', url: `https://${R07_HOST}/zz-livre-1_901/index.html` });
    // Page 2 : notes jamais vues en page 1 incluses (lecture par le code, aucune table de la page 1).
    const page2 = extractRecords(built.strategies[0]!.spec, { body: catalogue(2) }, { outputSchema: built.outputSchema });
    expect(page2.ok).toBe(true);
    expect(page2.records.map((r) => r['rating'])).toEqual(Array.from({ length: 20 }, (_, k) => ((21 + k) % 5) + 1));
  });
});

// ---------------------------------------------------------------------------------------------------- R08
const R08_HOST = 'www.zz_test_salons.localhost';
const R08_URL = `https://${R08_HOST}/fairs/zz_trade-shows_fr.html`;

function fairs(n: number, rows = 50): string {
  const trs = Array.from({ length: rows }, (_, k) => {
    const i = n * 50 + k + 1;
    const date = i % 3 === 0 ? 'June 2026' : `0${1 + (i % 9)}/1${i % 9}/2026<br><i>${1 + (i % 4)} days</i>`;
    return `<tr><td><a href="f-zz-salon-${i}-1.html"><b>SALON ZZTEST ${i}</b><i>Salon fictif numero ${i} pour le banc</i></a></td><td>${i % 4 === 0 ? 'unknown' : 'once a year'}</td><td><a href="cy1_zz-ville-${i % 7}.html">Ville${i % 7}</a>${i % 10 === 0 ? '' : ` <a href="pl1_zz-lieu-${i}.html">Parc Zztest ${i}</a>`}</td><td>${date}</td></tr>`;
  }).join('\n');
  const prev = n === 0 ? '' : `<div><a href="zz_trade-shows_fr${n === 1 ? '' : `_${n - 1}`}.html"><u>Previous</u></a></div>`;
  return `<html><body><header><nav><a href="/">Accueil</a></nav></header><div class="zones"><h2>Zones</h2><ul>${['Europe', 'Asie', 'Afrique', 'Amerique', 'Oceanie'].map((z, k) => `<li><a href="z${k}_zz.html">Salons ${z} Zztest</a></li>`).join('')}</ul></div>
<table class="tradeshows"><caption>1437 Trade Shows</caption><thead><tr><th>Exhibition Name</th><th>Cycle</th><th>Venue</th><th>Date</th></tr></thead><tbody>${trs}</tbody></table>
<div class="pages-links"><div><a href="" title="first page"><u>First page</u></a></div>${prev}<div><a href="zz_trade-shows_fr_${n + 1}.html" title="All Trade Shows (continued)"><u>Next</u></a></div></div></body></html>`;
}

describe('R08 : tableau paginé, page de base sans suffixe puis _1, _2…', () => {
  it('lignes du tableau (sans la ligne d’en-tête), colonnes nommées par l’en-tête, pagination depuis la page 0', () => {
    const dom = analyzeDom(fairs(0), R08_URL);
    expect(dom).not.toBeNull();
    expect(dom!.blocks.count).toBe(50);
    const names = dom!.blocks.slots.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['exhibition_name_b', 'exhibition_name_i', 'cycle', 'venue_a', 'date']));
    // Ville du lieu : premier lien de la cellule, seul sur certaines lignes (sans frère : `a`, sinon `a:nth-of-type(1)`).
    expect(dom!.blocks.slots.find((s) => s.name === 'venue_a')).toMatchObject({ css: 'td:nth-child(3) a:nth-of-type(1)', present: 50 });
    expect(dom!.pagination).toEqual({ type: 'page_param', param: 'url.path', path_pattern: '/fairs/zz_trade-shows_fr_{page}.html', start: 0, last: 1 });
    // Le sélecteur des lignes ne prend jamais l'en-tête : 50 lignes, toutes avec un nom.
    const rows = extractRecords(
      { schema_version: 1, kind: 'declarative', request: { method: 'GET', url: R08_URL, allowed_hosts: [R08_HOST] }, sources: [{ id: 'page', from: 'html', records: dom!.blocks.records }], fields: { name: { css: dom!.blocks.slots.find((s) => s.name === 'exhibition_name_b')!.css!, type: 'string', required: true } } },
      { body: fairs(1) },
      {},
    );
    expect(rows.ok).toBe(true);
    expect(rows.records).toHaveLength(50);
    expect(rows.records[0]).toEqual({ name: 'SALON ZZTEST 51' });
  });
});

// ---------------------------------------------------------------------------------------------------- R06
const R06_HOST = 'fr.zz_test_wiki.localhost';
const R06_URL = `https://${R06_HOST}/wiki/Liste_des_communes_de_Zztest`;
const NBSP = ' ';

function communes(count: number): string {
  const rows = Array.from({ length: count }, (_, k) => {
    const i = k + 1;
    const name = `Commune${String.fromCharCode(65 + (k % 26))}zz${i}`;
    const nameCell = i === 1 ? `<b><a href="https://${R06_HOST}/wiki/${name}" title="${name}">${name}</a></b><br><small>(préfecture)</small>` : `<a href="https://${R06_HOST}/wiki/${name}" title="${name}">${name}</a>`;
    const postal = i === 1 ? '99000<br/>99140' : String(99000 + i * 10);
    const population = 1000 + i * 1337;
    const pop = String(population).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
    return `<tr><td style="text-align:left;">${nameCell}</td><td>99${String(i).padStart(3, '0')}</td><td>${postal}</td><td><a href="https://${R06_HOST}/wiki/Arr_${i % 3}" title="Arr">Arrzz${i % 3}</a></td><td><a href="https://${R06_HOST}/wiki/Inter_${i % 5}">CC Zztest ${i % 5}</a></td><td>${i},${String(i * 7).padStart(2, '0').slice(-2)}</td><td data-sort-value="${population}">${pop} <small>(2023)</small></td><td>${i * 11}</td><td><span class="noviewer"><a href="https://${R06_HOST}/wiki/Module:Zz/${i}" title="modifier les données"><img src="//img.zz_test_wiki.localhost/pencil.png" alt="modifier les données"></a></span></td></tr>`;
  }).join('\n');
  return `<html><body><div class="mw-body"><h1>Liste des communes de Zztest</h1>
<table class="wikitable sortable titre-en-couleur"><caption>Liste des ${count} communes</caption><tbody><tr style="background:#f6f3dd;"><th scope="col">Nom</th><th scope="col">Code<br/><abbr title="Institut">Insee</abbr></th><th scope="col">Code postal</th><th scope="col">Arrondissement</th><th scope="col">Intercommunalité</th><th scope="col">Superficie<br/><small>(km<sup>2</sup>)</small></th><th scope="col">Population<br/><small>(dernière pop. de réf.)</small></th><th scope="col">Densité<br/><small>(hab./km<sup>2</sup>)</small></th><th scope="col" class="unsortable">Modifier</th></tr>
${rows}
<tr style="background:#f6f3dd;"><th scope="row"><a href="https://${R06_HOST}/wiki/Zztest">Zztest</a></th><th>99</th><th></th><th></th><th></th><th>3${NBSP}567,00</th><th>572${NBSP}056 <small>(2023)</small></th><th>160</th><th></th></tr></tbody></table>
<table class="navbox"><tbody><tr><th>Voir aussi</th><td><a href="https://${R06_HOST}/wiki/A">Portail Zztest</a></td></tr></tbody></table></div></body></html>`;
}

describe('R06 : tableau Wikipédia (en-tête en th, total en th), une stratégie html sans LLM', () => {
  it('151 lignes : ni l’en-tête ni le total ; colonnes nommées par l’en-tête ; valeurs lues par le code', () => {
    const html = communes(151);
    const candidates = analyzeCapture(capture(R06_URL, html), [R06_HOST]);
    const dom = candidates.find((c) => c.from === 'dom')!;
    expect(dom).toMatchObject({ count: 151 });
    const keys = Object.keys(dom.skeleton);
    expect(keys).toEqual(expect.arrayContaining(['$.nom', '$.nom_a', '$.code_insee', '$.code_postal', '$.arrondissement', '$.intercommunalite', '$.superficie_km2', '$.population_derniere_pop_de_ref', '$.densite_hab_km2']));
    const proposal: InvestigationProposal = {
      fields: [field('name', 'string', true), field('insee_code', 'string', true), field('postal_code', 'string'), field('arrondissement', 'string'), field('intercommunality', 'string'), field('area_km2', 'number'), field('population', 'integer'), field('density', 'number')],
      sources: [
        {
          candidate: dom.id,
          paths: [
            { field: 'name', path: '$.nom_a', ops: [] },
            { field: 'insee_code', path: '$.code_insee', ops: [] },
            { field: 'postal_code', path: '$.code_postal', ops: [] },
            { field: 'arrondissement', path: '$.arrondissement', ops: [] },
            { field: 'intercommunality', path: '$.intercommunalite', ops: [] },
            { field: 'area_km2', path: '$.superficie_km2', ops: [] },
            { field: 'population', path: '$.population_derniere_pop_de_ref', ops: [] },
            { field: 'density', path: '$.densite_hab_km2', ops: [] },
          ],
          pagination: NONE,
        },
      ],
    };
    const built = buildFromProposal(proposal, candidates, capture(R06_URL, html));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.strategies[0]!.paginated).toBe(false);
    const all = extractRecords(built.strategies[0]!.spec, { body: html }, { outputSchema: built.outputSchema });
    expect(all.ok).toBe(true);
    expect(all.records).toHaveLength(151);
    expect(all.records[0]).toEqual({ name: 'CommuneAzz1', insee_code: '99001', postal_code: '99000 99140', arrondissement: 'Arrzz1', intercommunality: 'CC Zztest 1', area_km2: 1.07, population: 2337, density: 11 });
    expect(all.records.some((r) => r['insee_code'] === '99')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------- R02
const R02_HOST = 'www.zz_test_agence.localhost';
const R02_URL = `https://${R02_HOST}/achat/40`;

function agencyCard(i: number, neuf: boolean): string {
  const address = neuf ? `<p class="c-card-property__address"><i class="icon-pin"></i> <b>VILLE${i % 4}</b> <span>Achat</span></p>` : `<h3 class="c-card-property__address"><i class="icon-pin"></i> <b>VILLE${i % 4}</b> <span>Achat</span></h3>`;
  return `<div class="col-12 property-item"><div class="card position-relative h-100" data-item_name="Bien Zztest ${i}"><div class="card-body"><h2 class="c-card-property__name">Achat Maison Zztest ${i}</h2>${address}<p class="c-card-property__ref"><b>Réf: ZZ-${1000 + i}</b></p><p class="c-card-property__price">${100 + i} 000 €</p><a href="${neuf ? `https://neuf.zz_test_agence.localhost/prog/${i}` : `/maison-zz-v${1000 + i}`}" class="card-stretched-link">Achat Maison Zztest ${i}</a></div></div></div>`;
}

describe('R02 : deux gabarits de carte (adresse en h3 ou en p, même classe)', () => {
  it('le sélecteur de la ville vaut pour les deux gabarits (classe sans balise)', () => {
    const page1 = `<html><body><main><div class="row">${Array.from({ length: 16 }, (_, k) => agencyCard(k + 1, false)).join('')}</div><ul class="pagination"><li><a href="?page=2">2</a></li><li><a href="?page=3">3</a></li></ul></main></body></html>`;
    const candidates = analyzeCapture(capture(R02_URL, page1), [R02_HOST]);
    const dom = candidates.find((c) => c.from === 'dom')!;
    const city = dom.dom!.slots.find((s) => (s.css ?? '').includes('c-card-property__address'))!;
    expect(city.css).not.toMatch(/^h3/);
    const proposal: InvestigationProposal = {
      fields: [field('title', 'string', true), field('city', 'string', true), field('listing_url', 'string', true)],
      sources: [{ candidate: dom.id, paths: [{ field: 'title', path: slotOf(dom, (k) => k.startsWith('$.h2')), ops: [] }, { field: 'city', path: `$.${city.name}`, ops: [] }, { field: 'listing_url', path: slotOf(dom, (_k, d) => d.startsWith('link')), ops: [] }], pagination: NONE }],
    };
    const built = buildFromProposal(proposal, candidates, capture(R02_URL, page1));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const page17 = `<html><body><main><div class="row">${Array.from({ length: 16 }, (_, k) => agencyCard(300 + (k % 12), true)).join('')}</div></main></body></html>`;
    const out = extractRecords(built.strategies[0]!.spec, { body: page17 }, { outputSchema: built.outputSchema });
    expect(out.ok).toBe(true);
    expect(out.records[0]).toMatchObject({ city: 'VILLE0', listing_url: 'https://neuf.zz_test_agence.localhost/prog/300' });
  });
});

// ---------------------------------------------------------------------------------------------------- R03
describe('R03 : cartes d’équipe sans lien, nom dans un bouton', () => {
  it('les cartes sont un bloc répété et le nom (texte du bouton) un emplacement', () => {
    const cards = Array.from({ length: 12 }, (_, k) => `<div class="Card_card__Rl" data-layout="default"><div class="Card_content__9g"><div class="Card_imageContainer__tz Team_teamMemberImage__lZ"><img class="Card_image__MT" src="https://photos.zz_test_equipe.localhost/${k}.png" alt=""></div><div class="Card_contentTrailing__SY"><h3 class="Card_heading__KT"><button class="Team_teamMemberNameButton__LV" type="button">Personne Zztest ${k}</button></h3><div class="Card_contentText__Uo"><p class="Card_text__z4">Poste fictif ${k % 5}</p><p class="Team_teamMemberLocation__Tq">Ville${k % 3}, Payszz</p></div></div></div></div>`).join('');
    const features = Array.from({ length: 3 }, (_, k) => `<div class="Card_card__Rl" data-layout="feature"><div class="Card_content__9g"><h3 class="Card_heading__KT">Valeur Zztest ${k}</h3><p class="Card_text__z4">Texte de valeur ${k} assez long pour compter.</p><a href="/zz/${k}">En savoir plus</a></div></div>`).join('');
    const html = `<html><body><header><nav><a href="/">Accueil</a></nav></header><main><section class="values">${features}</section><section class="team"><div class="Team_grid__x">${cards}</div></section></main></body></html>`;
    const dom = analyzeDom(html, 'https://zz_test_equipe.localhost/about');
    expect(dom).not.toBeNull();
    expect(dom!.blocks.count).toBe(12);
    const extracted = extractRecords(
      { schema_version: 1, kind: 'declarative', request: { method: 'GET', url: 'https://zz_test_equipe.localhost/about', allowed_hosts: ['zz_test_equipe.localhost'] }, sources: [{ id: 'page', from: 'html', records: dom!.blocks.records }], fields: { name: { css: dom!.blocks.slots.find((s) => s.name.startsWith('button'))!.css!, type: 'string', required: true } } },
      { body: html },
      {},
    );
    expect(extracted.ok).toBe(true);
    expect(extracted.records).toHaveLength(12);
    expect(extracted.records[0]).toEqual({ name: 'Personne Zztest 0' });
  });
});

// ---------------------------------------------------------------------------------------------------- R04
const R04_HOST = 'jobs.zz_test_offres.localhost';
const R04_URL = `https://${R04_HOST}/zzentreprise`;

function lever(): string {
  const teams = ['Comptabilite', 'Finance', 'Ventes - France', 'Produit', 'Backend', 'Web'];
  let k = 0;
  const groups = teams
    .map((team, g) => {
      const postings = Array.from({ length: 2 + (g % 3) }, () => {
        k += 1;
        const id = `0000${k}-zz`;
        return `<div class="posting" data-qa-posting-id="${id}"><div class="posting-apply"><a href="https://${R04_HOST}/zzentreprise/${id}" class="posting-btn-submit">Apply</a></div><a class="posting-title" href="https://${R04_HOST}/zzentreprise/${id}"><h5 data-qa="posting-name">Offre fictive ${k}</h5><div class="posting-categories"><span class="display-inline-block small-category-label workplaceTypes">${k % 3 === 0 ? 'Remote' : 'Hybrid'} — </span><span class="sort-by-commitment posting-category small-category-label commitment">${k % 4 === 0 ? 'Part-time' : 'Full-time'}</span><span class="sort-by-location posting-category small-category-label location">Ville${k % 2}</span></div></a></div>`;
      }).join('');
      return `<div class="postings-group">${g % 2 === 0 ? `<div class="large-category-header">Departement ${g}</div>` : ''}<div class="posting-category-title large-category-label">${team}</div><div class="horizontal-line"></div>${postings}</div>`;
    })
    .join('');
  return `<html><body><div class="main-header"><a href="/">Zz entreprise</a></div><div class="filter-bar"><div class="filter-button-wrapper"><div class="filter-button">Equipe</div></div></div><div class="postings-wrapper">${groups}</div></body></html>`;
}

describe('R04 : offres réunies par équipe sous un titre de section ; mode de travail suivi d’un tiret', () => {
  it('le titre du groupe est un emplacement (scope=group) lu par le code pour chaque offre ; « Hybrid — » rendu « Hybrid »', () => {
    const html = lever();
    const candidates = analyzeCapture(capture(R04_URL, html), [R04_HOST]);
    const dom = candidates.find((c) => c.from === 'dom')!;
    expect(dom.count).toBe(18);
    const team = slotOf(dom, (_k, d) => d.includes('scope=group'));
    const workMode = slotOf(dom, (k) => k.includes('workplacetypes'));
    const proposal: InvestigationProposal = {
      fields: [field('title', 'string', true), field('team', 'string', true), field('work_mode', 'string'), field('url', 'string', true)],
      sources: [{ candidate: dom.id, paths: [{ field: 'title', path: '$.h5', ops: [] }, { field: 'team', path: team, ops: [] }, { field: 'work_mode', path: workMode, ops: [] }, { field: 'url', path: slotOf(dom, (k) => k.includes('posting_title_href')), ops: [] }], pagination: NONE }],
    };
    const built = buildFromProposal(proposal, candidates, capture(R04_URL, html));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const all = extractRecords(built.strategies[0]!.spec, { body: html }, { outputSchema: built.outputSchema });
    expect(all.ok).toBe(true);
    expect(all.records.map((r) => r['team'])).toEqual(['Comptabilite', 'Comptabilite', 'Finance', 'Finance', 'Finance', 'Ventes - France', 'Ventes - France', 'Ventes - France', 'Ventes - France', 'Produit', 'Produit', 'Backend', 'Backend', 'Backend', 'Web', 'Web', 'Web', 'Web']);
    expect(all.records[0]).toMatchObject({ title: 'Offre fictive 1', work_mode: 'Hybrid', url: `https://${R04_HOST}/zzentreprise/00001-zz` });
    expect(all.records[2]!['work_mode']).toBe('Remote');
  });
});

// ---------------------------------------------------------------------------------------------------- R10
describe('R10 : étiquettes en liste (champ de type array)', () => {
  it('un champ « array » relié à la clé du tableau rend la liste de chaînes ; le schéma porte items: string', () => {
    const url = 'https://zz_test_quotes.localhost/api/quotes?page=1';
    const body = JSON.stringify({ has_next: true, page: 1, quotes: Array.from({ length: 10 }, (_, k) => ({ text: `Citation fictive ${k}`, author: { name: `Auteur ${k}` }, tags: [`tag${k}`, 'zz'] })) });
    const cap: ReconCapture = { mode: 'static', pageUrl: 'https://zz_test_quotes.localhost/scroll', document: null, exchanges: [{ url, method: 'GET', requestBody: null, requestContentType: null, status: 200, contentType: 'application/json', body, bytes: body.length }], totalBytes: body.length };
    const candidates = analyzeCapture(cap, ['zz_test_quotes.localhost']);
    const api = candidates.find((c) => c.from === 'response')!;
    expect(api.skeleton['$.tags']).toBe('array');
    const proposal: InvestigationProposal = {
      fields: [field('text', 'string', true), field('author', 'string'), field('tags', 'array')],
      sources: [{ candidate: api.id, paths: [{ field: 'text', path: '$.text', ops: [] }, { field: 'author', path: '$.author.name', ops: [] }, { field: 'tags', path: '$.tags', ops: [] }], pagination: NONE }],
    };
    const built = buildFromProposal(proposal, candidates, cap);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect((built.outputSchema as { properties: Record<string, unknown> }).properties['tags']).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(built.sample[0]).toEqual({ text: 'Citation fictive 0', author: 'Auteur 0', tags: ['tag0', 'zz'] });
  });
});
