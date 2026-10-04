// SPDX-License-Identifier: AGPL-3.0-only
// Sites des cas de référence en version fixtures (gate M2, tests/cases) : D0 (catalogue rendu serveur paginé par lien
// rel=next, données embarquées par page) et C1 (recherche paginée dont la page 2 sert un défi). C2 et C3 (site à compte) sont servis
// par la fixture `login`. Tout est factice : aucun site réel imité, défi générique sans mécanisme de résolution.
import { ControlError, type FxResponse, type SiteFactory } from '../core.ts';
import { formatEuro, makeProducts, pad, slicePage } from '../data.ts';
import { esc, html, intParam, json, page, redirect } from '../res.ts';
import { challengePage } from './guard-sites.ts';

const safeJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');
const notFound = (): FxResponse => json(404, { error: 'not_found' });

// ---------------------------------------------------------------- D0 : catalogue de livres rendu serveur
const BOOKS_PER_PAGE = 20;
const BOOKS_TOTAL = 60;

const books: SiteFactory = (env) => {
  const list = makeProducts(env.seed, 'books', BOOKS_TOTAL).map((p, i) => ({ sku: `zz_test_book_${pad(i + 1, 4)}`, title: `Livre Zztest ${pad(i + 1, 4)} ${p.title.split(' ')[0]}`, price_cents: p.price_cents }));
  const pages = Math.ceil(BOOKS_TOTAL / BOOKS_PER_PAGE);
  const pathOf = (n: number): string => (n === 1 ? '/' : `/catalogue/page-${n}.html`);
  const render = (n: number): FxResponse => {
    const slice = slicePage(list, n, BOOKS_PER_PAGE);
    // Données de la page embarquées par le rendu serveur (forme __NEXT_DATA__) : gisement E1 « embedded ». Le JSON-LD
    // ItemList n'est pas utilisé : la reconnaissance ne descend pas sous le tableau de blocs JSON-LD (constat de la gate W2).
    const data = { props: { pageProps: { books: slice.map((b) => ({ sku: b.sku, title: b.title, price: b.price_cents / 100 })), page: n, pages } }, page: '/catalogue/[page]', query: {}, buildId: 'zz_test_build', isFallback: false };
    const cards = slice.map((b) => `<article class="book" data-sku="${b.sku}"><h3><a href="/livre/${b.sku}.html">${esc(b.title)}</a></h3><p class="price">${formatEuro(b.price_cents)}</p></article>`).join('\n');
    const next = n < pages ? `<li class="next"><a rel="next" href="${pathOf(n + 1)}">suivant</a></li>` : '';
    return html(
      200,
      page(`Livres page ${n} sur ${pages}`, `<h1>Tous les livres</h1>\n<section>${cards}</section>\n<ul class="pager"><li class="current">Page ${n} sur ${pages}</li>${next}</ul>`, `<script id="__NEXT_DATA__" type="application/json">${safeJson(data)}</script>`),
    );
  };
  return {
    id: 'books',
    lot: 'cases',
    description: `D0 en fixture : catalogue de ${BOOKS_TOTAL} livres rendu serveur, ${BOOKS_PER_PAGE} par page, données embarquées par page (__NEXT_DATA__), pages liées par rel=next (/, /catalogue/page-N.html)`,
    hosts: ['zz_test_books.localhost'],
    smoke: { path: '/', status: 200 },
    handle(req) {
      if (req.path === '/') return render(1);
      const m = /^\/catalogue\/page-(\d{1,4})\.html$/.exec(req.path);
      if (m) {
        const n = Number(m[1]);
        return n >= 2 && n <= pages ? render(n) : html(404, page('Introuvable', '<h1>Introuvable</h1>'));
      }
      return html(404, page('Introuvable', '<h1>Introuvable</h1>'));
    },
  };
};

