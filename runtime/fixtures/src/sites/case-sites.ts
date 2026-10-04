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

export const CASE_SITES: SiteFactory[] = [books, searchGuarded, htmlList];
