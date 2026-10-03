// SPDX-License-Identifier: AGPL-3.0-only
// Sites des cas de référence en version fixtures (gate M2, tests/cases) : D0 (catalogue rendu serveur paginé par lien
// rel=next, données embarquées par page) et C1 (recherche paginée dont la page 2 sert un défi). C2 et C3 (site à compte) sont servis
// par la fixture `login`. Tout est factice : aucun site réel imité, défi générique sans mécanisme de résolution.
import { ControlError, type FxResponse, type SiteFactory } from '../core.ts';
import { formatEuro, makeProducts, pad, slicePage } from '../data.ts';
import { esc, html, intParam, json, page } from '../res.ts';
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

export const CASE_SITES: SiteFactory[] = [books, searchGuarded];
