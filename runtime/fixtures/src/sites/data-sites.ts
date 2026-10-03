// SPDX-License-Identifier: AGPL-3.0-only
// Sites de données : API JSON, SSR, SPA, DOM, HTML irrégulier, volume, données personnelles, défilement, blobs, curseur, Link.
import { ControlError, type FxRequest, type FxResponse, type SiteFactory } from '../core.ts';
import { formatEuro, makeContacts, makePeople, makeProducts, slicePage, type Product } from '../data.ts';
import { esc, html, intParam, json, page, redirect } from '../res.ts';

const notFound = (): FxResponse => json(404, { error: 'not_found' });

// ---------------------------------------------------------------- 1. API JSON paginée (+ 6 mutations du banc 15 §11)
const MUTATIONS = [
  'none',
  'rename_field',
  'move_endpoint',
  'wrap_in_envelope',
  'change_pagination',
  'type_change',
  'out_of_schema',
  'empty',
  // D-49 (2.3) : items écartés. Un seul item hors schéma (score en texte, e-mail factice sous une clé inconnue), puis 30 %
  // des items hors schéma (au-delà du seuil de casse : 20 % et 5 items). Seuil décidé sur le run, pas page par page : un
  // 501e contact au score en texte (seul sur la dernière page à 50 par page), puis les contacts 51 à 100 au score en texte
  // (la page 2 entière à 50 par page, 10 % du run).
  'one_item_bad_type',
  'bad_items_30pct',
  'trailing_bad_item',
  'bad_page_2',
] as const;
type Mutation = (typeof MUTATIONS)[number];

const apiJson: SiteFactory = (env) => {
  const contacts = makeContacts(env.seed, 'api_json', 500);
  let mutation: Mutation = 'none';
  /** `trailing_bad_item` : contact de plus, après les 500, au score en texte. */
  const trailing = { ...contacts[0]!, id: 'zz_test_contact_0501', name: 'Zztest Trailing', email: 'zz_test_contact_0501@example.invalid' };

  const shape = (c: (typeof contacts)[number]): Record<string, unknown> => {
    const index = contacts.indexOf(c);
    if (mutation === 'one_item_bad_type' && index === 3) {
      return { id: c.id, name: c.name, email: c.email, city: c.city, score: 'N/A', extra: { contact_email: 'zz_test_leak_0003@example.invalid' } };
    }
    if (mutation === 'bad_items_30pct' && index % 10 < 3) return { id: c.id, name: c.name, email: c.email, city: c.city, score: 'N/A' };
    if ((mutation === 'trailing_bad_item' && c === trailing) || (mutation === 'bad_page_2' && index >= 50 && index < 100)) return { id: c.id, name: c.name, email: c.email, city: c.city, score: 'N/A' };
    switch (mutation) {
      case 'rename_field':
        return { id: c.id, full_name: c.name, email: c.email, city: c.city, score: c.score };
      case 'type_change':
        return { id: c.id, name: c.name, email: c.email, city: c.city, score: String(c.score) };
      case 'out_of_schema':
        return { foo: `bar_${c.id}`, unexpected: true };
      default:
        return { id: c.id, name: c.name, email: c.email, city: c.city, score: c.score };
    }
  };

  const list = (req: FxRequest): FxResponse => {
    const source = mutation === 'empty' ? [] : mutation === 'trailing_bad_item' ? [...contacts, trailing] : contacts;
    const total = source.length;
    if (mutation === 'change_pagination') {
      const offset = intParam(req, 'offset', 0, 0, 10_000);
      const limit = intParam(req, 'limit', 20, 1, 100);
      return json(200, { items: source.slice(offset, offset + limit).map(shape), offset, limit, total });
    }
    const perPage = intParam(req, 'per_page', 20, 1, 100);
    const pageNo = intParam(req, 'page', 1, 1, 10_000);
    const items = slicePage(source, pageNo, perPage).map(shape);
    const hasMore = pageNo * perPage < total;
    const meta = { page: pageNo, per_page: perPage, total, has_more: hasMore, next_page: hasMore ? pageNo + 1 : null };
    if (mutation === 'wrap_in_envelope') return json(200, { ok: true, data: { results: items, meta } });
    return json(200, { items, ...meta });
  };

  return {
    id: 'api_json',
    lot: 'base',
    description: 'API JSON paginée de 500 contacts factices, avec les 6 mutations du banc de réparation',
    hosts: ['zz_test_api_json.localhost'],
    smoke: { path: '/api/contacts', status: 200 },
    handle(req) {
      const listPath = mutation === 'move_endpoint' ? '/api/v2/contacts' : '/api/contacts';
      if (req.path === '/') {
        return html(
          200,
          page(
            'Contacts zz_test',
            '<h1>Contacts</h1><ul id="contacts"></ul><script>fetch("/api/contacts?page=1&per_page=20").then(r=>r.json()).then(d=>{const ul=document.getElementById("contacts");for(const c of d.items){const li=document.createElement("li");li.textContent=c.name+" <"+c.email+">";ul.appendChild(li)}})</script>',
          ),
        );
      }
      if (req.path === listPath) return list(req);
      return notFound();
    },
    control(args) {
      const next = args['mutation'];
      if (typeof next !== 'string' || !(MUTATIONS as readonly string[]).includes(next)) {
        throw new ControlError(`mutation attendue parmi : ${MUTATIONS.join(', ')}`);
      }
      mutation = next as Mutation;
      return { mutation };
    },
  };
};