// ---------------------------------------------------------------- C1 : recherche paginée, défi à la page 2
const searchGuarded: SiteFactory = (env) => {
  const ads = makeProducts(env.seed, 'search_guarded', 60).map((p, i) => ({ id: `zz_test_ad_${pad(i + 1, 4)}`, title: p.title, price_cents: p.price_cents, city: ['Zzville', 'Testbourg', 'Fixtureville'][i % 3]! }));
  const perPage = 20;
  /** Requêtes reçues par page de l'API de recherche (commande `page_hits`) : « une seule requête sur la page du défi ». */
  const hits = new Map<number, number>();
  return {
    id: 'search_guarded',
    lot: 'cases',
    description: 'C1 en fixture : page de recherche (/recherche) dont la liste vient de /api/search?page=N ; page 1 en JSON, pages 2 et suivantes : défi générique (403 + x-zz-test-shield: challenge) ; commande page_hits',
    hosts: ['zz_test_search_guarded.localhost'],
    smoke: { path: '/api/search', status: 200 },
    handle(req) {
      if (req.path === '/' || req.path === '/recherche') {
        const q = (req.query.get('q') ?? '').replace(/[^a-z0-9 ]/gi, '').slice(0, 40);
        return html(
          200,
          page(
            'Recherche zz_test',
            `<h1>Annonces</h1><ul id="ads"></ul><script>fetch("/api/search?q=${encodeURIComponent(q)}&page=1").then(r=>r.json()).then(d=>{const ul=document.getElementById("ads");for(const a of d.ads){const li=document.createElement("li");li.textContent=a.title;ul.appendChild(li)}})</script>`,
          ),
        );
      }
      if (req.path !== '/api/search') return notFound();
      const n = intParam(req, 'page', 1, 1, 10_000);
      hits.set(n, (hits.get(n) ?? 0) + 1);
      if (n >= 2) return html(403, challengePage(), { 'x-zz-test-shield': 'challenge', 'cache-control': 'no-store' });
      const slice = slicePage(ads, n, perPage);
      return json(200, { ads: slice, page: n, has_more: n * perPage < ads.length, total: ads.length });
    },
    control(args) {
      if (args['action'] !== 'page_hits') throw new ControlError('action attendue : page_hits');
      return Object.fromEntries([...hits.entries()].map(([k, v]) => [String(k), v]));
    },
  };
};


// ---------------------------------------------------------------- liste HTML statique paginée par le chemin (constat Janssens)
// Agence immobilière FICTIVE : 519 biens, 10 cartes `article.item-bien` par page, pagination `/nos-maisons/page/N/`
// jusqu’à la page 52 (9 cartes), page au-delà servie en 200 vide, `/page/1/` redirigé vers la liste. Tous les champs sont
// dans la carte (lien relatif avec `data-ref`, titre `h3`, secteur et code postal, référence, surface et chambres en `ul li`,
// prix `.css-title` ou « Prix : Nous consulter ») ; certaines cartes n'ont ni chambres ni surface. Décor répété (diaporama,
// « Envie d'en voir plus ? »), menu de navigation à liens et carte « coup de cœur » dans l'en-tête : du bruit pour la détection.
export const HTML_LIST_TOTAL = 519;
const HTML_LIST_PER_PAGE = 10;
const HTML_LIST_PAGES = Math.ceil(HTML_LIST_TOTAL / HTML_LIST_PER_PAGE);
const SECTORS = ['Zzport & Littoral', 'Testville & Collines', 'Fixture-sur-Mer', 'Plateau Zztest', 'Vallée des Essais'];

/** Bien n°i (1-based), déterministe : prix « Nous consulter » tous les 13 biens, sans chambres tous les 7, sans surface tous les 11, même secteur sur toute la page 1. */
export function htmlListItem(i: number): { ref: string; title: string; sector: string; postal: string; surface: string | null; rooms: number | null; price: number | null; path: string } {
  const ref = `ZZ${pad(i, 4)}va`;
  return {
    ref,
    title: `Maison Zztest n°${pad(i, 4)} à vendre`,
    // Page 1 : un seul secteur (comme le secteur dominant de la page 1 chez Janssens) ; varié ensuite.
    sector: (i <= HTML_LIST_PER_PAGE ? SECTORS[0] : SECTORS[i % SECTORS.length])!,
    postal: String(83000 + ((i * 37) % 900)).padStart(5, '0'),
    surface: i % 11 === 0 ? null : `${80 + ((i * 7) % 300)}.${pad((i * 13) % 100, 2)}`,
    rooms: i % 7 === 0 ? null : 1 + (i % 6),
    price: i % 13 === 0 ? null : 150_000 + ((i * 7919) % 4_000) * 1_000,
    path: `/propriete/zz-bien-${ref.toLowerCase()}/`,
  };
}

const thousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

const htmlList: SiteFactory = () => {
  const card = (i: number): string => {
    const b = htmlListItem(i);
    const slides = [1, 2, 3].map((k) => `<div class="relative swiper-slide overflow-hidden"><figure class="js-my-bg absolute inset-0"><picture class="lazy-ci-ctr"><img class="h-full w-full object-cover" ci-src="/img/${b.ref}-${k}.jpg" alt=""/></picture></figure></div>`).join('');
    const lis = [b.surface === null ? '' : `<li class="leading-3">\n ${b.surface}\n m²\n</li>`, b.rooms === null ? '' : `<li class="pl-2 leading-3">\n ${b.rooms}\n chambre${b.rooms > 1 ? 's' : ''}\n</li>`].join('');
    const price = b.price === null ? 'Prix : Nous consulter' : `${thousands(b.price)}\n €<sup>*</sup>`;
    return `<article class="item-bien block h-full  css-card-bien js-card-bien">
<a href="${b.path}" target="_blank" class="flex flex-col relative h-full w-full bg-white group/biens" data-ref="${b.ref}">
<div class="w-full relative z-2 aspect-bien overflow-hidden css-ratio" x-data="handleCookie()" data-cookies='null'>
<div class="w-full h-full swiper js-slider-images"><div class="swiper-wrapper">${slides}
<div class="relative swiper-slide overflow-hidden"><div class="content absolute inset-0"><div class="content_title font-bold font-title text-28">Envie d'en voir plus ?</div><div class="text-14 uppercase underline">Voir la fiche complète du bien</div></div></div>
</div></div></div>
<div class="group/link w-full px-4 pt-6 pb-6 flex-auto flex flex-col justify-between"><div class="w-full">
<div class="flex items-start justify-between gap-5 mb-4">
<div class="text-14 font-bold uppercase flex flex-wrap "><span class="flex-none mr-1 max-w-full">\n ${esc(b.sector)}\n</span><span\n class="flex-auto">\n (${b.postal})\n</span></div>
<div class="text-14 font-bold uppercase flex-none">\n ref\n :\n ${b.ref}\n</div>
</div>
<h3 class="font-light font-title text-28 mb-6 pr-4">\n ${esc(b.title)}\n</h3>
</div>
<div class="flex items-center justify-between gap-x-8"><div class=""><ul class="text-14 font-bold uppercase flex item-center space-x-2">${lis}</ul></div>
<div class="flex-none text-18 css-title">\n ${price}\n</div></div>
</div></a></article>`;
  };
  const pathOf = (n: number): string => (n === 1 ? '/nos-maisons/' : `/nos-maisons/page/${n}/`);
  const pager = (n: number): string => {
    const nums = [1, 2, 3, 4, n - 1, n, n + 1, HTML_LIST_PAGES].filter((k, idx, all) => k >= 1 && k <= HTML_LIST_PAGES && all.indexOf(k) === idx).sort((a, b) => a - b);
    const items = nums.map((k) => (k === n ? `<div class="page-number page-numbers current">${k}</div>` : `<a href="${pathOf(k)}" class="font-bold page-number page-numbers js-item-pagination" data-page="${k}">${k}</a>`)).join('<div class="dots">…</div>');
    const prev = n > 1 ? `<a href="${pathOf(n - 1)}" class="group/btn js-item-pagination"><svg><use xlink:href="#arrow-left"></use></svg></a>` : '<a href="# " data-page="" class="group/btn disabled"><svg></svg></a>';
    const next = n < HTML_LIST_PAGES ? `<a href="${pathOf(n + 1)}" data-page="${n + 1}" class="group/btn js-item-pagination"><svg><use xlink:href="#arrow-right"></use></svg></a>` : '<a href="# " data-page="" class="group/btn disabled"><svg></svg></a>';
    return `<div class="w-full text-center mt-16 js-pagination"><nav class="pagination-container" aria-label="Pagination">${prev}<div class="inline-flex space-x-6">${items}</div>${next}</nav></div>`;
  };
  const header = `<header class="site-header"><nav class="menu"><ul>${['Acheter', 'Louer', 'Vendre', 'Estimer', 'Agences', 'Équipe', 'Contact', 'Blog'].map((m, k) => `<li class="menu-item"><a href="/menu/${k}/">${m} chez Zztest Immobilier</a></li>`).join('')}</ul>
<article class="item-bien block h-full css-card-bien js-card-bien featured"><a href="/propriete/zz-coup-de-coeur/" class="flex flex-col" data-ref="ZZFEAT">Coup de cœur Zztest <span class="flex-none">Secteur vedette</span></a></article></nav></header>`;
  const footer = `<footer><ul>${['Mentions', 'Cookies', 'Plan', 'Presse', 'Carrières'].map((m, k) => `<li class="foot-item"><a href="/pied/${k}/">${m} Zztest Immobilier</a></li>`).join('')}</ul></footer>`;
  const render = (n: number): FxResponse => {
    const from = (n - 1) * HTML_LIST_PER_PAGE + 1;
    const to = Math.min(HTML_LIST_TOTAL, n * HTML_LIST_PER_PAGE);
    const cards = from > HTML_LIST_TOTAL ? '' : Array.from({ length: to - from + 1 }, (_, k) => card(from + k)).join('\n');
    const body = `${header}<main><h1>Nos maisons à vendre (zz_test)</h1><div class="grid grid-cols-3 gap-8">${cards}</div>${from > HTML_LIST_TOTAL ? '<p class="empty">Aucun bien ne correspond.</p>' : pager(n)}
<div class="css-seo-content"><h2 class="css-title css-title_h2">Découvrez notre sélection fictive</h2><p>Texte de référencement zz_test, sans rapport avec la liste.</p></div></main>${footer}`;
    return html(200, page(`Nos maisons à vendre, page ${n}`, body, '<script type="application/ld+json">{"@context":"https://schema.org","@type":"RealEstateAgent","name":"Zztest Immobilier"}</script>'));
  };
  return {
    id: 'html_list',
    lot: 'cases',
    description: `Liste HTML statique paginée par le chemin (constat Janssens) : ${HTML_LIST_TOTAL} biens fictifs, 10 cartes article.item-bien par page, /nos-maisons/page/N/ jusqu'à ${HTML_LIST_PAGES}, page au-delà en 200 vide, « Nous consulter », champs manquants, décor répété`,
    hosts: ['zz_test_html_list.localhost'],
    smoke: { path: '/nos-maisons/', status: 200 },
    handle(req) {
      if (req.path === '/nos-maisons/' || req.path === '/nos-maisons') return render(1);
      const m = /^\/nos-maisons\/page\/(\d{1,4})\/?$/.exec(req.path);
      if (m) {
        const n = Number(m[1]);
        if (n === 1) return redirect(301, '/nos-maisons/');
        return n >= 2 ? render(n) : html(404, page('Introuvable', '<h1>Introuvable</h1>'));
      }
      return html(404, page('Introuvable', '<h1>Introuvable</h1>'));
    },
  };
};

