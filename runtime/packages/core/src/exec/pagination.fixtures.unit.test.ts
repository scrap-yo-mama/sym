// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.2 (10-taches) : « `max_pages = 3` → exactement 3 pages. Règle d'arrêt vérifiée sur la dernière page. »
// Les cinq familles de pagination de 04b §2 (`page_param`, `offset`, `cursor`, `next_link`, `infinite_scroll`) sur le vrai
// serveur de fixtures (0.5), par la vraie couche réseau (E1) ; le défilement infini, qui exige un navigateur, est joué
// ici par un défilement scripté (la preuve Chromium est dans tests/browser/pagination.security.test.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startClient, type Client } from '../../../../fixtures/src/test-helpers.ts';
import { fixtureGuard, SCHEMA_CONTACT } from '../../../../tests/helpers/fixture-net.ts';
import { validateDeclarativeSpec, type DeclarativeSpec } from '../dsl/spec.js';
import { openNetworkSession, type NetworkSession } from '../net/modes/session.js';
import { runDeclarative, type DeclarativeRunResult } from './declarative.js';
import { runFetchExecutor } from './index.js';
import type { HttpExchange, Transport } from './types.js';

let client: Client;
let session: NetworkSession;
let base: (host: string) => string;
const CONTACTS = 'zz_test_api_json.localhost';
const CURSOR = 'zz_test_cursor.localhost';
const LINKS = 'zz_test_linkheader.localhost';
const SSR = 'zz_test_ssr.localhost';
const signal = new AbortController().signal;

beforeAll(async () => {
  client = await startClient();
  const port = client.server.port;
  base = (host) => `http://${host}:${port}`;
  session = openNetworkSession({ rung: { mode: 'direct' }, guard: fixtureGuard(port, [CONTACTS, CURSOR, LINKS, SSR]) });
});
afterAll(async () => {
  await session.close();
  await client.close();
});
beforeEach(async () => {
  await client.reset();
});

function valid(raw: Record<string, unknown>): DeclarativeSpec {
  const check = validateDeclarativeSpec(raw);
  if (!check.ok) throw new Error(JSON.stringify(check.errors));
  return check.spec;
}

const limits = { max_pages_input: 'input.max_pages', hard_max_pages: 50 };
const productFields = { title: { path: '$.title', type: 'string', required: true }, sku: { path: '$.id', type: 'string' } };
const contactFields = { id: { path: '$.id', type: 'string', required: true }, name: { path: '$.name', type: 'string', required: true } };

/** Les cinq familles, sur des fixtures dont on connaît la taille : [nom, spécification, enregistrements par page, total, arrêt naturel]. */
function families(): { name: string; spec: DeclarativeSpec; perPage: number; total: number; naturalStop: string; pages: number }[] {
  return [
    {
      name: 'page_param',
      spec: valid({
        schema_version: 1,
        kind: 'declarative',
        request: { method: 'GET', url: `${base(CONTACTS)}/api/contacts?per_page=20`, allowed_hosts: [CONTACTS], params: [{ at: 'url.query.page', role: 'pagination' }] },
        sources: [{ id: 'api', from: 'response', records: '$.items[*]' }],
        fields: contactFields,
        pagination: { type: 'page_param', param: 'url.query.page', start: 1, stop: [{ when: 'records_empty' }, { when: 'path_equals', path: '$.has_more', value: false }], limits },
      }),
      perPage: 20,
      total: 500,
      naturalStop: 'path_equals',
      pages: 25,
    },
    {
      name: 'cursor',
      spec: valid({
        schema_version: 1,
        kind: 'declarative',
        request: { method: 'GET', url: `${base(CURSOR)}/api/items?limit=20`, allowed_hosts: [CURSOR], params: [{ at: 'url.query.cursor', role: 'pagination' }] },
        sources: [{ id: 'api', from: 'response', records: '$.data[*]' }],
        fields: productFields,
        pagination: { type: 'cursor', param: 'url.query.cursor', next_path: '$.next_cursor', stop: [{ when: 'records_empty' }, { when: 'repeated_cursor' }], limits },
      }),
      perPage: 20,
      total: 95,
      naturalStop: 'no_next',
      pages: 5,
    },
    {
      name: 'next_link',
      spec: valid({
        schema_version: 1,
        kind: 'declarative',
        request: { method: 'GET', url: `${base(LINKS)}/api/items?per_page=20`, allowed_hosts: [LINKS] },
        sources: [{ id: 'api', from: 'response', records: '$[*]' }],
        fields: productFields,
        pagination: { type: 'next_link', stop: [{ when: 'records_empty' }, { when: 'repeated_cursor' }], limits },
      }),
      perPage: 20,
      total: 57,
      naturalStop: 'no_next',
      pages: 3,
    },
  ];
}