// ---------------------------------------------------------------- 2. SSR
const ssr: SiteFactory = (env) => {
  const products = makeProducts(env.seed, 'ssr', 100);
  const perPage = 20;
  return {
    id: 'ssr',
    lot: 'base',
    description: 'Catalogue rendu côté serveur : 100 produits, 5 pages, liens rel=next ; /moved : page saine qui se déplace par meta refresh vers /',
    hosts: ['zz_test_ssr.localhost'],
    smoke: { path: '/', status: 200 },
    handle(req) {
      const detail = /^\/product\/(zz_test_product_\d{4})$/.exec(req.path);
      if (detail) {
        const p = products.find((x) => x.id === detail[1]);
        if (!p) return html(404, page('Introuvable', '<h1>Introuvable</h1>'));
        return html(200, page(p.title, `<h1 class="title">${esc(p.title)}</h1><p class="price">${formatEuro(p.price_cents)}</p>`));
      }
      // Page déplacée (site sain) : meta refresh vers l'accueil, comme une redirection de langue ou d'URL canonique.
      if (req.path === '/moved') {
        return html(200, page('Catalogue déplacé', '<h1>Catalogue déplacé</h1><p>Le catalogue a une nouvelle adresse.</p>', '<meta http-equiv="refresh" content="0; url=/">'));
      }
      if (req.path !== '/') return html(404, page('Introuvable', '<h1>Introuvable</h1>'));
      const pageNo = intParam(req, 'page', 1, 1, 1000);
      const cards = slicePage(products, pageNo, perPage)
        .map(
          (p) =>
            `<article class="product" data-id="${p.id}"><h2 class="title"><a href="/product/${p.id}">${esc(p.title)}</a></h2><span class="price">${formatEuro(p.price_cents)}</span><span class="stock">${p.in_stock ? 'en stock' : 'rupture'}</span></article>`,
        )
        .join('\n');
      const next = pageNo * perPage < products.length ? `<a rel="next" class="next" href="/?page=${pageNo + 1}">Suivant</a>` : '';
      return html(200, page(`Catalogue page ${pageNo}`, `<h1>Catalogue</h1>\n<main>${cards}</main>\n<nav class="pager">${next}</nav>`));
    },
  };
};

