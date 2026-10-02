// SPDX-License-Identifier: AGPL-3.0-only
// API REST (tâche 3.1, 05 § 4.2-4.4) sur un serveur réel et une base migrée : tests de contrat de chaque endpoint (chaque
// réponse validée contre l'OpenAPI SERVIE, `assert_rest_endpoints_contract`), codes d'erreur de 05 § 4.3
// (`assert_rest_error_codes`), export en flux (`assert_export_streaming`), CSV neutralisé (`assert_csv_formula_neutralized`),
// SSE multiplexé et reprise (`assert_sse_multiplexed_resume`), annulation, pause et reprise (`assert_run_cancel_pause_resume`),
// case « j'ai lu » (`assert_responsible_use_ack`), OpenAPI servie valide (`assert_openapi_served_valid`).
// Le worker est simulé en base (run terminé, dataset écrit) : ces tests portent sur le contrat HTTP, pas sur l'exécution.
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { sweepOrphans } from '@runtime/db';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { OpenApiContract } from '../../../tests/helpers/openapi-contract.js';
import { withClient } from '../../../tests/helpers/pg.js';
import { seedApi, seedRun } from '../../../tests/helpers/rest-seed.js';
import { createUser, PUBLIC_URL, runSetup, signIn, startTestServer, type TestServer, type TestUser } from '../../../tests/helpers/server.js';
import { SseParser, type SseEvent } from '../../web/src/lib/sse.js';
import { ROUTES } from './routes/registry.js';

type Party = { user: TestUser; cookie: string };

let srv: TestServer;
let base: string;
let contract: OpenApiContract;
let owner: Party;
let admin: Party;
let a: Party;
let b: Party;
let hook: Server;
let hookPort: number;
const hookCalls: { headers: Record<string, unknown>; body: string }[] = [];