const items = (out: DeclarativeRunResult): number => (out.ok ? out.records.length : -1);

describe('pagination : max_pages = 3 → exactement 3 pages (E1, fixtures)', () => {
  it('assert_pagination_max_pages_exact — page_param, cursor et next_link : 3 requêtes, 3 pages, 3 × 20 enregistrements, arrêt max_pages_input', async () => {
    for (const f of families().filter((x) => x.pages > 3)) {
      const out = await runFetchExecutor(session, { spec: f.spec, input: { max_pages: 3 }, signal });
      expect(out, f.name).toMatchObject({ ok: true, pages: 3, requests: 3, stop: 'max_pages_input', truncated: false });
      expect(items(out), f.name).toBe(3 * f.perPage);
    }
  });

  it('assert_pagination_max_pages_exact — offset : 3 pages exactement, les pages sont contiguës (aucun trou, aucun doublon)', async () => {
    await client.control({ op: 'site', site: 'api_json', mutation: 'change_pagination' });
    const spec = valid({
      schema_version: 1,
      kind: 'declarative',
      request: { method: 'GET', url: `${base(CONTACTS)}/api/contacts?limit=20`, allowed_hosts: [CONTACTS], params: [{ at: 'url.query.offset', role: 'pagination' }] },
      sources: [{ id: 'api', from: 'response', records: '$.items[*]' }],
      fields: contactFields,
      pagination: { type: 'offset', param: 'url.query.offset', start: 0, step: 'items_received', stop: [{ when: 'records_empty' }], limits },
    });
    const out = await runFetchExecutor(session, { spec, input: { max_pages: 3 }, signal });
    expect(out).toMatchObject({ ok: true, pages: 3, requests: 3, stop: 'max_pages_input' });
    if (!out.ok) return;
    expect(out.records).toHaveLength(60);
    expect(new Set(out.records.map((r) => r['id'])).size).toBe(60);
    expect((await client.stats()).hosts[CONTACTS]?.paths['/api/contacts']).toBe(3);
  });

  it('max_pages = 1 : une seule page ; max_pages absent : la liste va à sa fin (plafond dur 50)', async () => {
    const [pageParam] = families();
    const one = await runFetchExecutor(session, { spec: pageParam!.spec, input: { max_pages: 1 }, signal });
    expect(one).toMatchObject({ ok: true, pages: 1, requests: 1, stop: 'max_pages_input' });
    const all = await runFetchExecutor(session, { spec: pageParam!.spec, input: {}, signal });
    expect(all).toMatchObject({ ok: true, pages: 25, stop: 'path_equals' });
  });

  it('un max_pages hors des bornes de l’entrée (0, -1, 2,5, « 3 ») n’ouvre pas la boucle : le plafond dur reste la seule borne', async () => {
    const [pageParam] = families();
    for (const bad of [0, -1, 2.5, '3']) {
      const out = await runFetchExecutor(session, { spec: valid({ ...(pageParam!.spec as unknown as Record<string, unknown>), pagination: { ...pageParam!.spec.pagination!, limits: { max_pages_input: 'input.max_pages', hard_max_pages: 4 } } }), input: { max_pages: bad }, signal });
      expect(out, String(bad)).toMatchObject({ ok: true, pages: 4, stop: 'hard_max_pages' });
    }
  });
});