// ---------------------------------------------------------------- 3. SPA
const spa: SiteFactory = (env) => {
  const products = makeProducts(env.seed, 'spa', 30);
  // Mode « hostile » (commande, tâche 1.6) : la coquille surcharge TextDecoder pour gonfler toute lecture faite dans la page
  // (100 M caractères) ; un exécuteur qui borne le transfert dans la page ne la laisse jamais sortir vers le worker.
  let hostile = false;
  const hostileJs = 'TextDecoder.prototype.decode=function(){return "x".repeat(100000000)};';
  const appJs = `const root=document.getElementById("app");fetch("/api/items.json").then(r=>r.json()).then(d=>{root.innerHTML="";for(const it of d.items){const div=document.createElement("div");div.className="spa-item";div.textContent=it.title+" - "+(it.price_cents/100).toFixed(2)+" EUR";root.appendChild(div)}});`;
  return {
    id: 'spa',
    lot: 'base',
    description: 'Application monopage : coquille HTML vide, données chargées par XHR (/api/items.json)',
    hosts: ['zz_test_spa.localhost'],
    smoke: { path: '/', status: 200 },
    handle(req) {
      if (req.path === '/api/items.json') return json(200, { items: products, total: products.length });
      if (req.path === '/app.js') return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: appJs };
      // Page à ressources tierces (tâche 1.6) : image et balise de mesure d'audience vers un hôte hors du site
      // (zz_test_evil, qui compte toute requête reçue), dont une sur minuterie et une au défilement, et une image du site
      // qui redirige vers le tiers (saut vu par le seul proxy d'egress), comme un site réel. `?status=451|503` : même
      // page servie avec ce statut (géo-restriction, indisponibilité), sous-ressources comprises.
      if (req.path === '/tiers/pixel') return redirect(302, env.urlFor('zz_test_evil.localhost', '/collect?t=redirect'));
      if (req.path === '/tiers') {
        const pageNo = intParam(req, 'page', 1, 1, 10);
        const status = req.query.get('status') === '451' ? 451 : req.query.get('status') === '503' ? 503 : 200;
        const tracker = env.urlFor('zz_test_evil.localhost', '/collect');
        const script = `setTimeout(()=>{navigator.sendBeacon("${tracker}?t=timer&p=${pageNo}","zz_test")},300);addEventListener("scroll",()=>{new Image().src="${tracker}?t=scroll"},{once:true});`;
        const rows = slicePage(products, pageNo, 10)
          .map((p) => `<div class="spa-item">${esc(p.title)} - ${(p.price_cents / 100).toFixed(2)} EUR</div>`)
          .join('');
        return html(status, page(`Tiers ${pageNo}`, `<img alt="" src="${tracker}?t=pixel&p=${pageNo}"><img alt="" src="/tiers/pixel?p=${pageNo}">${rows}<script>${script}</script>`));
      }
      if (req.path === '/' || req.path.startsWith('/items')) {
        const prelude = hostile ? `<script>${hostileJs}</script>` : '';
        return html(200, page('App zz_test', `${prelude}<div id="app">Chargement…</div><script src="/app.js"></script>`));
      }
      return notFound();
    },
    control(args) {
      if (args['mode'] !== 'hostile' && args['mode'] !== 'normal') throw new ControlError('mode attendu : hostile ou normal');
      hostile = args['mode'] === 'hostile';
      return { mode: hostile ? 'hostile' : 'normal' };
    },
  };
};

// ---------------------------------------------------------------- 9. DOM qui change sur commande
const domChange: SiteFactory = (env) => {
  const products = makeProducts(env.seed, 'dom', 25);
  let version = 1;
  return {
    id: 'dom',
    lot: 'base',
    description: 'Liste dont la structure du DOM change sur commande (version 1 puis 2), mêmes données',
    hosts: ['zz_test_dom.localhost'],
    smoke: { path: '/', status: 200 },
    handle(req) {
      if (req.path !== '/') return html(404, page('Introuvable', '<h1>Introuvable</h1>'));
      if (version === 1) {
        const rows = products
          .map((p) => `<li class="item"><span class="item-title">${esc(p.title)}</span> <span class="item-price">${formatEuro(p.price_cents)}</span></li>`)
          .join('\n');
        return html(200, page('Liste v1', `<ul class="items">\n${rows}\n</ul>`));
      }
      const cards = products
        .map((p) => `<div class="card"><h3 class="card__name">${esc(p.title)}</h3><p class="card__cost" data-cents="${p.price_cents}">${formatEuro(p.price_cents)}</p></div>`)
        .join('\n');
      return html(200, page('Liste v2', `<section class="grid">\n${cards}\n</section>`));
    },
    control(args) {
      if (args['version'] !== 1 && args['version'] !== 2) throw new ControlError('version attendue : 1 ou 2');
      version = args['version'];
      return { version };
    },
  };
};