// ---------------------------------------------------------------- banc de cas réels (passage 1) en fixtures FICTIVES
// Structures des cas R07, R08, R06, R02 et R04 de cdc/scrapyomama-runtime/.executed/banc-reel.md, sans aucune donnée réelle.

/** R07 : catalogue paginé `index.html` puis `page-N.html`, lien « next » relatif (`li.next`), note en classe CSS, titre tronqué (complet dans `title`), « In stock » partout. */
export const CATALOGUE_PAGES_TOTAL = 152;
const CATALOGUE_PER_PAGE = 20;
const CATALOGUE_PAGES = Math.ceil(CATALOGUE_PAGES_TOTAL / CATALOGUE_PER_PAGE);
const STAR_WORDS = ['One', 'Two', 'Three', 'Four', 'Five'];
export function cataloguePagesItem(i: number): { title: string; price: number; rating: number; path: string } {
  return { title: `Zz${pad(i, 3)} livre fictif du banc, une histoire inventee de bout en bout`, price: 10 + ((i * 37) % 4_000) / 100, rating: (i % 5) + 1, path: `/catalogue/zz-livre-${pad(i, 3)}_${900 + i}/index.html` };
}
const cataloguePages: SiteFactory = () => {
  const dir = '/catalogue/category/books/zz-default_15/';
  const render = (n: number): FxResponse => {
    const from = (n - 1) * CATALOGUE_PER_PAGE + 1;
    const to = Math.min(CATALOGUE_PAGES_TOTAL, n * CATALOGUE_PER_PAGE);
    const pods = Array.from({ length: to - from + 1 }, (_, k) => {
      const i = from + k;
      const b = cataloguePagesItem(i);
      const rel = `../../..${b.path.replace('/catalogue', '')}`;
      return `<li class="col-xs-6 col-sm-4"><article class="product_pod"><div class="image_container"><a href="${rel}"><img src="../../../../media/cache/zz/${i}.jpg" alt="${esc(b.title)}" class="thumbnail"></a></div>
<p class="star-rating ${STAR_WORDS[i % 5]}"><i class="icon-star"></i><i class="icon-star"></i><i class="icon-star"></i></p>
<h3><a href="${rel}" title="${esc(b.title)}">${esc(b.title.slice(0, 20))}...</a></h3>
<div class="product_price"><p class="price_color">£${b.price.toFixed(2)}</p><p class="instock availability"><i class="icon-ok"></i> In stock</p><form><button type="submit" class="btn btn-primary btn-block">Add to basket</button></form></div></article></li>`;
    }).join('\n');
    const next = n < CATALOGUE_PAGES ? `<li class="next"><a href="page-${n + 1}.html">next</a></li>` : '';
    const prev = n > 1 ? `<li class="previous"><a href="page-${n - 1}.html">previous</a></li>` : '';
    const side = ['Voyage', 'Mystere', 'Histoire', 'Poesie', 'Cuisine', 'Sport'].map((c, k) => `<li><a href="../zz-${c.toLowerCase()}_${k + 2}/index.html">${c} Zztest</a></li>`).join('');
    const body = `<header><nav><ul><li><a href="/index.html">Accueil Zztest</a></li></ul></nav></header><div class="side_categories"><ul>${side}</ul></div>
<form class="form-horizontal"><strong>${CATALOGUE_PAGES_TOTAL}</strong> results - showing <strong>${from}</strong> to <strong>${to}</strong>.</form>
<section><ol class="row">${pods}</ol><div><ul class="pager">${prev}<li class="current">Page ${n} of ${CATALOGUE_PAGES}</li>${next}</ul></div></section>`;
    return html(200, page(`Zz catalogue, page ${n}`, body));
  };
  return {
    id: 'catalogue_pages',
    lot: 'cases',
    description: `Banc réel R07 en fixture : catalogue de ${CATALOGUE_PAGES_TOTAL} livres fictifs, ${CATALOGUE_PER_PAGE} par page, ${dir}index.html puis page-N.html (lien « next » relatif dans li.next, page ${CATALOGUE_PAGES + 1} en 404), note en classe (star-rating Three), titre tronqué complet dans title, « In stock » partout`,
    hosts: ['zz_test_catalogue_pages.localhost'],
    smoke: { path: `${dir}index.html`, status: 200 },
    handle(req) {
      if (req.path === `${dir}index.html`) return render(1);
      const m = new RegExp(`^${dir.replace(/[/.-]/g, '\\$&')}page-(\\d{1,3})\\.html$`).exec(req.path);
      if (m !== null && Number(m[1]) >= 1 && Number(m[1]) <= CATALOGUE_PAGES) return render(Number(m[1]));
      return html(404, page('Introuvable', '<h1>404 Not Found</h1>'));
    },
  };
};