describe('pagination : règle d’arrêt vérifiée sur la dernière page', () => {
  it('assert_pagination_stop_rule_last_page — chaque famille s’arrête SUR la dernière page, sans requête de trop, avec tous les enregistrements', async () => {
    for (const f of families()) {
      const out = await runFetchExecutor(session, { spec: f.spec, input: {}, signal });
      expect(out, f.name).toMatchObject({ ok: true, pages: f.pages, requests: f.pages, stop: f.naturalStop, truncated: false });
      expect(items(out), f.name).toBe(f.total);
    }
  });

  it('assert_pagination_stop_rule_last_page — la règle naturelle l’emporte quand la dernière page coïncide avec le plafond (max_pages = nombre de pages)', async () => {
    for (const f of families().filter((x) => x.pages <= 5)) {
      const out = await runFetchExecutor(session, { spec: f.spec, input: { max_pages: f.pages }, signal });
      expect(out, f.name).toMatchObject({ ok: true, pages: f.pages, stop: f.naturalStop });
    }
  });

  it('SSR : le lien rel=next lu dans le HTML manque sur la dernière page (5 pages, 100 produits)', async () => {
    const spec = valid({
      schema_version: 1,
      kind: 'declarative',
      request: { method: 'GET', url: `${base(SSR)}/`, allowed_hosts: [SSR] },
      sources: [{ id: 'dom', from: 'html', records: 'article.product' }],
      fields: { title: { css: 'h2.title a', attr: 'text', type: 'string', required: true } },
      pagination: { type: 'next_link', stop: [{ when: 'records_empty' }, { when: 'repeated_cursor' }], limits },
    });
    expect(await runFetchExecutor(session, { spec, input: { max_pages: 3 }, signal })).toMatchObject({ ok: true, pages: 3, stop: 'max_pages_input' });
    expect(await runFetchExecutor(session, { spec, input: {}, signal })).toMatchObject({ ok: true, pages: 5, requests: 5, stop: 'no_next' });
  });

  it('une règle d’arrêt qui ne se déclenche jamais n’empêche pas la fin : la page vide (règle implicite) clôt avant le plafond dur de 30 pages', async () => {
    const [pageParam] = families();
    const spec = valid({ ...(pageParam!.spec as unknown as Record<string, unknown>), pagination: { type: 'page_param', param: 'url.query.page', start: 1, stop: [{ when: 'path_equals', path: '$.nope', value: true }], limits: { hard_max_pages: 30 } } });
    const out = await runFetchExecutor(session, { spec, input: {}, signal });
    // 25 pages de 20 contacts, la page 26 est vide : `records_empty` (page sans enregistrement) clôt avant le plafond.
    expect(out).toMatchObject({ ok: true, pages: 26, stop: 'records_empty' });
  });
});