/** Requête REST : en-têtes de session (et Origin pour une mutation), corps JSON ; renvoie la réponse et la vérifie au contrat. */
async function api(party: Party | null, method: string, url: string, template: string, payload?: unknown, extra: Record<string, string> = {}) {
  const res = await srv.app.inject({
    method: method as 'GET',
    url,
    headers: { ...(party ? { cookie: party.cookie } : {}), ...(method === 'GET' ? {} : { origin: PUBLIC_URL }), ...extra },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  const json = (res.headers['content-type'] ?? '').startsWith('application/json') && res.body !== '' ? (res.json() as unknown) : undefined;
  expect(contract.check(method, template, res.statusCode, json), `${method} ${url} → ${res.statusCode} ${res.body.slice(0, 300)}`).toEqual([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- corps JSON lu librement par les assertions (déjà validé au contrat ci-dessus)
  return { status: res.statusCode, body: json as Record<string, any>, raw: res };
}

/** Worker simulé : le run réussit avec ces items (dataset écrit, seq 0..n-1). */
async function completeRun(runId: string, items: Record<string, unknown>[], degraded: string[] = []): Promise<string> {
  return withClient(srv.db.url, async (c) => {
    await c.query('SELECT ensure_dataset_items_partitions()');
    const run = (await c.query<{ api_id: string; owner_id: string }>('SELECT api_id, owner_id FROM runs WHERE id = $1', [runId])).rows[0]!;
    const ds = (await c.query<{ id: string }>('INSERT INTO datasets (api_id, run_id, owner_id, item_count) VALUES ($1, $2, $3, $4) RETURNING id', [run.api_id, runId, run.owner_id, items.length])).rows[0]!.id;
    await c.query(
      `INSERT INTO dataset_items (dataset_id, seq, run_id, owner_id, item, size_bytes)
       SELECT $1, s.ord - 1, $2, $3, s.item::jsonb, length(s.item) FROM unnest($4::text[]) WITH ORDINALITY AS s(item, ord)`,
      [ds, runId, run.owner_id, items.map((i) => JSON.stringify(i))],
    );
    await c.query(
      `UPDATE runs SET state = 'succeeded', outcome = $3, degraded_reasons = $4, items = $5, dataset_id = $2, started_at = coalesce(started_at, now()), finished_at = now(), duration_ms = 10 WHERE id = $1`,
      [runId, ds, degraded.length > 0 ? 'degraded' : 'clean', degraded, items.length],
    );
    return ds;
  });
}

/** Dernier run d'une API, dès qu'il existe. */
async function latestRun(apiId: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const id = await withClient(srv.db.url, async (c) => (await c.query<{ id: string }>('SELECT id FROM runs WHERE api_id = $1 ORDER BY created_at DESC LIMIT 1', [apiId])).rows[0]?.id);
    if (id) return id;
    if (Date.now() > deadline) throw new Error('aucun run');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const count = async (sql: string, params: unknown[] = []) => withClient(srv.db.url, async (c) => Number(Object.values((await c.query<Record<string, string>>(sql, params)).rows[0]!)[0]));

/** Flux SSE lu par HTTP réel : trames analysées par le client de la console, commentaires comptés. */
async function openStream(path: string, party: Party, lastEventId?: string) {
  const controller = new AbortController();
  const res = await fetch(`${base}${path}`, { headers: { cookie: party.cookie, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) }, signal: controller.signal });
  const frames: SseEvent[] = [];
  let raw = '';
  let ended = false;
  const parser = new SseParser();
  const pump = (async () => {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        raw += text;
        frames.push(...parser.push(text));
      }
    } catch {
      // coupure volontaire
    }
    ended = true;
  })();
  const waitFor = async (predicate: () => boolean, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`attente du flux dépassée ; reçu : ${raw.slice(-500)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return {
    res,
    frames,
    raw: () => raw,
    ended: () => ended,
    waitFor,
    close: async () => {
      controller.abort();
      await pump;
    },
  };
}

beforeAll(async () => {
  hook = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      hookCalls.push({ headers: req.headers, body });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
  hookPort = (hook.address() as AddressInfo).port;
  // Cibles locales des tests (webhook) : drapeau réservé aux tests (NODE_ENV=test) et port de la cible seulement.
  srv = await startTestServer('rest', { RUNTIME_TEST_ALLOW_PRIVATE: '1', NODE_ENV: 'test', ALLOWED_EGRESS_PORTS: String(hookPort), MAX_CONCURRENT_RUNS: '1000' }, { rest: { pollMs: 40, pingMs: 300, maxStreamsPerUser: 3 } });
  const o = await runSetup(srv);
  const party = async (user: TestUser): Promise<Party> => ({ user, cookie: await signIn(srv, user) });
  owner = await party(o);
  admin = await party(await createUser(srv, 'zz_test_rest_admin@example.test', 'admin'));
  a = await party(await createUser(srv, 'zz_test_rest_a@example.test'));
  b = await party(await createUser(srv, 'zz_test_rest_b@example.test'));
  const address = await srv.app.listen({ port: 0, host: '127.0.0.1' });
  base = address;
  const doc = await srv.app.inject({ method: 'GET', url: '/api/openapi.json', headers: { cookie: a.cookie } });
  contract = new OpenApiContract(doc.json());
}, 180_000);

afterAll(async () => {
  await srv.close();
  await new Promise<void>((resolve) => hook.close(() => resolve()));
});

describe('assert_openapi_served_valid : /api/openapi.json', () => {
  test('OpenAPI 3.1 servie : opérations livrées seulement, sans x-pending, références résolues, identifiants uniques', async () => {
    const res = await api(a, 'GET', '/api/openapi.json', '/api/openapi.json');
    expect(res.status).toBe(200);
    const doc = res.body as { openapi: string; paths: Record<string, Record<string, { operationId?: string }>> };
    expect(doc.openapi).toBe('3.1.0');
    expect(res.raw.body).not.toContain('x-pending');
    const served = contract.operations();
    const registered = ROUTES.map((r) => `${r.method} ${r.url.replace(/:(\w+)/g, '{$1}')}`).sort();
    expect(served).toEqual(registered);
    const ids = Object.values(doc.paths).flatMap((item) => Object.values(item).map((op) => op.operationId)).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    expect(contract.compileAll()).toEqual([]);
    // Toute référence pointe vers un schéma, une réponse ou un paramètre défini.
    const refs = [...res.raw.body.matchAll(/"\$ref":"#\/components\/(\w+)\/(\w+)"/g)];
    expect(refs.length).toBeGreaterThan(100);
    const components = (res.body as { components: Record<string, Record<string, unknown>> }).components;
    expect(refs.filter((m) => !components[m[1]!]?.[m[2]!]).map((m) => m[0])).toEqual([]);
  });
});

describe('catalogue (05 § 4.2) : création, liste, fiche, modification, suppression', () => {
  test('POST /api/apis crée l’API et lance l’enquête dans la même transaction ; liste, fiche, filtre, pagination', async () => {
    const created = await api(a, 'POST', '/api/apis', '/api/apis', {
      description: 'Les livres du catalogue zz test, avec titre et prix',
      url: 'https://zz-test-books.example/catalogue',
      network_policy: { allow: ['direct'] },
      example_output: [{ title: 'x', price: 1 }],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ investigation_phase: 'access_check', proposed_output_schema: null, sample: [], access_report: null });
    expect(created.body['slug']).toMatch(/^les-livres-catalogue-test/);
    const runId = created.body['run_id'] as string;
    expect(await count("SELECT count(*) FROM runs WHERE id = $1 AND kind = 'investigation' AND state = 'queued' AND job_id IS NOT NULL", [runId])).toBe(1);
    // L'exemple de sortie va dans l'entrée du run, jamais dans l'état de l'API (17 § 6).
    expect(await count("SELECT count(*) FROM runs WHERE id = $1 AND input -> 'example_output' IS NOT NULL", [runId])).toBe(1);
    const second = await api(a, 'POST', '/api/apis', '/api/apis', { description: 'Les livres du catalogue zz test, avec titre et prix', url: 'https://zz-test-books.example/' });
    expect(second.body['slug']).not.toBe(created.body['slug']);

    const detail = await api(a, 'GET', `/api/apis/${created.body['slug']}`, '/api/apis/{slug}');
    expect(detail.body).toMatchObject({ status: 'enquete', metadata_only: false, access_policy: { robots: 'respect' }, owner_id: a.user.id });
    expect(JSON.stringify(detail.body)).not.toContain('"investigation"');

    const list = await api(a, 'GET', '/api/apis?limit=1', '/api/apis');
    expect(list.body['apis']).toHaveLength(1);
    const next = await api(a, 'GET', `/api/apis?limit=1&cursor=${list.body['next_cursor']}`, '/api/apis');
    expect(next.body['apis'][0].id).not.toBe(list.body['apis'][0].id);
    const filtered = await api(a, 'GET', '/api/apis?status=enquete&q=livres', '/api/apis');
    expect(filtered.body['apis'].length).toBeGreaterThanOrEqual(2);
    expect((await api(a, 'GET', '/api/apis?status=bloquee', '/api/apis')).body['apis']).toEqual([]);
    expect((await api(a, 'GET', '/api/apis?cursor=zz', '/api/apis')).status).toBe(400);
    // B ne voit pas les API privées de A ; une API `instance` sans session, si.
    expect((await api(b, 'GET', '/api/apis', '/api/apis')).body['apis'].map((x: { id: string }) => x.id)).not.toContain(created.body['api_id']);
    const shared = await seedApi(srv.db.url, a.user.id, { visibility: 'instance' });
    expect((await api(b, 'GET', '/api/apis', '/api/apis')).body['apis'].map((x: { id: string }) => x.id)).toContain(shared.id);
    expect((await api(b, 'GET', `/api/apis/${shared.slug}`, '/api/apis/{slug}')).status).toBe(200);
    // Mais B ne la modifie ni ne la supprime (404 uniforme).
    expect((await api(b, 'PATCH', `/api/apis/${shared.slug}`, '/api/apis/{slug}', { description: 'zz' })).status).toBe(404);
    expect((await api(b, 'DELETE', `/api/apis/${shared.slug}`, '/api/apis/{slug}')).status).toBe(404);
  });

  test('POST /api/apis refuse : URL à jeton, politique réseau inconnue, corps hors schéma (400) ; validation automatique sans « j’ai lu » (403)', async () => {
    expect((await api(a, 'POST', '/api/apis', '/api/apis', { description: 'zz', url: 'https://zz-test.example/?token=abc' })).body).toMatchObject({ error: { code: 'invalid_request' } });
    expect((await api(a, 'POST', '/api/apis', '/api/apis', { description: 'zz', url: 'https://zz-test.example/', network_policy: { allow: ['dc_proxy'], proxy_ids: { dc_proxy: 'zz-unknown' } } })).body).toMatchObject({ error: { code: 'invalid_network_policy' } });
    expect((await api(a, 'POST', '/api/apis', '/api/apis', { description: 'zz', url: 'https://zz-test.example/', robots: 'ignore' })).status).toBe(400);
    expect((await api(b, 'POST', '/api/apis', '/api/apis', { description: 'zz', url: 'https://zz-test.example/', auto_validate: true })).body).toMatchObject({ error: { code: 'responsible_use_ack_required' } });
  });

  test('PATCH : champs simples ; un schéma ne change que par brouillon (409 draft_required) ; une API à session reste privée', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    const patched = await api(a, 'PATCH', `/api/apis/${api1.slug}`, '/api/apis/{slug}', { description: 'zz_test modifiée', pinned: true, mcp_exposed: false, network_policy: { allow: ['direct', 'tunnel'] } });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ description: 'zz_test modifiée', pinned: true, mcp_exposed: false, network_policy: { allow: ['direct', 'tunnel'] } });
    expect((await api(a, 'PATCH', `/api/apis/${api1.slug}`, '/api/apis/{slug}', { output_schema: { type: 'object' } })).body).toMatchObject({ error: { code: 'draft_required' } });
    const session = await seedApi(srv.db.url, a.user.id, { requiresSession: true });
    expect((await api(a, 'PATCH', `/api/apis/${session.slug}`, '/api/apis/{slug}', { visibility: 'instance' })).body).toMatchObject({ error: { code: 'session_api_private' } });
  });

  test('DELETE : refusé tant qu’un run est actif (409), puis l’API, ses runs et ses datasets disparaissent', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    const done = await seedRun(srv.db.url, { apiId: api1.id, ownerId: a.user.id, items: [{ title: 'zz' }] });
    const active = await seedRun(srv.db.url, { apiId: api1.id, ownerId: a.user.id, state: 'running' });
    expect((await api(a, 'DELETE', `/api/apis/${api1.slug}`, '/api/apis/{slug}')).body).toMatchObject({ error: { code: 'runs_active' } });
    await withClient(srv.db.url, (c) => c.query("UPDATE runs SET state = 'cancelled', finished_at = now() WHERE id = $1", [active.runId]));
    expect((await api(a, 'DELETE', `/api/apis/${api1.slug}`, '/api/apis/{slug}')).status).toBe(204);
    expect((await api(a, 'GET', `/api/apis/${api1.slug}`, '/api/apis/{slug}')).status).toBe(404);
    expect(await count('SELECT count(*) FROM datasets WHERE id = $1', [done.datasetId])).toBe(0);
  });

  test('admin et owner : métadonnées seules d’une API à session d’autrui ; un membre reçoit 404', async () => {
    const session = await seedApi(srv.db.url, a.user.id, { requiresSession: true });
    for (const party of [admin, owner]) {
      const res = await api(party, 'GET', `/api/apis/${session.slug}`, '/api/apis/{slug}');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ metadata_only: true, description: '' });
      expect(res.body).not.toHaveProperty('output_schema');
      expect(res.body).not.toHaveProperty('input_schema');
    }
    expect((await api(b, 'GET', `/api/apis/${session.slug}`, '/api/apis/{slug}')).status).toBe(404);
  });
});

describe('assert_responsible_use_ack : 17 § 11, case « j’ai lu » et API à données personnelles', () => {
  test('sans la case, la validation d’un schéma `x-personal` est refusée ; cochée, elle passe', async () => {
    const created = await api(b, 'POST', '/api/apis', '/api/apis', { description: 'zz_test annuaire', url: 'https://zz-test-people.example/' });
    const apiId = created.body['api_id'] as string;
    const personal = { type: 'object', additionalProperties: false, properties: { name: { type: 'string', 'x-personal': true } } };
    // Worker simulé : schéma proposé, phase d'attente de validation, run d'enquête terminé.
    await withClient(srv.db.url, async (c) => {
      await c.query("UPDATE apis SET investigation_phase = 'awaiting_schema_validation', investigation = investigation || jsonb_build_object('proposed_schema', $2::jsonb) WHERE id = $1", [apiId, JSON.stringify(personal)]);
      await c.query("UPDATE runs SET state = 'succeeded', outcome = 'clean', finished_at = now() WHERE id = $1", [created.body['run_id']]);
    });
    expect((await api(b, 'GET', '/api/me/responsible-use', '/api/me/responsible-use')).body).toMatchObject({ required: true, acknowledged_at: null });
    expect((await api(b, 'POST', `/api/apis/${apiId}/validate-schema`, '/api/apis/{id}/validate-schema', {})).body).toMatchObject({ error: { code: 'responsible_use_ack_required' } });
    expect((await api(b, 'POST', '/api/me/responsible-use', '/api/me/responsible-use', { version: '1999-01-01' })).body).toMatchObject({ error: { code: 'responsible_use_version_mismatch' } });
    const ack = await api(b, 'POST', '/api/me/responsible-use', '/api/me/responsible-use', { version: '2026-10-01' });
    expect(ack.body).toMatchObject({ required: false });
    expect(await count('SELECT count(*) FROM responsible_use_acks WHERE user_id = $1', [b.user.id])).toBe(1);
    // Plan restreint : retirer tous les niveaux est refusé (400) ; en garder un passe.
    expect((await api(b, 'POST', `/api/apis/${apiId}/validate-schema`, '/api/apis/{id}/validate-schema', { exclude_executions: ['fetch', 'fetch_in_page', 'playwright', 'agent_fetch', 'hybrid', 'agent'] })).status).toBe(400);
    const validated = await api(b, 'POST', `/api/apis/${apiId}/validate-schema`, '/api/apis/{id}/validate-schema', { exclude_executions: ['agent'] });
    expect(validated.status).toBe(202);
    expect(validated.body).toMatchObject({ state: 'queued' });
    expect(await count("SELECT count(*) FROM apis WHERE id = $1 AND investigation_phase = 'testing' AND investigation -> 'excluded_executions' = '[\"agent\"]'::jsonb", [apiId])).toBe(1);
    expect((await api(b, 'POST', `/api/apis/${apiId}/validate-schema`, '/api/apis/{id}/validate-schema', {})).body).toMatchObject({ error: { code: 'not_awaiting_validation' } });
    // Clé d'API : la case est un acte humain, session seulement (403 sur une clé).
    const key = await srv.app.inject({ method: 'POST', url: '/api/api-keys', headers: { cookie: b.cookie, origin: PUBLIC_URL }, payload: { label: 'zz', scopes: ['apis:read'], currentPassword: b.user.password } });
    const res = await srv.app.inject({ method: 'GET', url: '/api/me/responsible-use', headers: { authorization: `Bearer ${key.json<{ key: string }>().key}` } });
    expect(res.statusCode).toBe(403);
  });
});

describe('assert_rest_error_codes : runs et codes de 05 § 4.3', () => {
  test('entrée hors input_schema → 400 invalid_input, AUCUN run créé', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    const before = await count('SELECT count(*) FROM runs WHERE api_id = $1', [api1.id]);
    const res = await api(a, 'POST', `/api/apis/${api1.slug}/runs`, '/api/apis/{slug}/runs', { input: { page: 'zz' } });
    expect(res.body).toMatchObject({ error: { code: 'invalid_input' } });
    expect(await count('SELECT count(*) FROM runs WHERE api_id = $1', [api1.id])).toBe(before);
  });

  test('API en erreur, action requise, bloquée, en enquête → 409 avec le code dédié ; aucun run', async () => {
    for (const [status, code] of [['erreur', 'api_error'], ['action_requise', 'action_required'], ['bloquee', 'blocked'], ['enquete', 'investigation_in_progress']] as const) {
      const api1 = await seedApi(srv.db.url, a.user.id, { status });
      const res = await api(a, 'POST', `/api/apis/${api1.slug}/runs`, '/api/apis/{slug}/runs', { input: {} });
      expect(res.status, status).toBe(409);
      expect(res.body['error'].code).toBe(code);
      expect(await count('SELECT count(*) FROM runs WHERE api_id = $1', [api1.id])).toBe(0);
    }
    // `bloquee` : le texte n'offre aucune alternative de contournement (05 § 4.3).
    const blocked = await seedApi(srv.db.url, a.user.id, { status: 'bloquee' });
    const text = JSON.stringify((await api(a, 'POST', `/api/apis/${blocked.slug}/runs`, '/api/apis/{slug}/runs', { input: {} })).body);
    expect(text).not.toMatch(/proxy|tunnel|contourn|bypass|stealth|captcha/i);
  });

  test('run plus long que wait → 202 et run à suivre ; terminé dans l’attente → 200 RunResult (20 items, curseur, suite sans doublon)', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    const accepted = await api(a, 'POST', `/api/apis/${api1.slug}/runs?wait=0`, '/api/apis/{slug}/runs', { input: { page: 1 } });
    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({ state: 'queued', poll_after_seconds: 5 });
    const items = Array.from({ length: 25 }, (_, i) => ({ title: `zz_test_${i}`, price: i }));
    const pending = api(a, 'POST', `/api/apis/${api1.slug}/runs?wait=10`, '/api/apis/{slug}/runs', { input: { page: 2 } });
    // Worker simulé : le run créé par l'appel en attente réussit.
    let runId = '';
    for (let i = 0; i < 200 && runId === ''; i++) {
      runId = (await withClient(srv.db.url, async (c) => (await c.query<{ id: string }>("SELECT id FROM runs WHERE api_id = $1 AND input ->> 'page' = '2'", [api1.id])).rows[0]?.id)) ?? '';
      if (runId === '') await new Promise((r) => setTimeout(r, 25));
    }
    const ds = await completeRun(runId, items);
    const done = await pending;
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ run_id: runId, state: 'succeeded', status: 'sain', total: 25, truncated: true, dataset_id: ds, poll_after_seconds: null });
    expect(done.body['items']).toHaveLength(20);
    expect(done.body['next_action']).toMatchObject({ tool: 'get_items' });
    const rest = await api(a, 'GET', `/api/datasets/${ds}/items?after=${done.body['next_cursor']}`, '/api/datasets/{id}/items');
    expect(rest.body['items'].map((x: { title: string }) => x.title)).toEqual(items.slice(20).map((x) => x.title));
    // GET /api/runs/{id} (= get_run) et liste.
    const run = await api(a, 'GET', `/api/runs/${runId}`, '/api/runs/{id}');
    expect(run.body).toMatchObject({ state: 'succeeded', api_slug: api1.slug, metadata_only: false, items: 25, input: { page: 2 } });
    const list = await api(a, 'GET', `/api/runs?api=${api1.slug}&state=succeeded&limit=1`, '/api/runs');
    expect(list.body['runs'][0].id).toBe(runId);
    expect((await api(a, 'GET', `/api/runs?api=${api1.slug}&limit=1`, '/api/runs')).body['next_cursor']).toEqual(expect.any(String));
    expect((await api(b, 'GET', '/api/runs', '/api/runs')).body['runs'].map((r: { id: string }) => r.id)).not.toContain(runId);
  });

  test('run dégradé → 200, status warning et raisons ; budget épuisé → 200 sur get_run (failed, budget_exceeded)', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id, { status: 'warning' });
    const pending = api(a, 'POST', `/api/apis/${api1.slug}/runs?wait=10`, '/api/apis/{slug}/runs', { input: {} });
    await completeRun(await latestRun(api1.id), [{ title: 'zz' }], ['optional_fields_missing']);
    const done = await pending;
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ state: 'succeeded', status: 'warning', degraded_reasons: ['optional_fields_missing'] });
    expect(done.body['message']).toMatch(/warnings/);
    const failed = await seedRun(srv.db.url, { apiId: api1.id, ownerId: a.user.id, state: 'failed', failureClass: 'budget_exceeded' });
    const run = await api(a, 'GET', `/api/runs/${failed.runId}`, '/api/runs/{id}');
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ state: 'failed', failure_class: 'budget_exceeded', retryable: false });
  });

  test('file pleine → 429 queue_full avec Retry-After ; aucun run créé', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    const limits = srv.started.ctx.rest;
    const saved = limits.maxConcurrentRuns;
    limits.maxConcurrentRuns = 1;
    try {
      await seedRun(srv.db.url, { apiId: api1.id, ownerId: a.user.id, state: 'queued' });
      const res = await api(a, 'POST', `/api/apis/${api1.slug}/runs`, '/api/apis/{slug}/runs', { input: {} });
      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ error: { code: 'queue_full' } });
      expect(res.raw.headers['retry-after']).toBe('30');
      expect(await count("SELECT count(*) FROM runs WHERE api_id = $1 AND trigger = 'ui'", [api1.id])).toBe(0);
    } finally {
      limits.maxConcurrentRuns = saved;
    }
  });

  test('accès croisé → 404 identique à une ressource inexistante (run, dataset, API)', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    const run = await seedRun(srv.db.url, { apiId: api1.id, ownerId: a.user.id, items: [{ title: 'zz_test_secret_item' }] });
    for (const [url, template] of [[`/api/runs/${run.runId}`, '/api/runs/{id}'], [`/api/datasets/${run.datasetId}/items`, '/api/datasets/{id}/items'], [`/api/apis/${api1.slug}`, '/api/apis/{slug}']] as const) {
      const res = await api(b, 'GET', url, template);
      expect(res.status, url).toBe(404);
      expect(res.raw.body).toBe('{"error":{"code":"not_found","message":"ressource introuvable"}}');
    }
  });

  test('journal du run : lignes croissantes, niveaux de la console, pagination par `after`', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    const run = await seedRun(srv.db.url, { apiId: api1.id, ownerId: a.user.id, items: [{ title: 'zz' }] });
    const page = await api(a, 'GET', `/api/runs/${run.runId}/logs?limit=1`, '/api/runs/{id}/logs');
    expect(page.body).toMatchObject({ lines: [{ seq: 0, level: 'info', code: 'zz_test_started', data: { n: 1 } }], next_after: 0 });
    expect((await api(a, 'GET', `/api/runs/${run.runId}/logs?after=0`, '/api/runs/{id}/logs')).body).toMatchObject({ lines: [{ seq: 1, level: 'debug', code: 'zz_test_detail' }], next_after: null });
    expect((await api(b, 'GET', `/api/runs/${run.runId}/logs`, '/api/runs/{id}/logs')).status).toBe(404);
  });
});

describe('assert_run_cancel_pause_resume : annulation, pause, reprise (05 § 4.4, 06 § 2)', () => {
  test('cancel : état cancelled tout de suite, coûts engagés gardés, job annulé ; deuxième annulation → 409', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    const accepted = await api(a, 'POST', `/api/apis/${api1.slug}/runs`, '/api/apis/{slug}/runs', { input: {} });
    const runId = accepted.body['run_id'] as string;
    await withClient(srv.db.url, (c) => c.query("UPDATE runs SET cost_proxy_usd = 0.0042, state = 'running' WHERE id = $1", [runId]));
    const started = Date.now();
    const res = await api(a, 'POST', `/api/runs/${runId}/cancel`, '/api/runs/{id}/cancel');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(res.body).toMatchObject({ run_id: runId, state: 'cancelled', cost: { proxy_usd: 0.0042 } });
    expect(await count("SELECT count(*) FROM pgboss.job j JOIN runs r ON r.job_id = j.id WHERE r.id = $1 AND j.state = 'cancelled'", [runId])).toBe(1);
    expect((await api(a, 'POST', `/api/runs/${runId}/cancel`, '/api/runs/{id}/cancel')).body).toMatchObject({ error: { code: 'run_not_active' } });
  });

  test('pause : run en file sans job, ignoré du balayeur ; resume : nouveau job ; essais gardés ; API qui écrit → 409', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    const accepted = await api(a, 'POST', `/api/apis/${api1.slug}/runs`, '/api/apis/{slug}/runs', { input: {} });
    const runId = accepted.body['run_id'] as string;
    const firstJob = await withClient(srv.db.url, async (c) => (await c.query<{ job_id: string }>('SELECT job_id FROM runs WHERE id = $1', [runId])).rows[0]!.job_id);
    await withClient(srv.db.url, (c) => c.query("UPDATE runs SET state = 'running' WHERE id = $1; ", [runId]));
    await withClient(srv.db.url, (c) => c.query("INSERT INTO run_attempts (run_id, seq, owner_id, execution, network, result_class, cost_usd) VALUES ($1, 0, $2, 'fetch', 'direct', 'network', 0.001)", [runId, a.user.id]));
    expect((await api(a, 'POST', `/api/runs/${runId}/resume`, '/api/runs/{id}/resume')).body).toMatchObject({ error: { code: 'run_not_paused' } });
    const paused = await api(a, 'POST', `/api/runs/${runId}/pause`, '/api/runs/{id}/pause');
    expect(paused.status).toBe(202);
    const detail = await api(a, 'GET', `/api/runs/${runId}`, '/api/runs/{id}');
    expect(detail.body).toMatchObject({ state: 'queued', paused_at: expect.any(String) });
    expect(detail.body['attempts']).toHaveLength(1);
    expect((await api(a, 'POST', `/api/runs/${runId}/pause`, '/api/runs/{id}/pause')).body).toMatchObject({ error: { code: 'run_paused' } });
    // Le balayeur ne reprend jamais un run en pause, même vieux.
    await withClient(srv.db.url, (c) => c.query("UPDATE runs SET heartbeat_at = now() - interval '1 hour' WHERE id = $1", [runId]));
    const swept = await sweepOrphans(srv.started.ctx.pool, await srv.started.ctx.jobs(), { staleSeconds: 1 });
    expect([...swept.requeued, ...swept.failed]).not.toContain(runId);
    expect(await count('SELECT count(*) FROM runs WHERE id = $1 AND job_id IS NULL AND paused_at IS NOT NULL', [runId])).toBe(1);
    const resumed = await api(a, 'POST', `/api/runs/${runId}/resume`, '/api/runs/{id}/resume');
    expect(resumed.status).toBe(202);
    const after = await withClient(srv.db.url, async (c) => (await c.query<{ job_id: string; paused_at: Date | null; state: string }>('SELECT job_id, paused_at, state FROM runs WHERE id = $1', [runId])).rows[0]!);
    expect(after).toMatchObject({ paused_at: null, state: 'queued' });
    expect(after.job_id).not.toBe(firstJob);
    expect(await count("SELECT count(*) FROM pgboss.job WHERE id = $1 AND state = 'created'", [after.job_id])).toBe(1);
    // B ne met pas en pause le run de A (404).
    expect((await api(b, 'POST', `/api/runs/${runId}/pause`, '/api/runs/{id}/pause')).status).toBe(404);
    const writer = await seedApi(srv.db.url, a.user.id, { allowWrite: true });
    const wrun = await api(a, 'POST', `/api/apis/${writer.slug}/runs`, '/api/apis/{slug}/runs', { input: {} });
    expect((await api(a, 'POST', `/api/runs/${wrun.body['run_id']}/pause`, '/api/runs/{id}/pause')).body).toMatchObject({ error: { code: 'pause_not_allowed' } });
  });
});

describe('ré-enquête, versions et chronologie (05 § 4.2, 06 § 2, INV3)', () => {
  test('investigate : 19/20 depuis sain, 18 depuis bloquee, 17 depuis action_requise ; 409 si une enquête tourne ; demande inconnue → 409', async () => {
    const created = await api(a, 'POST', '/api/apis', '/api/apis', { description: 'zz_test reenquete', url: 'https://zz-test-re.example/' });
    const apiId = created.body['api_id'] as string;
    const slug = created.body['slug'] as string;
    expect((await api(a, 'POST', `/api/apis/${slug}/investigate`, '/api/apis/{slug}/investigate', {})).body).toMatchObject({ error: { code: 'investigation_in_progress' } });
    for (const status of ['sain', 'bloquee', 'action_requise']) {
      await withClient(srv.db.url, async (c) => {
        await c.query("UPDATE runs SET state = 'succeeded', finished_at = now() WHERE api_id = $1 AND state = 'queued'", [apiId]);
        await c.query('UPDATE apis SET status = $2 WHERE id = $1', [apiId, status]);
      });
      const res = await api(a, 'POST', `/api/apis/${slug}/investigate`, '/api/apis/{slug}/investigate', { exclude_executions: ['agent'] });
      expect(res.status, status).toBe(202);
      expect(await count("SELECT count(*) FROM apis WHERE id = $1 AND status = 'enquete' AND investigation_phase = 'access_check'", [apiId])).toBe(1);
    }
    const reasons = await withClient(srv.db.url, async (c) => (await c.query<{ reason: string }>("SELECT reason FROM status_events WHERE api_id = $1 AND to_status = 'enquete' ORDER BY id", [apiId])).rows.map((r) => r.reason));
    expect(reasons).toEqual(['reinvestigate_manual', 'reinvestigate_manual', 'user_acted']);
    const bare = await seedApi(srv.db.url, a.user.id, { status: 'erreur' });
    expect((await api(a, 'POST', `/api/apis/${bare.slug}/investigate`, '/api/apis/{slug}/investigate')).body).toMatchObject({ error: { code: 'no_investigation_request' } });
    // force_investigate par un membre sur l'API `instance` d'autrui : 403.
    const shared = await seedApi(srv.db.url, a.user.id, { visibility: 'instance' });
    expect((await api(b, 'POST', `/api/apis/${shared.slug}/runs`, '/api/apis/{slug}/runs', { input: {}, force_investigate: true })).status).toBe(403);
  });

  test('versions : liste, détail, diff à trois niveaux, retour (warning, version_rollback) ; chronologie des statuts', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    await withClient(srv.db.url, async (c) => {
      await c.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, created_by, parent_version) VALUES ($1, 2, $2, 'playwright', 'direct', '{\"kind\": \"declarative\", \"zz\": 2}', 'repair', 1)", [api1.id, a.user.id]);
      await c.query('UPDATE apis SET current_strategy_version = 2 WHERE id = $1', [api1.id]);
    });
    const list = await api(a, 'GET', `/api/apis/${api1.slug}/versions?limit=1`, '/api/apis/{slug}/versions');
    expect(list.body).toMatchObject({ versions: [{ version: 2, created_by: 'repair', parent_version: 1 }] });
    expect((await api(a, 'GET', `/api/apis/${api1.slug}/versions?cursor=${list.body['next_cursor']}`, '/api/apis/{slug}/versions')).body['versions'][0].version).toBe(1);
    expect((await api(a, 'GET', `/api/apis/${api1.slug}/versions/1`, '/api/apis/{slug}/versions/{version}')).body).toMatchObject({ version: 1, spec: { kind: 'declarative', zz: 1 }, script_ref: null });
    expect((await api(a, 'GET', `/api/apis/${api1.slug}/versions/9`, '/api/apis/{slug}/versions/{version}')).status).toBe(404);
    const diff = await api(a, 'GET', `/api/apis/${api1.slug}/versions/2/diff?against=1`, '/api/apis/{slug}/versions/{version}/diff');
    expect(diff.body).toMatchObject({ from: 1, to: 2, summary: { code: 'strategy_changed' } });
    expect(diff.body['fields'].map((f: { path: string }) => f.path).sort()).toEqual(['execution', 'spec.zz']);
    const reverted = await api(a, 'POST', `/api/apis/${api1.slug}/versions/1/revert`, '/api/apis/{slug}/versions/{version}/revert');
    expect(reverted.body).toMatchObject({ status: 'warning', current_strategy_version: 3, current_strategy: { created_by: 'revert', execution: 'fetch', parent_version: 2 } });
    const events = await api(a, 'GET', `/api/apis/${api1.slug}/status-events`, '/api/apis/{slug}/status-events');
    expect(events.body['events'][0]).toMatchObject({ from_status: 'sain', to_status: 'warning', reason: { code: 'version_rollback' } });
    const failed = await seedApi(srv.db.url, a.user.id, { status: 'erreur' });
    expect((await api(a, 'POST', `/api/apis/${failed.slug}/versions/1/revert`, '/api/apis/{slug}/versions/{version}/revert')).body).toMatchObject({ error: { code: 'status_not_runnable' } });
  });
});

describe('assert_export_streaming : export des datasets en flux (05 § 4.4)', () => {
  test('100 000 items en NDJSON : mémoire bornée (lecture au rythme du client), reprise par `after` sans doublon', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    const run = await seedRun(srv.db.url, { apiId: api1.id, ownerId: a.user.id, items: [] });
    const ds = run.datasetId!;
    const total = 100_000;
    await withClient(srv.db.url, async (c) => {
      await c.query(
        `INSERT INTO dataset_items (dataset_id, seq, run_id, owner_id, item, size_bytes)
         SELECT $1, g - 1, $2, $3, jsonb_build_object('n', g, 'title', 'zz_test_' || g, 'pad', repeat('x', 400)), 450 FROM generate_series(1, $4::int) g`,
        [ds, run.runId, a.user.id, total],
      );
      await c.query('UPDATE datasets SET item_count = $2 WHERE id = $1', [ds, total]);
    });
    // Lots lus par le serveur : comptés à la source (requêtes sur dataset_items de ce dataset).
    const pool = srv.started.ctx.pool;
    const connect = pool.connect.bind(pool);
    let batches = 0;
    // Forme à rappel (pool.query l'utilise) transmise telle quelle ; seule la forme promesse (withActor) est instrumentée.
    (pool as { connect: unknown }).connect = async (...args: unknown[]) => {
      if (args.length > 0) return (connect as (...a: unknown[]) => unknown)(...args);
      const client = await connect();
      const marked = client as typeof client & { zzWrapped?: boolean };
      if (!marked.zzWrapped) {
        const query = client.query.bind(client) as (...args: unknown[]) => unknown;
        (client as { query: unknown }).query = (...args: unknown[]) => {
          if (typeof args[0] === 'string' && args[0].startsWith('SELECT seq, item FROM dataset_items WHERE dataset_id')) batches += 1;
          return query(...args);
        };
        marked.zzWrapped = true;
      }
      return client;
    };
    try {
      const res = await fetch(`${base}/api/datasets/${ds}/items?format=ndjson`, { headers: { cookie: a.cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/x-ndjson/);
      expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="dataset-/);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      // Client lent : le serveur ne lit pas le dataset d'avance (contre-pression), il attend que le client consomme.
      await new Promise((r) => setTimeout(r, 1500));
      const readAhead = batches;
      expect(readAhead).toBeLessThan(50);
      let text = new TextDecoder().decode(first.value);
      let lines = 0;
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        const cut = text.lastIndexOf('\n');
        if (cut >= 0) {
          lines += text.slice(0, cut).split('\n').length;
          text = text.slice(cut + 1);
        }
      }
      expect(lines).toBe(total);
      // Lots de 1 000 lus un à un, au fil de la lecture du client : la mémoire du serveur reste bornée par un lot et les
      // tampons du flux, quelle que soit la taille du dataset (~45 Mo ici).
      expect(batches).toBe(Math.ceil(total / 1000) + 1);
    } finally {
      (pool as { connect: unknown }).connect = connect;
    }
    // Reprise : page de 60 000 avec curseur de suite, puis le reste ; aucun doublon, rien de perdu.
    const page = await fetch(`${base}/api/datasets/${ds}/items?format=ndjson&limit=60000&fields=n`, { headers: { cookie: a.cookie } });
    const cursor = page.headers.get('x-next-cursor');
    expect(cursor).toEqual(expect.any(String));
    const firstPart = (await page.text()).trim().split('\n').map((l) => (JSON.parse(l) as { n: number }).n);
    const rest = await fetch(`${base}/api/datasets/${ds}/items?format=ndjson&fields=n&after=${cursor}`, { headers: { cookie: a.cookie } });
    expect(rest.headers.get('x-next-cursor')).toBeNull();
    const secondPart = (await rest.text()).trim().split('\n').map((l) => (JSON.parse(l) as { n: number }).n);
    expect(firstPart).toHaveLength(60_000);
    expect(secondPart).toHaveLength(40_000);
    const all = new Set([...firstPart, ...secondPart]);
    expect(all.size).toBe(total);
    expect(Math.min(...secondPart)).toBe(60_001);
    // JSON paginé : `next_cursor` dans le corps ; `fields` / `omit` projettent les champs.
    const json = await api(a, 'GET', `/api/datasets/${ds}/items?limit=2&omit=pad`, '/api/datasets/{id}/items');
    expect(json.body).toMatchObject({ items: [{ n: 1, title: 'zz_test_1' }, { n: 2, title: 'zz_test_2' }], next_cursor: expect.any(String) });
    expect(json.body['items'][0]).not.toHaveProperty('pad');
    expect((await api(a, 'GET', `/api/datasets/${ds}/items?after=zz`, '/api/datasets/{id}/items')).body).toMatchObject({ error: { code: 'invalid_cursor' } });
  }, 120_000);
});

describe('assert_csv_formula_neutralized : CSV à cellules neutralisées (08b § 2)', () => {
  test('cellules =, +, -, @, tabulation, retour chariot préfixées ; nombres intacts ; pièce jointe nosniff', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    const run = await seedRun(srv.db.url, {
      apiId: api1.id,
      ownerId: a.user.id,
      items: [
        { title: '=cmd|\'/C calc\'!A0', price: -5, note: '@x' },
        { title: '+1', price: 3.5, note: '\tTAB' },
        { title: '-2+3', note: '\rCR' },
        { title: 'ok, "quoted"', price: 0 },
      ],
    });
    const res = await srv.app.inject({ method: 'GET', url: `/api/datasets/${run.datasetId}/items?format=csv`, headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const lines = res.body.split('\r\n');
    // Colonnes dans l'ordre des propriétés du schéma tel que PostgreSQL le rend (jsonb : clés courtes d'abord, puis
    // ordre binaire) : déterministe d'un export à l'autre ; l'ordre de déclaration n'est pas conservé par jsonb.
    expect(lines[0]).toBe('note,price,title');
    expect(lines[1]).toBe("'@x,-5,'=cmd|'/C calc'!A0");
    expect(lines[2]).toBe("'\tTAB,3.5,'+1");
    expect(lines[3]).toBe('"\'\rCR",,\'-2+3');
    expect(lines[4]).toBe(',0,"ok, ""quoted"""');
    const fields = await srv.app.inject({ method: 'GET', url: `/api/datasets/${run.datasetId}/items?format=csv&fields=note,title`, headers: { cookie: a.cookie } });
    expect(fields.body.split('\r\n')[0]).toBe('note,title');
  });
});

describe('assert_sse_multiplexed_resume : flux SSE (06 § 3)', () => {
  test('/api/events : statuts, récit d’enquête et fins de run de l’utilisateur seulement ; ping ; reprise par Last-Event-ID sans rejeu', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    const streamA = await openStream('/api/events', a);
    const streamB = await openStream('/api/events', b);
    expect(streamA.res.headers.get('content-type')).toMatch(/text\/event-stream/);
    await streamA.waitFor(() => streamA.raw().includes(': ping'));
    await new Promise((r) => setTimeout(r, 150));
    await withClient(srv.db.url, (c) => c.query("INSERT INTO status_events (api_id, owner_id, from_status, to_status, reason) VALUES ($1, $2, 'sain', 'warning', 'zz_test_reason')", [api1.id, a.user.id]));
    const inv = await seedRun(srv.db.url, { apiId: api1.id, ownerId: a.user.id, state: 'running', kind: 'investigation' });
    await withClient(srv.db.url, async (c) => {
      await c.query("INSERT INTO investigation_events (run_id, seq, owner_id, kind, payload) VALUES ($1, 0, $2, 'access_report', '{\"run_id\": \"x\", \"verdict\": {\"proceed\": true}}'), ($1, 1, $2, 'phase.started', '{\"phase\": \"reconnaissance\"}')", [inv.runId, a.user.id]);
    });
    const finished = await seedRun(srv.db.url, { apiId: api1.id, ownerId: a.user.id, items: [{ title: 'zz' }] });
    await streamA.waitFor(() => streamA.frames.some((f) => f.event === 'run.finished' && f.data.includes(finished.runId)) && streamA.frames.some((f) => f.event === 'phase.started') && streamA.frames.some((f) => f.event === 'status.changed'));
    const status = streamA.frames.find((f) => f.event === 'status.changed')!;
    expect(JSON.parse(status.data)).toMatchObject({ api_id: api1.id, api_slug: api1.slug, status: 'warning', status_reason: { code: 'zz_test_reason' } });
    const phase = JSON.parse(streamA.frames.find((f) => f.event === 'phase.started')!.data);
    expect(phase).toMatchObject({ phase: 'reconnaissance', run_id: inv.runId, api_id: api1.id });
    expect(streamA.frames.every((f) => f.id !== null && f.id !== '')).toBe(true);
    // B ne reçoit rien de A (INV12).
    await new Promise((r) => setTimeout(r, 300));
    expect(streamB.frames.filter((f) => f.data.includes(api1.id))).toEqual([]);
    const lastId = streamA.frames.at(-1)!.id!;
    await streamA.close();
    await streamB.close();
    // Reprise : seuls les événements postérieurs au dernier identifiant reçu.
    await withClient(srv.db.url, (c) => c.query("INSERT INTO status_events (api_id, owner_id, from_status, to_status, reason) VALUES ($1, $2, 'warning', 'sain', 'zz_test_back')", [api1.id, a.user.id]));
    const resumed = await openStream('/api/events', a, lastId);
    await resumed.waitFor(() => resumed.frames.some((f) => f.data.includes('zz_test_back')));
    await new Promise((r) => setTimeout(r, 200));
    expect(resumed.frames.filter((f) => f.data.includes('zz_test_reason') || f.event === 'phase.started' || f.event === 'run.finished')).toEqual([]);
    await resumed.close();
  });

  test('/api/runs/{id}/events : récit rejoué depuis le début, reprise par seq, fin du flux quand le run est terminé ; 404 pour autrui', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    const inv = await seedRun(srv.db.url, { apiId: api1.id, ownerId: a.user.id, state: 'running', kind: 'investigation' });
    await withClient(srv.db.url, (c) =>
      c.query(
        "INSERT INTO investigation_events (run_id, seq, owner_id, kind, payload) VALUES ($1, 0, $2, 'access_report', '{\"verdict\": {\"proceed\": true}}'), ($1, 1, $2, 'investigation.started', '{}'), ($1, 2, $2, 'attempt.finished', '{\"attempt\": {\"index\": 0}}')",
        [inv.runId, a.user.id],
      ),
    );
    const s = await openStream(`/api/runs/${inv.runId}/events`, a);
    await s.waitFor(() => s.frames.length >= 3);
    expect(s.frames.map((f) => [f.id, f.event])).toEqual([
      ['0', 'access_report'],
      ['1', 'investigation.started'],
      ['2', 'attempt.finished'],
    ]);
    await withClient(srv.db.url, (c) => c.query("UPDATE runs SET state = 'succeeded', finished_at = now() WHERE id = $1", [inv.runId]));
    await s.waitFor(() => s.ended());
    expect(s.frames.at(-1)).toMatchObject({ id: 'end', event: 'run.finished' });
    await s.close();
    const resumed = await openStream(`/api/runs/${inv.runId}/events`, a, '1');
    await resumed.waitFor(() => resumed.ended());
    expect(resumed.frames.map((f) => f.id)).toEqual(['2', 'end']);
    await resumed.close();
    expect((await srv.app.inject({ method: 'GET', url: `/api/runs/${inv.runId}/events`, headers: { cookie: b.cookie } })).statusCode).toBe(404);
  });

  test('plafond de flux par utilisateur : 429 too_many_streams au-delà', async () => {
    await new Promise((r) => setTimeout(r, 500)); // fermetures précédentes vues par le serveur
    const streams = [await openStream('/api/events', b), await openStream('/api/events', b), await openStream('/api/events', b)];
    for (const s of streams) await s.waitFor(() => s.raw().includes(': connected'));
    const res = await fetch(`${base}/api/events`, { headers: { cookie: b.cookie } });
    expect(res.status).toBe(429);
    expect(contract.check('GET', '/api/events', 429, await res.json())).toEqual([]);
    for (const s of streams) await s.close();
  });
});

describe('planifications (08 § 5) : CRUD, miroir pg-boss, prochaines exécutions', () => {
  test('création, lecture, modification, suppression ; cron invalide → 400', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    const created = await api(a, 'POST', `/api/apis/${api1.slug}/schedules`, '/api/apis/{slug}/schedules', { cron: '0 3 * * *', timezone: 'Europe/Paris', input: { page: 1 }, rules: { dedup_key: 'title', diff: 'new' } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ api_slug: api1.slug, enabled: true, overlap: 'skip', missed: 'once' });
    expect(created.body['next_runs']).toHaveLength(5);
    const id = created.body['id'] as string;
    const queue = await srv.started.ctx.jobs();
    expect(await queue.scheduledKeys('scheduled-run')).toContain(id);
    expect((await api(a, 'POST', `/api/apis/${api1.slug}/schedules`, '/api/apis/{slug}/schedules', { cron: '* * * * * *', timezone: 'UTC', input: {} })).body).toMatchObject({ error: { code: 'invalid_schedule' } });
    expect((await api(a, 'GET', `/api/apis/${api1.slug}/schedules`, '/api/apis/{slug}/schedules')).body['schedules'].map((s: { id: string }) => s.id)).toEqual([id]);
    expect((await api(a, 'GET', `/api/apis/${api1.slug}/schedules/${id}`, '/api/apis/{slug}/schedules/{id}')).body).toMatchObject({ id, timezone: 'Europe/Paris' });
    const patched = await api(a, 'PATCH', `/api/apis/${api1.slug}/schedules/${id}`, '/api/apis/{slug}/schedules/{id}', { enabled: false });
    expect(patched.body).toMatchObject({ enabled: false, next_runs: [] });
    expect(await queue.scheduledKeys('scheduled-run')).not.toContain(id);
    expect((await api(b, 'GET', `/api/apis/${api1.slug}/schedules/${id}`, '/api/apis/{slug}/schedules/{id}')).status).toBe(404);
    expect((await api(a, 'DELETE', `/api/apis/${api1.slug}/schedules/${id}`, '/api/apis/{slug}/schedules/{id}')).status).toBe(204);
    expect((await api(a, 'GET', `/api/apis/${api1.slug}/schedules/${id}`, '/api/apis/{slug}/schedules/{id}')).status).toBe(404);
  });
});

describe('webhooks (Standard Webhooks, 08 § 5) : garde SSRF, secret rendu une fois, rotation, test signé', () => {
  test('création, test, rotation, désactivation, suppression ; URL interdite → 400 ssrf_blocked', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    const target = `http://127.0.0.1:${hookPort}/zz-test-hook`;
    expect((await api(a, 'POST', '/api/webhook-subscriptions', '/api/webhook-subscriptions', { url: 'http://169.254.169.254/latest', events: ['run.failed'] })).body).toMatchObject({ error: { code: 'ssrf_blocked' } });
    const created = await api(a, 'POST', '/api/webhook-subscriptions', '/api/webhook-subscriptions', { url: target, events: ['run.failed', 'api.status_changed'], api_slug: api1.slug });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ api_slug: api1.slug, status: 'active', secret: expect.stringMatching(/^whsec_/) });
    const id = created.body['id'] as string;
    // Le secret n'est jamais relu.
    const read = await api(a, 'GET', `/api/webhook-subscriptions/${id}`, '/api/webhook-subscriptions/{id}');
    expect(read.raw.body).not.toContain(created.body['secret']);
    const tested = await api(a, 'POST', `/api/webhook-subscriptions/${id}/test`, '/api/webhook-subscriptions/{id}/test');
    expect(tested.body).toMatchObject({ ok: true, error: null });
    expect(hookCalls.at(-1)!.headers['webhook-signature']).toEqual(expect.stringMatching(/^v1,/));
    expect((await api(a, 'GET', `/api/webhook-subscriptions/${id}`, '/api/webhook-subscriptions/{id}')).body['deliveries'][0]).toMatchObject({ event: 'webhook.test', status_code: 204 });
    const rotated = await api(a, 'PATCH', `/api/webhook-subscriptions/${id}`, '/api/webhook-subscriptions/{id}', { rotate_secret: true, status: 'disabled' });
    expect(rotated.body).toMatchObject({ status: 'disabled', secret: expect.stringMatching(/^whsec_/) });
    expect(rotated.body['secret']).not.toBe(created.body['secret']);
    expect((await api(a, 'GET', '/api/webhook-subscriptions', '/api/webhook-subscriptions')).body['subscriptions'].map((s: { id: string }) => s.id)).toContain(id);
    expect((await api(b, 'GET', '/api/webhook-subscriptions', '/api/webhook-subscriptions')).body['subscriptions']).toEqual([]);
    expect((await api(a, 'DELETE', `/api/webhook-subscriptions/${id}`, '/api/webhook-subscriptions/{id}')).status).toBe(204);
    expect(await count("SELECT count(*) FROM secrets WHERE owner_id = $1 AND kind = 'webhook_secret'", [a.user.id])).toBe(0);
  });
});