/** R08 : tableau paginé (en-tête `th`, lignes `tr`), page de base sans suffixe puis `_1`, `_2`, lien « Next » ; nom et description dans la même cellule. */
export const TABLE_PAGES_TOTAL = 137;
const TABLE_PER_PAGE = 50;
const TABLE_PAGES = Math.ceil(TABLE_PAGES_TOTAL / TABLE_PER_PAGE);
export function tablePagesRow(i: number): { name: string; cycle: string; city: string; venue: string; date: string } {
  return { name: `SALON ZZTEST ${pad(i, 4)}`, cycle: i % 4 === 0 ? 'unknown' : 'once a year', city: `Villezz${i % 7}`, venue: `Parc Zztest ${i}`, date: i % 3 === 0 ? 'June 2026' : `${pad(1 + (i % 9), 2)}/${pad(10 + (i % 9), 2)}/2026` };
}
const tablePages: SiteFactory = () => {
  const pathOf = (n: number): string => (n === 0 ? '/fairs/zz_trade-shows_fr.html' : `/fairs/zz_trade-shows_fr_${n}.html`);
  const render = (n: number): FxResponse => {
    const from = n * TABLE_PER_PAGE + 1;
    const to = Math.min(TABLE_PAGES_TOTAL, (n + 1) * TABLE_PER_PAGE);
    const rows = Array.from({ length: to - from + 1 }, (_, k) => {
      const i = from + k;
      const r = tablePagesRow(i);
      const days = i % 3 === 0 ? '' : `<br><i>${1 + (i % 4)} days</i>`;
      return `<tr><td><a href="f-zz-salon-${i}-1.html"><b>${r.name}</b><i>Salon fictif numero ${i} pour le banc de test</i></a></td><td>${r.cycle}</td><td><a href="cy1_zz-ville-${i % 7}.html">${r.city}</a> <a href="pl1_zz-lieu-${i}.html">${r.venue}</a></td><td>${r.date}${days}</td></tr>`;
    }).join('\n');
    const next = n < TABLE_PAGES - 1 ? `<div><a href="${pathOf(n + 1).replace('/fairs/', '')}" title="All Trade Shows (continued)"><u>Next</u></a></div>` : '';
    const body = `<header><nav><a href="/">Accueil</a></nav></header><div class="zones"><h2>Zones</h2><ul>${['Europe', 'Asie', 'Afrique', 'Amerique', 'Oceanie'].map((z, k) => `<li><a href="z${k}_zz.html">Salons ${z} Zztest</a></li>`).join('')}</ul></div>
<table class="tradeshows"><caption>${TABLE_PAGES_TOTAL} Trade Shows</caption><thead><tr><th>Exhibition Name</th><th>Cycle</th><th>Venue</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table>
<div class="pages-links"><div><a href="" title="first page"><u>First page</u></a></div>${next}</div>`;
    return html(200, page(`Salons Zztest, page ${n}`, body));
  };
  return {
    id: 'table_pages',
    lot: 'cases',
    description: `Banc réel R08 en fixture : ${TABLE_PAGES_TOTAL} salons fictifs en tableau (thead th, tbody tr), ${TABLE_PER_PAGE} lignes par page, /fairs/zz_trade-shows_fr.html puis _1, _2 (lien « Next »), _${TABLE_PAGES} en 404`,
    hosts: ['zz_test_table_pages.localhost'],
    smoke: { path: pathOf(0), status: 200 },
    handle(req) {
      if (req.path === pathOf(0)) return render(0);
      const m = /^\/fairs\/zz_trade-shows_fr_(\d{1,3})\.html$/.exec(req.path);
      if (m !== null && Number(m[1]) >= 1 && Number(m[1]) < TABLE_PAGES) return render(Number(m[1]));
      return html(404, page('Introuvable', '<h1>Introuvable</h1>'));
    },
  };
};

