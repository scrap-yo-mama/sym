// SPDX-License-Identifier: AGPL-3.0-only
// Critère 1.6 pour E1 (`fetch`) : sortie conforme sur les fixtures API, SSR et blob embarqué, par la vraie couche réseau
// (session N1, garde SSRF à chaque connexion) contre le vrai serveur de fixtures (0.5). Classes de refus sans extraction.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startClient, type Client } from '../../../../fixtures/src/test-helpers.ts';
import { contactsSpecInput, fixtureGuard, SCHEMA_CONTACT, SCHEMA_PRODUCT, ssrSpecInput } from '../../../../tests/helpers/fixture-net.ts';
import { validateDeclarativeSpec, type DeclarativeSpec } from '../dsl/spec.js';
import { openNetworkSession, type NetworkSession } from '../net/modes/session.js';
import { validateOutput } from '../schema/validator.js';
import { runFetchExecutor } from './index.js';

let client: Client;
let session: NetworkSession;
let base: (host: string) => string;
const HOSTS = [
  'zz_test_api_json.localhost',
  'zz_test_ssr.localhost',
  'zz_test_next.localhost',
  'zz_test_login.localhost',
  'zz_test_challenge.localhost',
  'zz_test_429.localhost',
  'zz_test_503.localhost',
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

function valid(raw: Record<string, unknown>, outputSchema: unknown): DeclarativeSpec {
  const check = validateDeclarativeSpec(raw, { outputSchema });
  if (!check.ok) throw new Error(JSON.stringify(check.errors));
  return check.spec;
}

const simple = (host: string, path: string, records = '$.items[*]'): Record<string, unknown> => ({
  schema_version: 1,
  kind: 'declarative',
  request: { method: 'GET', url: `${base(host)}${path}`, allowed_hosts: [host] },
  sources: [{ id: 'api', from: 'response', records }],
  fields: { name: { path: '$.name', type: 'string', required: true } },
});
const NAME_SCHEMA = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };

describe('assert_executors_conform_fixtures : E1 sur fixtures (session réseau N1 réelle)', () => {
  it('API JSON : 500 contacts en 10 pages, chacun conforme à output_schema', async () => {
    const host = 'zz_test_api_json.localhost';
    const out = await runFetchExecutor(session, { spec: valid(contactsSpecInput(base(host), host), SCHEMA_CONTACT), input: {}, outputSchema: SCHEMA_CONTACT, signal });
    expect(out).toMatchObject({ ok: true, pages: 10, requests: 10, stop: 'path_equals', truncated: false });
    if (!out.ok) return;
    expect(out.records).toHaveLength(500);
    for (const r of out.records) expect(validateOutput(SCHEMA_CONTACT, r)).toEqual({ ok: true });
    const stats = await client.stats();
    expect(stats.hosts[host]?.paths['/api/contacts']).toBe(10);
  });

  it('API JSON : max_pages de l’entrée respecté', async () => {
    const host = 'zz_test_api_json.localhost';
    const out = await runFetchExecutor(session, { spec: valid(contactsSpecInput(base(host), host, 20), SCHEMA_CONTACT), input: { max_pages: 2 }, outputSchema: SCHEMA_CONTACT, signal });
    expect(out).toMatchObject({ ok: true, pages: 2, stop: 'max_pages_input' });
    if (out.ok) expect(out.records).toHaveLength(40);
  });

  it('SSR : 100 produits sur 5 pages par liens rel=next lus dans le HTML', async () => {
    const host = 'zz_test_ssr.localhost';
    const out = await runFetchExecutor(session, { spec: valid(ssrSpecInput(base(host), host), SCHEMA_PRODUCT), input: {}, outputSchema: SCHEMA_PRODUCT, signal });
    expect(out).toMatchObject({ ok: true, pages: 5, stop: 'no_next' });
    if (!out.ok) return;
    expect(out.records).toHaveLength(100);
    expect(out.records[0]).toMatchObject({ sku: 'zz_test_product_0001' });
    for (const r of out.records) expect(validateOutput(SCHEMA_PRODUCT, r)).toEqual({ ok: true });
  });

  it('blob __NEXT_DATA__ (source `embedded`) : 10 produits conformes', async () => {
    const host = 'zz_test_next.localhost';
    const spec = valid(
      {
        schema_version: 1,
        kind: 'declarative',
        request: { method: 'GET', url: `${base(host)}/`, allowed_hosts: [host] },
        sources: [{ id: 'ssr', from: 'embedded', locator: { kind: 'next_data' }, records: '$.props.pageProps.products[*]' }],
        fields: { title: { path: '$.title', type: 'string', required: true }, price: { path: '$.price_cents', type: 'number', required: true }, sku: { path: '$.id', type: 'string' } },
      },
      SCHEMA_PRODUCT,
    );
    const out = await runFetchExecutor(session, { spec, input: {}, outputSchema: SCHEMA_PRODUCT, signal });
    expect(out).toMatchObject({ ok: true, pages: 1 });
    if (out.ok) expect(out.records).toHaveLength(10);
  });

  it('refus classés avant extraction : 401 → auth_required, 403 → forbidden, 429 → rate_limited, 503 → transient', async () => {
    const cases: [string, string, string, string][] = [
      ['zz_test_login.localhost', '/api/orders', 'auth_required', '$.items[*]'],
      ['zz_test_challenge.localhost', '/', 'forbidden', '$.items[*]'],
      ['zz_test_429.localhost', '/always', 'rate_limited', '$.items[*]'],
      ['zz_test_503.localhost', '/', 'transient', '$.items[*]'],
    ];
    for (const [host, path, cls, records] of cases) {
      const out = await runFetchExecutor(session, { spec: valid(simple(host, path, records), NAME_SCHEMA), input: {}, signal });
      expect(out, host).toMatchObject({ ok: false, requests: 1, failure: { failure_class: cls } });
    }
  });

  it('hôte non autorisé par la garde (adresse privée sans dérogation) → forbidden (ssrf_blocked), 0 requête reçue', async () => {
    const host = 'zz_test_dom.localhost';
    const out = await runFetchExecutor(session, { spec: valid(simple(host, '/'), NAME_SCHEMA), input: {}, signal });
    expect(out).toMatchObject({ ok: false, failure: { failure_class: 'forbidden', detail: 'ssrf_blocked' } });
    expect((await client.stats()).hosts[host]?.total ?? 0).toBe(0);
  });

  it('réponse au-delà de max_response_bytes → extraction (response_too_large), corps jamais chargé en entier', async () => {
    const host = 'zz_test_api_json.localhost';
    const raw = { ...contactsSpecInput(base(host), host, 100), limits: { max_response_bytes: 2_000 } };
    const out = await runFetchExecutor(session, { spec: valid(raw, SCHEMA_CONTACT), input: {}, signal });
    expect(out).toMatchObject({ ok: false, failure: { failure_class: 'extraction', detail: 'response_too_large' } });
  });
});