// ---------------------------------------------------------------- 11. HTML irrégulier
const irregularHtml: SiteFactory = (env) => {
  const products = makeProducts(env.seed, 'irregular', 12);
  return {
    id: 'irregular',
    lot: 'base',
    description: 'HTML irrégulier mais lisible : balises non fermées, mauvais imbriquement, attributs sans guillemets, formats de prix mélangés ; seul <title> est fermé (sinon tout le document serait le texte du titre)',
    hosts: ['zz_test_irregular.localhost'],
    smoke: { path: '/', status: 200 },
    handle(req) {
      if (req.path !== '/') return html(404, '<p>introuvable');
      const blocks = products.map((p, i) => {
        const price = [formatEuro(p.price_cents), `EUR ${(p.price_cents / 100).toFixed(1)}`, `${Math.floor(p.price_cents / 100)} €`, 'N/C'][i % 4] as string;
        switch (i % 3) {
          case 0:
            return `<div class=row id=r${i}><b><i>${esc(p.title)}</b></i><p>Prix : <span class=p>${price}<br>Stock : ${p.in_stock ? 'oui' : 'non'}`;
          case 1:
            return `<table><tr><td>${esc(p.title)}<td>${price}<td>${p.in_stock ? 'oui' : 'non'}</table>`;
          default:
            return `<dl><dt>Nom<dd>${esc(p.title)}<dt>Tarif<dd>${price}&nbsp;<dt>Dispo<dd>${p.in_stock ? '&#x2713;' : '&times;'}</dl>`;
        }
      });
      return html(200, `<html><head><title>Liste irrégulière</title><body bgcolor=white>\n<h1>Articles &amp; prix</h1>\n${blocks.join('\n')}\n<div id=r0>doublon d'identifiant<ul><li>un<li>deux</ul>`);
    },
  };
};

// ---------------------------------------------------------------- Q1 : volume (volume_anomaly, pagination_short)
const VOLUME_MODES = ['normal', 'anomaly', 'empty', 'short'] as const;
type VolumeMode = (typeof VOLUME_MODES)[number];

const volume: SiteFactory = (env) => {
  const products = makeProducts(env.seed, 'volume', 100);
  let mode: VolumeMode = 'normal';
  return {
    id: 'volume',
    lot: 'q1',
    description: 'API dont le volume varie sur commande : normal (100 items), anomaly (40), empty (0), short (fin de liste jamais signalée)',
    hosts: ['zz_test_volume.localhost'],
    smoke: { path: '/api/items', status: 200 },
    handle(req) {
      if (req.path !== '/api/items') return notFound();
      const pageNo = intParam(req, 'page', 1, 1, 1000);
      const perPage = 20;
      if (mode === 'empty') return json(200, { items: [], page: pageNo, total: 0, has_more: false });
      if (mode === 'short') {
        if (pageNo >= 3) return json(200, { items: [], page: pageNo, total: 100 });
        return json(200, { items: slicePage(products, pageNo, perPage), page: pageNo, total: 100, has_more: true });
      }
      const total = mode === 'anomaly' ? 40 : 100;
      const source = products.slice(0, total);
      return json(200, { items: slicePage(source, pageNo, perPage), page: pageNo, total, has_more: pageNo * perPage < total });
    },
    control(args) {
      const next = args['mode'];
      if (typeof next !== 'string' || !(VOLUME_MODES as readonly string[]).includes(next)) {
        throw new ControlError(`mode attendu parmi : ${VOLUME_MODES.join(', ')}`);
      }
      mode = next as VolumeMode;
      return { mode };
    },
  };
};

// ---------------------------------------------------------------- Q1 : données personnelles factices
const personal: SiteFactory = (env) => {
  const people = makePeople(env.seed, 'personal', 30);
  const perPage = 10;
  return {
    id: 'personal',
    lot: 'q1',
    description: 'Annuaire de 30 personnes 100 % factices (nom Zztest, e-mail .invalid, téléphone de fiction)',
    hosts: ['zz_test_personal.localhost'],
    smoke: { path: '/api/people', status: 200 },
    handle(req) {
      const pageNo = intParam(req, 'page', 1, 1, 1000);
      if (req.path === '/api/people') {
        return json(200, { items: slicePage(people, pageNo, perPage), page: pageNo, total: people.length, has_more: pageNo * perPage < people.length });
      }
      if (req.path === '/') {
        const rows = slicePage(people, pageNo, perPage)
          .map((p) => `<tr class="person"><td class="name">${esc(p.name)}</td><td class="email">${p.email}</td><td class="phone">${p.phone}</td><td class="address">${esc(p.address)}</td></tr>`)
          .join('\n');
        return html(200, page('Annuaire zz_test', `<h1>Annuaire (données factices)</h1><table>${rows}</table>`));
      }
      return notFound();
    },
  };
};