/** R06 : tableau de type Wikipédia (en-tête en th dans tbody, total en th, nom parfois en gras, population « 2 337 (2023) », virgule décimale, deux codes postaux). */
export const WIKI_TABLE_ROWS = 151;
export function wikiTableRow(i: number): { name: string; insee: string; population: number } {
  return { name: `Commune${String.fromCharCode(65 + ((i - 1) % 26))}zz${i}`, insee: `99${pad(i, 3)}`, population: 1000 + i * 1337 };
}
const wikiTable: SiteFactory = () => {
  const host = 'zz_test_wiki_table.localhost';
  const NBSP = ' ';
  const rows = Array.from({ length: WIKI_TABLE_ROWS }, (_, k) => {
    const i = k + 1;
    const r = wikiTableRow(i);
    const link = `<a href="https://${host}/wiki/${r.name}" title="${r.name}">${r.name}</a>`;
    const nameCell = i === 1 ? `<b>${link}</b><br><small>(préfecture)</small>` : link;
    const postal = i === 1 ? '99000<br/>99140' : String(99000 + i * 10);
    const pop = String(r.population).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
    return `<tr><td style="text-align:left;">${nameCell}</td><td>${r.insee}</td><td>${postal}</td><td><a href="https://${host}/wiki/Arr_${i % 3}">Arrzz${i % 3}</a></td><td><a href="https://${host}/wiki/Inter_${i % 5}">CC Zztest ${i % 5}</a></td><td>${i},${pad((i * 7) % 100, 2)}</td><td data-sort-value="${r.population}">${pop} <small>(2023)</small></td><td>${i * 11}</td><td><span class="noviewer"><a href="https://${host}/wiki/Module:Zz/${i}" title="modifier les données"><img src="https://${host}/pencil.png" alt="modifier"></a></span></td></tr>`;
  }).join('\n');
  const body = `<div class="mw-body"><h1>Liste des communes de Zztest</h1>
<table class="wikitable sortable titre-en-couleur"><caption>Liste des ${WIKI_TABLE_ROWS} communes</caption><tbody><tr><th scope="col">Nom</th><th scope="col">Code<br/><abbr title="Institut">Insee</abbr></th><th scope="col">Code postal</th><th scope="col">Arrondissement</th><th scope="col">Intercommunalité</th><th scope="col">Superficie<br/><small>(km<sup>2</sup>)</small></th><th scope="col">Population<br/><small>(dernière pop. de réf.)</small></th><th scope="col">Densité<br/><small>(hab./km<sup>2</sup>)</small></th><th scope="col">Modifier</th></tr>
${rows}
<tr><th scope="row"><a href="https://${host}/wiki/Zztest">Zztest</a></th><th>99</th><th></th><th></th><th></th><th>3${NBSP}567,00</th><th>572${NBSP}056 <small>(2023)</small></th><th>160</th><th></th></tr></tbody></table>
<table class="navbox"><tbody><tr><th>Voir aussi</th><td><a href="https://${host}/wiki/A">Portail Zztest</a></td></tr></tbody></table></div>`;
  return {
    id: 'wiki_table',
    lot: 'cases',
    description: `Banc réel R06 en fixture : tableau de ${WIKI_TABLE_ROWS} communes fictives (en-tête th, ligne de total en th, nom parfois en gras, population « 2 337 (2023) », virgule décimale, deux codes postaux séparés par <br>), une seule page`,
    hosts: [host],
    smoke: { path: '/wiki/Liste_des_communes_de_Zztest', status: 200 },
    handle(req) {
      if (req.path === '/wiki/Liste_des_communes_de_Zztest') return html(200, page('Liste des communes de Zztest', body));
      return html(404, page('Introuvable', '<h1>Introuvable</h1>'));
    },
  };
};