describe('réglages de l’admin (08 § 1, § 2, § 7) : secrets en écriture seule (INV8)', () => {
  test('modèles IA : clé chiffrée, jamais relue, conservée si absente ; sonde vers un fournisseur injoignable → échec lisible', async () => {
    const key = 'zz_test_llm_key_0123456789abcdef';
    const put = await api(admin, 'PUT', '/api/settings/llm', '/api/settings/llm', {
      providers: [{ id: 'zz-local', preset: 'custom', base_url: 'http://127.0.0.1:9/v1', api_key: key, models: { 'zz-model': {} } }],
      roles: { extract: { provider: 'zz-local', model: 'zz-model' } },
    });
    expect(put.status).toBe(200);
    expect(put.body['providers'][0]).toMatchObject({ id: 'zz-local', api_key_set: true, headers_set: false, api_key_unreadable: false });
    expect(put.raw.body).not.toContain(key);
    const stored = await withClient(srv.db.url, async (c) => (await c.query<{ value: unknown }>("SELECT value FROM settings WHERE key = 'llm'")).rows[0]!.value);
    expect(JSON.stringify(stored)).not.toContain(key);
    expect(await count("SELECT count(*) FROM secrets WHERE kind = 'llm_api_key' AND owner_id IS NULL AND position(convert_to($1, 'UTF8') in ciphertext) = 0", [key])).toBe(1);
    // Sans clé : la précédente reste (même secret).
    const again = await api(admin, 'PUT', '/api/settings/llm', '/api/settings/llm', { providers: [{ id: 'zz-local', preset: 'custom', base_url: 'http://127.0.0.1:9/v1' }] });
    expect(again.body['providers'][0]).toMatchObject({ api_key_set: true });
    expect((await api(admin, 'PUT', '/api/settings/llm', '/api/settings/llm', { providers: [{ id: 'zz-new', preset: 'custom', base_url: 'http://127.0.0.1:9/v1' }] })).body).toMatchObject({ error: { code: 'api_key_required' } });
    expect((await api(admin, 'GET', '/api/settings/llm', '/api/settings/llm')).raw.body).not.toContain(key);
    const probe = await api(admin, 'POST', '/api/settings/llm/test', '/api/settings/llm/test', { provider: 'zz-local', model: 'zz-model' });
    expect(probe.body).toMatchObject({ ok: false, profile: null, error: { code: expect.stringMatching(/^llm_/) } });
    expect((await api(admin, 'POST', '/api/settings/llm/test', '/api/settings/llm/test', { provider: 'zz-absent', model: 'm' })).status).toBe(404);
    expect((await api(a, 'GET', '/api/settings/llm', '/api/settings/llm')).status).toBe(403);
  });

  test('proxys : identifiants jamais renvoyés, test de joignabilité, suppression refusée tant qu’une API le choisit', async () => {
    const listener = createTcpServer((socket) => socket.end());
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as AddressInfo).port;
    try {
      const created = await api(admin, 'POST', '/api/settings/proxies', '/api/settings/proxies', { label: 'zz_test dc', type: 'dc', url: `http://127.0.0.1:${port}`, username: 'zz_user', password: 'zz_test_proxy_password', price: { per_gb_usd: 1.5 } });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ type: 'dc', username_set: true, password_set: true, price: { per_gb_usd: 1.5 } });
      expect(created.raw.body).not.toContain('zz_test_proxy_password');
      const id = created.body['id'] as string;
      expect((await api(admin, 'POST', '/api/settings/proxies', '/api/settings/proxies', { label: 'zz', type: 'dc', url: 'http://u:p@127.0.0.1:1' })).body).toMatchObject({ error: { code: 'invalid_proxy' } });
      expect((await api(admin, 'GET', '/api/settings/proxies', '/api/settings/proxies')).raw.body).not.toContain('zz_test_proxy_password');
      expect((await api(admin, 'GET', `/api/settings/proxies/${id}`, '/api/settings/proxies/{id}')).body).toMatchObject({ id, label: 'zz_test dc' });
      expect((await api(admin, 'PATCH', `/api/settings/proxies/${id}`, '/api/settings/proxies/{id}', { label: 'zz_test dc 2' })).body).toMatchObject({ label: 'zz_test dc 2', password_set: true });
      expect((await api(admin, 'POST', `/api/settings/proxies/${id}/test`, '/api/settings/proxies/{id}/test')).body).toMatchObject({ ok: true, exit_ip: null });
      const user = await seedApi(srv.db.url, a.user.id);
      await withClient(srv.db.url, (c) => c.query(`UPDATE apis SET network_policy = jsonb_build_object('allow', '["direct","dc_proxy"]'::jsonb, 'proxy_ids', jsonb_build_object('dc_proxy', $2::text)) WHERE id = $1`, [user.id, id]));
      expect((await api(admin, 'DELETE', `/api/settings/proxies/${id}`, '/api/settings/proxies/{id}')).body).toMatchObject({ error: { code: 'proxy_in_use' } });
      await withClient(srv.db.url, (c) => c.query(`UPDATE apis SET network_policy = '{"allow": ["direct"]}' WHERE id = $1`, [user.id]));
      expect((await api(admin, 'DELETE', `/api/settings/proxies/${id}`, '/api/settings/proxies/{id}')).status).toBe(204);
      expect(await count("SELECT count(*) FROM secrets WHERE kind = 'proxy'")).toBe(0);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
    expect((await api(b, 'GET', '/api/settings/proxies', '/api/settings/proxies')).status).toBe(403);
  });

  test('SMTP : mot de passe jamais relu, conservé si absent ; test sans relais → échec lisible', async () => {
    const put = await api(owner, 'PUT', '/api/settings/smtp', '/api/settings/smtp', { host: '127.0.0.1', port: 9, security: 'starttls', from: 'zz_test@example.test', username: 'zz_user', password: 'zz_test_smtp_password' });
    expect(put.body).toMatchObject({ host: '127.0.0.1', username_set: true, password_set: true, tested_at: null });
    const again = await api(owner, 'PUT', '/api/settings/smtp', '/api/settings/smtp', { host: '127.0.0.1', port: 10, security: 'starttls', from: 'zz_test@example.test', username: 'zz_user' });
    expect(again.body).toMatchObject({ port: 10, password_set: true });
    expect(await count("SELECT count(*) FROM secrets WHERE kind = 'smtp_password'")).toBe(1);
    expect((await api(owner, 'GET', '/api/settings/smtp', '/api/settings/smtp')).raw.body).not.toContain('zz_test_smtp_password');
    const tested = await api(owner, 'POST', '/api/settings/smtp/test', '/api/settings/smtp/test', { to: 'zz_test@example.test' });
    expect(tested.body).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^smtp_/) } });
  });
});

