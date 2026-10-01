// SPDX-License-Identifier: AGPL-3.0-only
// Critère 1.7 : chaque fixture d'échec (0.5) donne la bonne classe, par la vraie couche réseau (session N1, garde SSRF)
// et l'interpréteur déclaratif, avec le classifieur PAR DÉFAUT. Un refus arrête l'essai à la première réponse
// (compteur de la fixture) et n'est jamais extrait : la stratégie du défi en 200 sait extraire la page de défi, la
// garde doit l'en empêcher. Aucune fixture servie en 200 n'est prise pour un défi (faux positifs), sauf `challenge_200`.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startClient, type Client } from '../../../../fixtures/src/test-helpers.ts';
import { contactsSpecInput, fixtureGuard, SCHEMA_CONTACT } from '../../../../tests/helpers/fixture-net.ts';
import { validateDeclarativeSpec, type DeclarativeSpec } from '../dsl/spec.js';
import { openNetworkSession, type NetworkSession } from '../net/modes/session.js';
import { classifyExchange, runFetchExecutor, type HttpExchange } from './index.js';

let client: Client;
let session: NetworkSession;
let base: (host: string) => string;
const HOSTS = [
  'zz_test_login.localhost',
  'zz_test_challenge.localhost',
  'zz_test_challenge_200.localhost',
  'zz_test_429.localhost',
  'zz_test_geo.localhost',
  'zz_test_signed403.localhost',
  'zz_test_503.localhost',
  'zz_test_payment_402.localhost',
  'zz_test_api_json.localhost',
  'zz_test_dom.localhost',
];
const signal = new AbortController().signal;

beforeAll(async () => {
  client = await startClient();
  const port = client.server.port;
  base = (host) => `http://${host}:${port}`;
  session = openNetworkSession({ rung: { mode: 'direct' }, guard: fixtureGuard(port, HOSTS) });
});
afterAll(async () => {
  await session.close();
  await client.close();
});
beforeEach(async () => {
  await client.reset();
});

function valid(raw: Record<string, unknown>, outputSchema?: unknown): DeclarativeSpec {
  const check = validateDeclarativeSpec(raw, outputSchema === undefined ? {} : { outputSchema });
  if (!check.ok) throw new Error(JSON.stringify(check.errors));
  return check.spec;
}

const jsonSpec = (host: string, path: string): Record<string, unknown> => ({
  schema_version: 1,
  kind: 'declarative',
  request: { method: 'GET', url: `${base(host)}${path}`, allowed_hosts: [host] },
  sources: [{ id: 'api', from: 'response', records: '$.items[*]' }],
  fields: { name: { path: '$.name', type: 'string', required: true } },
});
/** Stratégie HTML qui SAIT extraire la page de défi (titre `h1`) : sans la garde, elle « réussirait ». */
const headingSpec = (host: string, path = '/'): Record<string, unknown> => ({
  schema_version: 1,
  kind: 'declarative',
  request: { method: 'GET', url: `${base(host)}${path}`, allowed_hosts: [host] },
  sources: [{ id: 'dom', from: 'html', records: 'h1' }],
  fields: { name: { attr: 'text', type: 'string', required: true } },
});
const NAME_SCHEMA = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };

describe('assert_no_circumvention : chaque fixture d’échec donne la bonne classe (E1, classifieur par défaut)', () => {
  const cases: { name: string; host: string; spec: () => Record<string, unknown>; cls: string; detail?: string; path: string; before?: () => Promise<unknown> }[] = [
    { name: '401 JSON', host: 'zz_test_login.localhost', path: '/api/orders', spec: () => jsonSpec('zz_test_login.localhost', '/api/orders'), cls: 'auth_required', detail: 'http_401' },
    { name: 'redirection vers /login', host: 'zz_test_login.localhost', path: '/account', spec: () => headingSpec('zz_test_login.localhost', '/account'), cls: 'auth_required', detail: 'login_redirect' },
    { name: 'défi 403 + en-tête de protection', host: 'zz_test_challenge.localhost', path: '/', spec: () => headingSpec('zz_test_challenge.localhost'), cls: 'blocked_by_protection', detail: 'challenge_header' },
    { name: 'défi servi en 200 (corps seul)', host: 'zz_test_challenge_200.localhost', path: '/', spec: () => headingSpec('zz_test_challenge_200.localhost'), cls: 'blocked_by_protection', detail: 'challenge_page' },
    {
      name: 'défi servi en 200 avec en-tête',
      host: 'zz_test_challenge_200.localhost',
      path: '/',
      spec: () => headingSpec('zz_test_challenge_200.localhost'),
      cls: 'blocked_by_protection',
      detail: 'challenge_header',
      before: () => client.control({ op: 'site', site: 'challenge_200', with_header: true }),
    },
    { name: '403 signé (éditeur fictif)', host: 'zz_test_signed403.localhost', path: '/', spec: () => headingSpec('zz_test_signed403.localhost'), cls: 'blocked_by_protection', detail: 'protection_signature' },
    { name: '403 nu', host: 'zz_test_signed403.localhost', path: '/plain-forbidden', spec: () => headingSpec('zz_test_signed403.localhost', '/plain-forbidden'), cls: 'forbidden', detail: 'http_403' },
    { name: '429', host: 'zz_test_429.localhost', path: '/always', spec: () => jsonSpec('zz_test_429.localhost', '/always'), cls: 'rate_limited', detail: 'http_429' },
    { name: 'géo-restriction par redirection', host: 'zz_test_geo.localhost', path: '/', spec: () => jsonSpec('zz_test_geo.localhost', '/'), cls: 'network', detail: 'geo_redirect' },
    {
      name: 'géo-restriction 451',
      host: 'zz_test_geo.localhost',
      path: '/',
      spec: () => jsonSpec('zz_test_geo.localhost', '/'),
      cls: 'network',
      detail: 'geo_restriction',
      before: () => client.control({ op: 'site', site: 'geo', mode: '451' }),
    },
    { name: '402', host: 'zz_test_payment_402.localhost', path: '/', spec: () => jsonSpec('zz_test_payment_402.localhost', '/'), cls: 'payment_required', detail: 'http_402' },
    { name: '503 persistant', host: 'zz_test_503.localhost', path: '/', spec: () => jsonSpec('zz_test_503.localhost', '/'), cls: 'transient', detail: 'http_503' },
    { name: '404', host: 'zz_test_api_json.localhost', path: '/api/absent', spec: () => jsonSpec('zz_test_api_json.localhost', '/api/absent'), cls: 'not_found', detail: 'http_404' },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.cls}, arrêt à la première réponse, rien d’extrait`, async () => {
      await c.before?.();
      const out = await runFetchExecutor(session, { spec: valid(c.spec(), NAME_SCHEMA), input: {}, outputSchema: NAME_SCHEMA, signal });
      expect(out).toMatchObject({ ok: false, requests: 1, pages: 0, failure: { failure_class: c.cls, ...(c.detail === undefined ? {} : { detail: c.detail }) } });
      if (!out.ok && ['auth_required', 'forbidden', 'blocked_by_protection', 'rate_limited'].includes(c.cls)) expect(out.failure.failure_class).not.toBe('network');
      const stats = await client.stats();
      expect(stats.hosts[c.host]?.total, 'aucune requête après la détection').toBeLessThanOrEqual(c.path === '/account' || c.name.startsWith('géo-restriction par') ? 2 : 1);
    });
  }

  it('casse de structure (DOM v2) et volume vide → extraction (réparable), pas un refus', async () => {
    await client.control({ op: 'site', site: 'dom', version: 2 });
    const dom = valid({
      schema_version: 1,
      kind: 'declarative',
      request: { method: 'GET', url: `${base('zz_test_dom.localhost')}/`, allowed_hosts: ['zz_test_dom.localhost'] },
      sources: [{ id: 'dom', from: 'html', records: 'li.item' }],
      fields: { name: { css: '.item-title', attr: 'text', type: 'string', required: true } },
    });
    expect(await runFetchExecutor(session, { spec: dom, input: {}, outputSchema: NAME_SCHEMA, signal })).toMatchObject({ ok: false, failure: { failure_class: 'extraction' } });
    await client.control({ op: 'site', site: 'api_json', mutation: 'empty' });
    const host = 'zz_test_api_json.localhost';
    const out = await runFetchExecutor(session, { spec: valid(contactsSpecInput(base(host), host), SCHEMA_CONTACT), input: {}, outputSchema: SCHEMA_CONTACT, signal });
    expect(out).toMatchObject({ ok: false, failure: { failure_class: 'extraction' } });
  });
});

describe('pas de faux positif : aucune fixture servie en 200 n’est prise pour un refus', () => {
  it('requête de fumée de chaque site en 200 : classe nulle, sauf le défi servi en 200', async () => {
    const { sites } = (await client.json('127.0.0.1', '/__sites')) as { sites: { id: string; hosts: string[]; smoke: { path: string; status: number } }[] };
    expect(sites.length).toBeGreaterThan(25);
    let checked = 0;
    for (const site of sites) {
      if (site.smoke.status !== 200) continue;
      const host = site.hosts[0]!;
      const res = await client.get(host, site.smoke.path);
      const headers = Object.fromEntries(Object.entries(res.headers).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : [])));
      const exchange: HttpExchange = { status: res.status, headers, body: res.body, url: `${base(host)}${site.smoke.path}` };
      const out = classifyExchange(exchange, { requestUrl: exchange.url });
      if (site.id === 'challenge_200') expect(out?.failure_class, site.id).toBe('blocked_by_protection');
      else expect(out, site.id).toBeNull();
      checked += 1;
    }
    expect(checked).toBeGreaterThan(20);
  });
});