/** R02 : `?page=N`, pages 1 à 4 distinctes (16 cartes), pages 5 à 7 : 12 programmes neufs répétés (second gabarit : sans titre h2, adresse en p, lien vers un sous-domaine), page 8 vide. */
export const AGENCY_DUPES_DISTINCT = 4 * 16 + 12;
const agencyDupes: SiteFactory = () => {
  const card = (i: number, neuf: boolean): string => {
    const address = neuf ? `<p class="c-card-property__address"><i class="icon-pin"></i> <b>VILLEZZ${i % 4}</b> <span>Achat</span></p>` : `<h3 class="c-card-property__address"><i class="icon-pin"></i> <b>VILLEZZ${i % 4}</b> <span>Achat</span></h3>`;
    const title = neuf ? '' : `<h2 class="c-card-property__name">Achat Maison Zztest ${i}</h2>`;
    const ref = neuf ? `<p class="c-card-property__ref"><b>PROG NEUF: ${i}</b></p>` : `<p class="c-card-property__ref"><b>Réf: ZZ-${1000 + i}</b></p>`;
    const href = neuf ? `https://zz_test_agency_dupes_neuf.localhost/prog/${i}` : `/maison-zz-v${1000 + i}`;
    return `<div class="col-12 col-md-6 property-item"><div class="card position-relative h-100" data-item_name="Bien Zztest ${i}"><div class="card-body">${title}${address}${ref}<p class="c-card-property__price">${100 + i} 000 €</p><a href="${href}" class="card-stretched-link">Annonce Zztest ${i}</a></div></div></div>`;
  };
  const render = (n: number): FxResponse => {
    const cards = n <= 4 ? Array.from({ length: 16 }, (_, k) => card((n - 1) * 16 + k + 1, false)) : n <= 7 ? Array.from({ length: 16 }, (_, k) => card(300 + ((k + n) % 12), true)) : [];
    const pager = `<ul class="pagination">${[1, 2, 3, 4, 5, 6, 7].map((k) => (k === n ? `<li class="active"><span>${k}</span></li>` : `<li><a href="/achat/40?page=${k}">${k}</a></li>`)).join('')}</ul>`;
    return html(200, page(`Achat, page ${n}`, `<header><nav><a href="/">Accueil Zztest</a></nav></header><main><h1>${AGENCY_DUPES_DISTINCT + 9} annonces</h1><div class="row">${cards.join('')}</div>${cards.length === 0 ? '<p>Aucune annonce.</p>' : pager}</main>`));
  };
  return {
    id: 'agency_dupes',
    lot: 'cases',
    description: `Banc réel R02 en fixture : ?page=N, pages 1 à 4 distinctes (16 cartes), pages 5 à 7 : 12 programmes neufs répétés au second gabarit (sans titre h2, adresse en p), page 8 vide ; ${AGENCY_DUPES_DISTINCT} annonces distinctes`,
    hosts: ['zz_test_agency_dupes.localhost'],
    smoke: { path: '/achat/40', status: 200 },
    handle(req) {
      if (req.path !== '/achat/40') return html(404, page('Introuvable', '<h1>Introuvable</h1>'));
      return render(intParam(req, 'page', 1, 1, 1_000));
    },
  };
};