describe('droits des personnes (17 § 6) et appairage (07 § 1)', () => {
  test('export : contenu au propriétaire des données, métadonnées à l’admin ; effacement : aperçu puis confirmation', async () => {
    const personal = { type: 'object', properties: { email: { type: 'string', 'x-personal': 'identifier' }, title: { type: 'string' } } };
    const api1 = await seedApi(srv.db.url, a.user.id);
    await withClient(srv.db.url, (c) => c.query('UPDATE apis SET output_schema = $2 WHERE id = $1', [api1.id, JSON.stringify(personal)]));
    await seedRun(srv.db.url, { apiId: api1.id, ownerId: a.user.id, items: [{ email: 'zz_test_jane@example.test', title: 'zz_test_profile' }] });
    const mine = await api(a, 'POST', '/api/subjects/export', '/api/subjects/export', { identifier: 'zz_test_jane@example.test' });
    expect(mine.body).toMatchObject({ scope: 'owner', content: true });
    expect(mine.raw.body).toContain('zz_test_profile');
    const instance = await api(admin, 'POST', '/api/subjects/export', '/api/subjects/export', { identifier: 'zz_test_jane@example.test' });
    expect(instance.body).toMatchObject({ scope: 'instance', content: false });
    expect(instance.raw.body).not.toContain('zz_test_profile');
    expect((await api(a, 'POST', '/api/subjects/export', '/api/subjects/export', { identifier: 'zz_test_jane@example.test', scope: 'instance' })).status).toBe(403);
    expect((await api(a, 'POST', '/api/subjects/export', '/api/subjects/export', { identifier: 'true' })).body).toMatchObject({ error: { code: 'invalid_subject' } });
    const dry = await api(a, 'POST', '/api/subjects/erase', '/api/subjects/erase', { identifier: 'zz_test_jane@example.test', dry_run: true });
    expect(dry.body).toMatchObject({ dry_run: true, excluded: false, confirmation: expect.any(String), counts: { dataset_items: 1 } });
    expect((await api(a, 'POST', '/api/subjects/erase', '/api/subjects/erase', { identifier: 'zz_test_jane@example.test', dry_run: false })).body).toMatchObject({ error: { code: 'confirmation_required' } });
    const done = await api(a, 'POST', '/api/subjects/erase', '/api/subjects/erase', { identifier: 'zz_test_jane@example.test', dry_run: false, confirmation: dry.body['confirmation'] });
    expect(done.body).toMatchObject({ dry_run: false, excluded: true });
    expect(await count("SELECT count(*) FROM dataset_items WHERE item::text LIKE '%zz_test_jane%'")).toBe(0);
  });

  test('POST /api/tunnel/pairing-code : ré-authentification, code à usage unique (snake_case)', async () => {
    const res = await api(b, 'POST', '/api/tunnel/pairing-code', '/api/tunnel/pairing-code', { current_password: b.user.password });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code: expect.any(String), expires_at: expect.any(String) });
    expect((await api(b, 'POST', '/api/tunnel/pairing-code', '/api/tunnel/pairing-code', { current_password: 'zz_test_wrong' })).status).toBe(403);
  });
});

