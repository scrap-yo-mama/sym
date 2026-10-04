// SPDX-License-Identifier: AGPL-3.0-only
// UX-09, UX-19, UX-34 (lot B, U1.5) : les prérequis d'une enquête lisibles par TOUTE clé (`GET /api/me/prerequisites`), le
// refus d'une adresse interne AVANT toute création (`url_not_allowed`, 400, aucune API créée) et l'enveloppe d'erreur commune
// sur REST et MCP (`message`, `action_label`, `what_to_do`, `retryable`, `scope_required`).
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { publishRobotEngine } from '@runtime/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { withClient } from '../../../tests/helpers/pg.js';
import { createKey, createUser, PUBLIC_URL, runSetup, signIn, startTestServer, type TestServer, type TestUser } from '../../../tests/helpers/server.js';

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type Item = { id: string; ok: boolean | null; blocking: boolean; code: string | null; message: string; action_label: string | null; console_path: string | null };
type Prerequisites = { ready: boolean; missing: number; items: Item[] };

const ENGINE = { version: '153.0.8010.12', platform: 'linux', productVersion: '1.0.0', identifyInstanceEnv: null } as const;

let srv: TestServer;
let base: string;
let owner: TestUser;
let ownerCookie: string;
let narrowKey: string;
let writeKey: string;
let otherKey: string;
let client: Client;

const count = async (table: 'apis' | 'runs') => Number((await withClient(srv.db.url, async (c) => (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n)));
const get = (key: string, locale?: string) =>
  srv.app.inject({ method: 'GET', url: '/api/me/prerequisites', headers: { authorization: `Bearer ${key}`, ...(locale === undefined ? {} : { 'accept-language': locale }) } });
const put = (url: string, payload: Record<string, unknown>) => srv.app.inject({ method: 'PUT', url, headers: { cookie: ownerCookie, origin: PUBLIC_URL }, payload });
const itemOf = (body: Prerequisites, id: string) => body.items.find((i) => i.id === id)!;

beforeAll(async () => {
  srv = await startTestServer('prereq', { MAX_WAIT_SECONDS: '3', MAX_CONCURRENT_RUNS: '1000', MAX_ACTIVE_RUNS_PER_USER: '1000', MAX_RUNS_PER_KEY_PER_MINUTE: '1000', MCP_ALLOWED_HOSTS: '127.0.0.1' });
  owner = await runSetup(srv);
  ownerCookie = await signIn(srv, owner);
  narrowKey = (await createKey(srv, ownerCookie, owner, ['datasets:read'])).key;
  writeKey = (await createKey(srv, ownerCookie, owner, ['apis:read', 'apis:run', 'apis:write', 'runs:read'])).key;
  const member = await createUser(srv, 'zz_test_prereq_member@example.test', 'member');
  otherKey = (await createKey(srv, await signIn(srv, member), member, ['datasets:read'])).key;
  base = await srv.app.listen({ port: 0, host: '127.0.0.1' });
  client = new Client({ name: 'zz-test-client', version: '1.0.0' }, {});
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: { token: async () => writeKey } }));
  const pool = new pg.Pool({ connectionString: srv.db.url });
  try {
    await publishRobotEngine(pool, { ...ENGINE, instanceContactEnv: null });
  } finally {
    await pool.end();
  }
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await srv?.close();
});