/** R04 : offres réunies par équipe sous un titre de section (`.posting-category-title`), mode de travail « Hybrid — ». */
const JOBS_GROUPED_TEAMS = ['Comptabilite', 'Finance', 'Ventes - France', 'Produit', 'Backend', 'Web'];
export function jobsGrouped(): { id: string; title: string; team: string; workMode: string }[] {
  const out: { id: string; title: string; team: string; workMode: string }[] = [];
  JOBS_GROUPED_TEAMS.forEach((team, g) => {
    for (let k = 0; k < 2 + (g % 3); k += 1) {
      const n = out.length + 1;
      out.push({ id: `0000${n}-zz`, title: `Offre fictive ${n}`, team, workMode: n % 3 === 0 ? 'Remote' : 'Hybrid' });
    }
  });
  return out;
}
const jobsGroupedSite: SiteFactory = () => {
  const host = 'zz_test_jobs_grouped.localhost';
  const jobs = jobsGrouped();
  const groups = JOBS_GROUPED_TEAMS.map((team, g) => {
    const postings = jobs
      .filter((j) => j.team === team)
      .map((j) => `<div class="posting" data-qa-posting-id="${j.id}"><div class="posting-apply"><a href="https://${host}/zzentreprise/${j.id}" class="posting-btn-submit">Apply</a></div><a class="posting-title" href="https://${host}/zzentreprise/${j.id}"><h5 data-qa="posting-name">${esc(j.title)}</h5><div class="posting-categories"><span class="display-inline-block small-category-label workplaceTypes">${j.workMode} — </span><span class="sort-by-commitment posting-category small-category-label commitment">Full-time</span><span class="sort-by-location posting-category small-category-label location">Villezz${Number(j.id.slice(4, 5)) % 2}</span></div></a></div>`)
      .join('');
    return `<div class="postings-group">${g % 2 === 0 ? `<div class="large-category-header">Departement ${g}</div>` : ''}<div class="posting-category-title large-category-label">${esc(team)}</div><div class="horizontal-line"></div>${postings}</div>`;
  }).join('');
  return {
    id: 'jobs_grouped',
    lot: 'cases',
    description: `Banc réel R04 en fixture : ${jobs.length} offres fictives réunies par équipe sous un titre de section (.posting-category-title), mode de travail « Hybrid — », une seule page`,
    hosts: [host],
    smoke: { path: '/zzentreprise', status: 200 },
    handle(req) {
      if (req.path === '/zzentreprise') return html(200, page('Offres Zztest', `<div class="main-header"><a href="/">Zz entreprise</a></div><div class="postings-wrapper">${groups}</div>`));
      return html(404, page('Introuvable', '<h1>Introuvable</h1>'));
    },
  };
};

export const CASE_SITES: SiteFactory[] = [books, searchGuarded, htmlList, cataloguePages, tablePages, wikiTable, agencyDupes, jobsGroupedSite];