// ---------------------------------------------------------------- Q1 : défilement infini
const infiniteScroll: SiteFactory = (env) => {
  const products = makeProducts(env.seed, 'scroll', 60);
  const batch = 10;
  const card = (p: Product): string => `<div class="feed-item" data-id="${p.id}">${esc(p.title)}</div>`;
  const script = `const feed=document.getElementById("feed");let offset=${batch};let done=false;let busy=false;async function more(){if(done||busy)return;busy=true;const r=await fetch("/api/feed?offset="+offset+"&limit=${batch}");const d=await r.json();for(const it of d.items){const div=document.createElement("div");div.className="feed-item";div.dataset.id=it.id;div.textContent=it.title;feed.appendChild(div)}offset+=d.items.length;done=d.done;busy=false}new IntersectionObserver(e=>{if(e[0].isIntersecting)more()}).observe(document.getElementById("sentinel"));`;
  return {
    id: 'scroll',
    lot: 'q1',
    description: 'Flux à défilement infini : 10 éléments dans le HTML, 50 autres chargés au défilement (/api/feed)',
    hosts: ['zz_test_scroll.localhost'],
    smoke: { path: '/', status: 200 },
    handle(req) {
      if (req.path === '/api/feed') {
        const offset = intParam(req, 'offset', 0, 0, 10_000);
        const limit = intParam(req, 'limit', batch, 1, 50);
        const items = products.slice(offset, offset + limit);
        return json(200, { items, offset, done: offset + items.length >= products.length });
      }
      if (req.path === '/') {
        return html(200, page('Flux zz_test', `<style>.feed-item{height:600px}</style><h1>Flux</h1><div id="feed">${products.slice(0, batch).map(card).join('')}</div><div id="sentinel" style="height:1px"></div><script>${script}</script>`));
      }
      return notFound();
    },
  };
};

// ---------------------------------------------------------------- S5 : blobs embarqués (aucune API XHR)
function embeddedSite(
  id: string,
  description: string,
  render: (products: Product[], req: FxRequest) => string | undefined,
): SiteFactory {
  return (env) => {
    const products = makeProducts(env.seed, id, 10);
    return {
      id,
      lot: 's5',
      description,
      hosts: [`zz_test_${id}.localhost`],
      smoke: { path: '/', status: 200 },
      handle(req) {
        const body = render(products, req);
        return body === undefined ? notFound() : html(200, body);
      },
    };
  };
}

const safeJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');
const shell = (extra: string): string => `<div id="root"></div>${extra}`;

const embeddedNext = embeddedSite('next', 'Blob __NEXT_DATA__ (style Next.js), sans API XHR', (products, req) =>
  req.path === '/'
    ? page(
        'Next zz_test',
        shell(
          `<script id="__NEXT_DATA__" type="application/json">${safeJson({ props: { pageProps: { products } }, page: '/', query: {}, buildId: 'zz_test_build', isFallback: false })}</script>`,
        ),
      )
    : undefined,
);

/** Encodage à plat inspiré de devalue (Nuxt 3) : chaque valeur a un indice, les objets pointent vers des indices. */
function flatten(root: unknown): unknown[] {
  const out: unknown[] = [];
  const add = (value: unknown): number => {
    const index = out.length;
    out.push(null);
    if (Array.isArray(value)) out[index] = value.map(add);
    else if (value !== null && typeof value === 'object') {
      out[index] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, add(v)]));
    } else out[index] = value;
    return index;
  };
  add(root);
  return out;
}

const embeddedNuxt = embeddedSite('nuxt', 'Blobs Nuxt : __NUXT_DATA__ à plat (/) et window.__NUXT__ (/legacy)', (products, req) => {
  if (req.path === '/') {
    const blob = safeJson(flatten({ data: { products }, state: {} }));
    return page('Nuxt zz_test', shell(`<script type="application/json" data-nuxt-data="nuxt-app" id="__NUXT_DATA__">${blob}</script>`));
  }
  if (req.path === '/legacy') {
    return page('Nuxt legacy zz_test', shell(`<script>window.__NUXT__=${safeJson({ data: [{ products }], state: {}, serverRendered: true })}</script>`));
  }
  return undefined;
});