describe('assert_rest_endpoints_contract : chaque endpoint livré par 3.1 a des réponses contrôlées au contrat', () => {
  test('couverture', () => {
    const delivered31 = [
      'GET /api/openapi.json', 'GET /api/apis', 'POST /api/apis', 'POST /api/apis/{id}/validate-schema', 'GET /api/apis/{slug}', 'PATCH /api/apis/{slug}', 'DELETE /api/apis/{slug}',
      'POST /api/apis/{slug}/runs', 'POST /api/apis/{slug}/investigate', 'GET /api/apis/{slug}/versions', 'GET /api/apis/{slug}/versions/{version}',
      'GET /api/apis/{slug}/versions/{version}/diff', 'POST /api/apis/{slug}/versions/{version}/revert', 'GET /api/apis/{slug}/status-events',
      'GET /api/apis/{slug}/schedules', 'POST /api/apis/{slug}/schedules', 'GET /api/apis/{slug}/schedules/{id}', 'PATCH /api/apis/{slug}/schedules/{id}', 'DELETE /api/apis/{slug}/schedules/{id}',
      'GET /api/runs', 'GET /api/runs/{id}', 'POST /api/runs/{id}/cancel', 'POST /api/runs/{id}/pause', 'POST /api/runs/{id}/resume', 'GET /api/runs/{id}/logs', 'GET /api/datasets/{id}/items',
      'GET /api/webhook-subscriptions', 'POST /api/webhook-subscriptions', 'GET /api/webhook-subscriptions/{id}', 'PATCH /api/webhook-subscriptions/{id}', 'DELETE /api/webhook-subscriptions/{id}', 'POST /api/webhook-subscriptions/{id}/test',
      'GET /api/settings/llm', 'PUT /api/settings/llm', 'POST /api/settings/llm/test', 'GET /api/settings/proxies', 'POST /api/settings/proxies', 'GET /api/settings/proxies/{id}', 'PATCH /api/settings/proxies/{id}',
      'DELETE /api/settings/proxies/{id}', 'POST /api/settings/proxies/{id}/test', 'GET /api/settings/smtp', 'PUT /api/settings/smtp', 'POST /api/settings/smtp/test',
      'POST /api/subjects/erase', 'POST /api/subjects/export', 'POST /api/tunnel/pairing-code', 'GET /api/me/responsible-use', 'POST /api/me/responsible-use',
    ];
    const covered = [...contract.covered].map((c) => c.split(' ').slice(0, 2).join(' '));
    const successes = [...contract.covered].filter((c) => /\s2\d\d$/.test(c)).map((c) => c.split(' ').slice(0, 2).join(' '));
    expect(delivered31.filter((op) => !covered.includes(op))).toEqual([]);
    expect(delivered31.filter((op) => !successes.includes(op))).toEqual([]);
    // Les deux flux SSE sont contrôlés à part (trames), leurs erreurs au contrat.
    expect(contract.operations()).toEqual(expect.arrayContaining(['GET /api/events', 'GET /api/runs/{id}/events']));
  });
});