describe('UX-09 / UX-19 : GET /api/me/prerequisites, lisible par toute clé', () => {
  test('sans identifiant : 401 ; avec une clé sans aucun scope d’écriture : 200 et la liste', async () => {
    expect((await srv.app.inject({ method: 'GET', url: '/api/me/prerequisites' })).statusCode).toBe(401);
    const res = await get(narrowKey);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<Prerequisites>();
    expect(body.items.map((i) => i.id)).toEqual(['instance_contact', 'llm_model:investigate', 'llm_price:investigate', 'llm_key_readable', 'responsible_use']);
    expect(body.ready).toBe(false);
  });

  test('contact absent puis posé : l’élément passe à ok, avec le texte dans la langue demandée et l’action', async () => {
    const before = itemOf((await get(narrowKey, 'fr')).json<Prerequisites>(), 'instance_contact');
    expect(before).toMatchObject({ ok: false, blocking: true, code: 'instance_contact_missing', console_path: '/settings/robot' });
    expect(before.message).toContain('contact du robot');
    expect(before.action_label).toContain('Identité du robot');
    expect(itemOf((await get(narrowKey, 'en')).json<Prerequisites>(), 'instance_contact').message).toContain('robot contact');
    expect((await put('/api/settings/identity', { instance_contact: 'zz-test@example.test' })).statusCode).toBe(200);
    expect(itemOf((await get(narrowKey)).json<Prerequisites>(), 'instance_contact')).toMatchObject({ ok: true, code: null });
  });

  test('modèle absent, puis modèle sans prix, puis modèle chiffré : trois états distincts, jamais « prix manquant » pour un modèle absent', async () => {
    let body = (await get(narrowKey)).json<Prerequisites>();
    expect(itemOf(body, 'llm_model:investigate')).toMatchObject({ ok: false, code: 'llm_model_missing' });
    const provider = { id: 'zz-prereq', preset: 'custom', base_url: 'http://127.0.0.1:9/v1', api_key: 'zz_test_llm_key_prereq_0123456789' };
    expect((await put('/api/settings/llm', { providers: [{ ...provider, models: { 'zz-model': {} } }], roles: { investigate: { provider: 'zz-prereq', model: 'zz-model' } } })).statusCode).toBe(200);
    body = (await get(narrowKey)).json<Prerequisites>();
    expect(itemOf(body, 'llm_model:investigate')).toMatchObject({ ok: true, code: null });
    expect(itemOf(body, 'llm_price:investigate')).toMatchObject({ ok: false, code: 'llm_price_missing', console_path: '/settings/models' });
    expect(body.missing).toBeGreaterThanOrEqual(1);
    const { api_key: _key, ...keep } = provider;
    expect((await put('/api/settings/llm', { providers: [{ ...keep, models: { 'zz-model': { price: { in: 1, out: 5 } } } }], roles: { investigate: { provider: 'zz-prereq', model: 'zz-model' } } })).statusCode).toBe(200);
    body = (await get(narrowKey)).json<Prerequisites>();
    expect(itemOf(body, 'llm_price:investigate')).toMatchObject({ ok: true });
    expect(itemOf(body, 'llm_key_readable')).toMatchObject({ ok: true });
  });

  test('l’usage responsable est une information propre à la personne qui porte la clé, jamais bloquante', async () => {
    const mine = itemOf((await get(narrowKey)).json<Prerequisites>(), 'responsible_use');
    expect(mine).toMatchObject({ ok: false, blocking: false, code: 'responsible_use_ack_required' });
    expect((await srv.app.inject({ method: 'POST', url: '/api/me/responsible-use', headers: { cookie: ownerCookie, origin: PUBLIC_URL }, payload: { version: (await srv.app.inject({ method: 'GET', url: '/api/me/responsible-use', headers: { cookie: ownerCookie } })).json<{ version: string }>().version } })).statusCode).toBe(200);
    expect(itemOf((await get(narrowKey)).json<Prerequisites>(), 'responsible_use').ok).toBe(true);
    // Un autre compte ne voit pas la case du premier (assert_cross_user_denied) : son propre état.
    expect(itemOf((await get(otherKey)).json<Prerequisites>(), 'responsible_use').ok).toBe(false);
  });
});

describe('UX-34 : adresse interne refusée avant toute création', () => {
  test('REST : 400 url_not_allowed, aucune API ni run créés', async () => {
    const before = { apis: await count('apis'), runs: await count('runs') };
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://localhost/', 'http://10.0.0.5/', 'http://[::1]/']) {
      const res = await srv.app.inject({ method: 'POST', url: '/api/apis', headers: { authorization: `Bearer ${writeKey}`, 'accept-language': 'fr' }, payload: { description: 'zz_test interne', url } });
      expect(res.statusCode, url).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'url_not_allowed', message_locale: 'fr', action_label: 'Donne une adresse publique (https://…)', retryable: true } });
    }
    expect({ apis: await count('apis'), runs: await count('runs') }).toEqual(before);
  });

  test('MCP : create_api rend la même erreur (code, message, action_label, what_to_do en anglais, retryable) ; rien n’est créé', async () => {
    const before = await count('apis');
    const result = (await client.callTool({ name: 'create_api', arguments: { description: 'zz_test interne', url: 'http://169.254.169.254/', wait_seconds: 0 } })) as ToolResult;
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text!) as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'url_not_allowed', retryable: true, message_locale: 'en' });
    for (const field of ['message', 'action_label', 'what_to_do']) expect(String(body[field]), field).toMatch(/\S/);
    expect(String(body['what_to_do'])).toMatch(/public address/i);
    expect(await count('apis')).toBe(before);
  });
});

describe('UX-09 : insufficient_scope nomme le droit manquant', () => {
  test('REST : scope_required, action_label avec le droit, what_to_do en anglais', async () => {
    const res = await srv.app.inject({ method: 'POST', url: '/api/apis', headers: { authorization: `Bearer ${narrowKey}`, 'accept-language': 'fr' }, payload: { description: 'zz_test', url: 'https://zz-test.example/' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'insufficient_scope', scope_required: 'apis:write', message: 'Ta clé n\'a pas le droit apis:write.', action_label: 'Crée une clé avec le droit apis:write dans Réglages > Clés d\'API', retryable: false } });
  });
});