const embeddedApollo = embeddedSite('apollo', 'État Apollo normalisé (window.__APOLLO_STATE__), références __ref', (products, req) => {
  if (req.path !== '/') return undefined;
  const state: Record<string, unknown> = {
    ROOT_QUERY: { '__typename': 'Query', 'products({"first":10})': products.map((p) => ({ __ref: `Product:${p.id}` })) },
  };
  for (const p of products) state[`Product:${p.id}`] = { __typename: 'Product', id: p.id, name: p.title, priceCents: p.price_cents };
  return page('Apollo zz_test', shell(`<script>window.__APOLLO_STATE__=${safeJson(state)};</script>`));
});

const embeddedJsonLd = embeddedSite('jsonld', 'Deux blocs JSON-LD (ItemList de Product + BreadcrumbList)', (products, req) => {
  if (req.path !== '/') return undefined;
  const list = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: products.map((p, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: { '@type': 'Product', name: p.title, sku: p.id, offers: { '@type': 'Offer', price: (p.price_cents / 100).toFixed(2), priceCurrency: 'EUR' } },
    })),
  };
  const crumbs = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Accueil' }],
  };
  return page(
    'JSON-LD zz_test',
    `<h1>Catalogue</h1><script type="application/ld+json">${safeJson(list)}</script><script type="application/ld+json">${safeJson(crumbs)}</script>`,
  );
});

// ---------------------------------------------------------------- S5 : pagination par curseur
const cursor: SiteFactory = (env) => {
  const products = makeProducts(env.seed, 'cursor', 95);
  const encode = (offset: number): string => Buffer.from(`zz_test_cursor:${offset}`).toString('base64url');
  const decode = (value: string): number | undefined => {
    const match = /^zz_test_cursor:(\d+)$/.exec(Buffer.from(value, 'base64url').toString());
    return match ? Number(match[1]) : undefined;
  };
  return {
    id: 'cursor',
    lot: 's5',
    description: 'Pagination par curseur opaque : 95 items, next_cursor null en fin de liste',
    hosts: ['zz_test_cursor.localhost'],
    smoke: { path: '/api/items', status: 200 },
    handle(req) {
      if (req.path !== '/api/items') return notFound();
      const limit = intParam(req, 'limit', 20, 1, 50);
      const raw = req.query.get('cursor');
      const offset = raw === null || raw === '' ? 0 : decode(raw);
      if (offset === undefined) return json(400, { error: 'invalid_cursor' });
      const items = products.slice(offset, offset + limit);
      const end = offset + items.length;
      return json(200, { data: items, next_cursor: end < products.length ? encode(end) : null });
    },
  };
};

// ---------------------------------------------------------------- S5 : pagination par en-tête Link (RFC 8288)
const linkHeader: SiteFactory = (env) => {
  const products = makeProducts(env.seed, 'linkheader', 57);
  return {
    id: 'linkheader',
    lot: 's5',
    description: 'Pagination par en-tête Link (first, prev, next, last) sur un tableau JSON nu, X-Total-Count',
    hosts: ['zz_test_linkheader.localhost'],
    smoke: { path: '/api/items', status: 200 },
    handle(req) {
      if (req.path !== '/api/items') return notFound();
      const perPage = intParam(req, 'per_page', 20, 1, 50);
      const last = Math.ceil(products.length / perPage);
      const pageNo = intParam(req, 'page', 1, 1, last + 1000);
      const url = (n: number): string => `<${env.urlFor(req.host, `/api/items?page=${n}&per_page=${perPage}`)}>`;
      const links = [`${url(1)}; rel="first"`, `${url(last)}; rel="last"`];
      if (pageNo > 1) links.push(`${url(pageNo - 1)}; rel="prev"`);
      if (pageNo < last) links.push(`${url(pageNo + 1)}; rel="next"`);
      return json(200, slicePage(products, pageNo, perPage), { link: links.join(', '), 'x-total-count': String(products.length) });
    },
  };
};

export const DATA_SITES: SiteFactory[] = [
  apiJson,
  ssr,
  spa,
  domChange,
  irregularHtml,
  volume,
  personal,
  infiniteScroll,
  embeddedNext,
  embeddedNuxt,
  embeddedApollo,
  embeddedJsonLd,
  cursor,
  linkHeader,
];