describe('infinite_scroll : défilement scripté', () => {
  /**
   * Page de 60 éléments dont 10 sont dans le HTML initial et 10 de plus s'ajoutent à chaque défilement (DOM cumulatif,
   * comme un vrai flux). Le transport rend la page chargée ; `scroll` rend le DOM après un défilement.
   */
  function feed(total = 60, batch = 10) {
    let shown = batch;
    let scrolls = 0;
    const html = () => `<html><body><div id="feed">${Array.from({ length: shown }, (_, i) => `<div class="feed-item">item-${String(i + 1).padStart(3, '0')}</div>`).join('')}</div></body></html>`;
    const exchange = (): HttpExchange => ({ status: 200, headers: { 'content-type': 'text/html' }, body: html(), url: 'http://zz_test_scroll.localhost/' });
    const transport: Transport = async () => exchange();
    const scroll = async (): Promise<HttpExchange> => {
      scrolls += 1;
      shown = Math.min(total, shown + batch);
      return exchange();
    };
    return { transport, scroll, scrolls: () => scrolls };
  }
  const feedSpec = (hard = 50) =>
    valid({
      schema_version: 1,
      kind: 'declarative',
      request: { method: 'GET', url: 'http://zz_test_scroll.localhost/', allowed_hosts: ['zz_test_scroll.localhost'] },
      sources: [{ id: 'dom', from: 'html', records: 'div.feed-item' }],
      fields: { text: { attr: 'text', type: 'string', required: true } },
      pagination: { type: 'infinite_scroll', stop: [{ when: 'records_empty' }], limits: { max_pages_input: 'input.max_pages', hard_max_pages: hard } },
    });

  it('assert_infinite_scroll_paginated — max_pages = 3 : le chargement initial puis 2 défilements = exactement 3 pages, 30 éléments distincts, dans l’ordre', async () => {
    const f = feed();
    const out = await runDeclarative({ spec: feedSpec(), input: { max_pages: 3 }, transport: f.transport, scroll: f.scroll, signal });
    expect(out).toMatchObject({ ok: true, pages: 3, requests: 3, stop: 'max_pages_input', truncated: false });
    expect(f.scrolls()).toBe(2);
    if (!out.ok) return;
    expect(out.records.map((r) => r['text'])).toEqual(Array.from({ length: 30 }, (_, i) => `item-${String(i + 1).padStart(3, '0')}`));
  });

  it('assert_infinite_scroll_paginated — règle d’arrêt sur le dernier défilement : un défilement sans nouvel élément clôt (records_empty), rien n’est livré deux fois', async () => {
    const f = feed(60);
    const out = await runDeclarative({ spec: feedSpec(), input: {}, transport: f.transport, scroll: f.scroll, signal });
    // 1 chargement + 5 défilements qui ajoutent 10 éléments + 1 défilement qui n'en ajoute aucun.
    expect(out).toMatchObject({ ok: true, pages: 7, requests: 7, stop: 'records_empty' });
    if (!out.ok) return;
    expect(out.records).toHaveLength(60);
    expect(new Set(out.records.map((r) => r['text'])).size).toBe(60);
  });

  it('un flux dont les anciens éléments sortent du DOM (liste virtualisée) ne livre jamais deux fois le même élément', async () => {
    let n = 0;
    const exchange = (from: number): HttpExchange => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: `<html><body>${Array.from({ length: 10 }, (_, i) => `<div class="feed-item">item-${from + i}</div>`).join('')}</body></html>`,
      url: 'http://zz_test_scroll.localhost/',
    });
    const transport: Transport = async () => exchange(0);
    // Fenêtre glissante de 10 éléments qui avance de 5 : 5 nouveaux à chaque défilement, 5 déjà vus.
    const scroll = async (): Promise<HttpExchange> => exchange(5 * (n += 1));
    const out = await runDeclarative({ spec: feedSpec(), input: { max_pages: 4 }, transport, scroll, signal });
    expect(out).toMatchObject({ ok: true, pages: 4 });
    if (!out.ok) return;
    expect(out.records.map((r) => r['text'])).toEqual(Array.from({ length: 25 }, (_, i) => `item-${i}`));
  });

  it('sans capacité de défilement (E1 : pas de navigateur), la page 1 est livrée puis l’exécuteur s’arrête sur `unsupported`', async () => {
    const f = feed();
    const out = await runDeclarative({ spec: feedSpec(), input: {}, transport: f.transport, signal });
    expect(out).toMatchObject({ ok: true, pages: 1, requests: 1, stop: 'unsupported', truncated: true });
    if (out.ok) expect(out.records).toHaveLength(10);
  });

  it('le plafond dur borne le défilement (arrêt certain) même si le flux ne finit jamais', async () => {
    const f = feed(1_000_000);
    const out = await runDeclarative({ spec: feedSpec(6), input: {}, transport: f.transport, scroll: f.scroll, signal });
    expect(out).toMatchObject({ ok: true, pages: 6, stop: 'hard_max_pages' });
    expect(f.scrolls()).toBe(5);
  });

  it('la cadence (1.9) et le contrôle d’accès (1.11) s’appliquent à CHAQUE défilement comme à une requête', async () => {
    const f = feed();
    const seen: string[] = [];
    const acquired: string[] = [];
    const out = await runDeclarative({
      spec: feedSpec(),
      input: { max_pages: 3 },
      transport: f.transport,
      scroll: f.scroll,
      signal,
      access: async (url) => {
        seen.push(url);
        return { allowed: true, crawlDelayMs: null };
      },
      pacer: {
        acquire: async (url) => {
          acquired.push(url);
          return { granted: true };
        },
        report: async () => undefined,
      },
    });
    expect(out).toMatchObject({ ok: true, pages: 3, requests: 3 });
    expect(seen).toHaveLength(3);
    expect(acquired).toHaveLength(3);
  });

  it('un refus (défi servi après un défilement) n’est jamais extrait (INV6) : échec classé, aucun enregistrement du défi', async () => {
    const f = feed();
    const out = await runDeclarative({
      spec: feedSpec(),
      input: {},
      transport: f.transport,
      scroll: async () => ({ status: 403, headers: { 'cf-mitigated': 'challenge' }, body: '<html><body><div class="feed-item">défi</div></body></html>', url: 'http://zz_test_scroll.localhost/' }),
      signal,
    });
    expect(out).toMatchObject({ ok: false, failure: { failure_class: 'blocked_by_protection' }, pages: 1 });
  });
});

describe('contrat de schéma : SCHEMA_CONTACT reste le contrat des enregistrements paginés', () => {
  it('chaque enregistrement des 3 pages est conforme (INV1)', async () => {
    const spec = valid({
      schema_version: 1,
      kind: 'declarative',
      request: { method: 'GET', url: `${base(CONTACTS)}/api/contacts?per_page=20`, allowed_hosts: [CONTACTS], params: [{ at: 'url.query.page', role: 'pagination' }] },
      sources: [{ id: 'api', from: 'response', records: '$.items[*]' }],
      fields: {
        id: { path: '$.id', type: 'string', required: true },
        name: { path: '$.name', type: 'string', required: true },
        email: { path: '$.email', type: 'string', required: true },
        city: { path: '$.city', type: 'string' },
        score: { path: '$.score', type: 'number', required: true },
      },
      pagination: { type: 'page_param', param: 'url.query.page', start: 1, stop: [{ when: 'records_empty' }], limits },
    });
    const out = await runFetchExecutor(session, { spec, input: { max_pages: 3 }, outputSchema: SCHEMA_CONTACT, signal });
    expect(out).toMatchObject({ ok: true, pages: 3 });
    if (out.ok) expect(out.records).toHaveLength(60);
  });
});
