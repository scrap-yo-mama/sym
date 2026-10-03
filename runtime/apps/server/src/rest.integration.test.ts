// SPDX-License-Identifier: AGPL-3.0-only
// API REST (tâche 3.1, 05 § 4.2-4.4) sur un serveur réel et une base migrée : tests de contrat de chaque endpoint (chaque
// réponse validée contre l'OpenAPI SERVIE, `assert_rest_endpoints_contract`), codes d'erreur de 05 § 4.3
// (`assert_rest_error_codes`), export en flux (`assert_export_streaming`), CSV neutralisé (`assert_csv_formula_neutralized`),
// SSE multiplexé et reprise (`assert_sse_multiplexed_resume`), annulation, pause et reprise (`assert_run_cancel_pause_resume`),
// case « j'ai lu » (`assert_responsible_use_ack`), OpenAPI servie valide (`assert_openapi_served_valid`).
// Le worker est simulé en base (run terminé, dataset écrit) : ces tests portent sur le contrat HTTP, pas sur l'exécution.
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { createConfig, lintFromString } from '@redocly/openapi-core';
import { buildInputSchema, instructedStepsSha256, validateInstructedSteps } from '@runtime/core';
import { saveInvestigationStrategy, sweepOrphans, type InvestigationState } from '@runtime/db';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { OpenApiContract } from '../../../tests/helpers/openapi-contract.js';
import { withClient } from '../../../tests/helpers/pg.js';
import { seedApi, seedRun, seedSchedule } from '../../../tests/helpers/rest-seed.js';
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
async function openStream(path: string, party: Party | null, lastEventId?: string, extra: Record<string, string> = {}) {
  const controller = new AbortController();
  const res = await fetch(`${base}${path}`, { headers: { ...(party ? { cookie: party.cookie } : {}), ...(lastEventId ? { 'last-event-id': lastEventId } : {}), ...extra }, signal: controller.signal });
  // Ouverture au contrat : 200 `text/event-stream` déclaré par l'OpenAPI servie (les trames sont contrôlées par chaque test).
  if (res.status === 200) {
    expect(res.headers.get('content-type') ?? '').toMatch(/^text\/event-stream/);
    expect(contract.check('GET', path.startsWith('/api/runs/') ? '/api/runs/{id}/events' : '/api/events', 200, undefined)).toEqual([]);
  }
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
  srv = await startTestServer('rest', { RUNTIME_TEST_ALLOW_PRIVATE: '1', NODE_ENV: 'test', ALLOWED_EGRESS_PORTS: String(hookPort), MAX_CONCURRENT_RUNS: '1000', MAX_ACTIVE_RUNS_PER_USER: '1000' }, {
    rest: { pollMs: 40, pingMs: 300, maxStreamsPerUser: 3, revalidateMs: 100 },
    // Mémoire négative (2.12) simulée en service : sans elle, toute activation du mode répond 409 (défaut du dépôt).
    persistence: { negativeMemory: { available: true, priorRefusal: async () => false } },
  });
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
    // Le protocole MCP (JSON-RPC, 3.2) n'est pas une route REST : hors de l'OpenAPI.
    const registered = ROUTES.filter((r) => !r.mcp).map((r) => `${r.method} ${r.url.replace(/:(\w+)/g, '{$1}')}`).sort();
    expect(served).toEqual(registered);
    const ids = Object.values(doc.paths).flatMap((item) => Object.values(item).map((op) => op.operationId)).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    expect(contract.compileAll()).toEqual([]);
    // Toute référence pointe vers un schéma, une réponse ou un paramètre défini.
    const refs = [...res.raw.body.matchAll(/"\$ref":"#\/components\/(\w+)\/(\w+)"/g)];
    expect(refs.length).toBeGreaterThan(100);
    const components = (res.body as { components: Record<string, Record<string, unknown>> }).components;
    expect(refs.filter((m) => !components[m[1]!]?.[m[2]!]).map((m) => m[0])).toEqual([]);
    // Validation STRUCTURELLE du document servi contre la spécification OpenAPI 3.1 (règle `struct` de Redocly : champs
    // requis, types et formes de chaque objet), en plus des contrôles ci-dessus.
    const config = await createConfig({ rules: { struct: 'error' } });
    const problems = await lintFromString({ source: res.raw.body, absoluteRef: 'openapi.json', config });
    expect(problems.filter((p) => p.ruleId === 'struct').map((p) => `${p.location[0]?.pointer ?? ''} ${p.message}`)).toEqual([]);
    // Le contrôle mord : un document servi amputé d'un champ requis (info.title) est refusé.
    const broken = JSON.parse(res.raw.body) as { info: Record<string, unknown> };
    delete broken.info['title'];
    const refused = await lintFromString({ source: JSON.stringify(broken), absoluteRef: 'openapi.json', config });
    expect(refused.some((p) => p.ruleId === 'struct')).toBe(true);
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
    expect(detail.body).toMatchObject({ status: 'enquete', metadata_only: false, access_policy: { report_id: null }, owner_id: a.user.id });
    expect(detail.body.access_policy).not.toHaveProperty('robots');
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

  test('assert_catalog_summary_domain : chaque ligne de GET /api/apis (et la fiche) porte le domaine de la page enquêtée, en minuscules ; null sans enquête', async () => {
    const created = await api(a, 'POST', '/api/apis', '/api/apis', {
      description: 'Les romans du catalogue zz domaine, avec titre',
      url: 'https://Romans.ZZ-Test-Domaine.example/liste?page=1',
      network_policy: { allow: ['direct'] },
    });
    expect(created.status).toBe(201);
    const seeded = await seedApi(srv.db.url, a.user.id);
    const rows = (await api(a, 'GET', '/api/apis?limit=100', '/api/apis')).body['apis'] as { id: string; domain?: string | null }[];
    expect(rows.find((row) => row.id === created.body['api_id'])?.domain).toBe('romans.zz-test-domaine.example');
    // API créée hors enquête : aucun domaine connu, le champ est là et vaut null (jamais la description à la place).
    const plain = rows.find((row) => row.id === seeded.id);
    expect(plain).toBeDefined();
    expect(plain?.domain).toBeNull();
    const detail = await api(a, 'GET', `/api/apis/${created.body['slug']}`, '/api/apis/{slug}');
    expect(detail.body['domain']).toBe('romans.zz-test-domaine.example');
    // Seul le domaine sort de l'état d'enquête : ni l'URL de départ ni l'état ne sont servis.
    expect(JSON.stringify(detail.body)).not.toContain('/liste?page=1');
    expect(JSON.stringify(detail.body)).not.toContain('start_url');
  });

  test('POST /api/apis refuse : URL à jeton, politique réseau inconnue, corps hors schéma (400) ; validation automatique sans « j’ai lu » (403)', async () => {
    expect((await api(a, 'POST', '/api/apis', '/api/apis', { description: 'zz', url: 'https://zz-test.example/?token=abc' })).body).toMatchObject({ error: { code: 'invalid_request' } });
    expect((await api(a, 'POST', '/api/apis', '/api/apis', { description: 'zz', url: 'https://zz-test.example/', network_policy: { allow: ['dc_proxy'], proxy_ids: { dc_proxy: 'zz-unknown' } } })).body).toMatchObject({ error: { code: 'invalid_network_policy' } });
    expect((await api(a, 'POST', '/api/apis', '/api/apis', { description: 'zz', url: 'https://zz-test.example/', zz_unknown: true })).status).toBe(400);
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

  test('PATCH : `max_cost_usd: null` et `budget_daily_usd: null` reviennent au défaut de l’instance (jamais un 200 sans effet)', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    expect((await api(a, 'PATCH', `/api/apis/${api1.slug}`, '/api/apis/{slug}', { max_cost_usd: 2, budget_daily_usd: 7 })).body).toMatchObject({ max_cost_usd: 2, budget_daily_usd: 7 });
    const reset = await api(a, 'PATCH', `/api/apis/${api1.slug}`, '/api/apis/{slug}', { max_cost_usd: null, budget_daily_usd: null });
    expect(reset.status).toBe(200);
    // Défauts de l'instance : ceux de la colonne (0,5 $ par run, 5 $ par jour).
    expect(reset.body).toMatchObject({ max_cost_usd: 0.5, budget_daily_usd: 5 });
    expect(await count('SELECT max_cost_usd::float FROM apis WHERE id = $1', [api1.id])).toBe(0.5);
  });

  test('fiche d’une API `instance` d’autrui : de quoi la lancer (schémas, statut, exécution, réseau, coût), jamais la politique du propriétaire', async () => {
    const shared = await seedApi(srv.db.url, a.user.id, { visibility: 'instance' });
    await withClient(srv.db.url, (c) =>
      c.query(
        `UPDATE apis SET purpose = 'zz_test_purpose_owner', legal_basis = 'zz_test_legal_owner', max_cost_usd = 3, budget_daily_usd = 9,
           network_policy = '{"allow": ["direct", "dc_proxy"], "proxy_ids": {"dc_proxy": "zz-test-proxy-owner"}, "dc_proxy_params": {"country": "fr"}}' WHERE id = $1`,
        [shared.id],
      ),
    );
    const mine = await api(a, 'GET', `/api/apis/${shared.slug}`, '/api/apis/{slug}');
    expect(mine.body).toMatchObject({ purpose: 'zz_test_purpose_owner', max_cost_usd: 3, network_policy: { proxy_ids: { dc_proxy: 'zz-test-proxy-owner' } } });
    const other = await api(b, 'GET', `/api/apis/${shared.slug}`, '/api/apis/{slug}');
    expect(other.status).toBe(200);
    expect(other.body).toMatchObject({ slug: shared.slug, status: 'sain', metadata_only: false, network_policy: { allow: ['direct', 'dc_proxy'] }, cost_estimate: { sample_size: 0 } });
    expect(other.body['input_schema']).toMatchObject({ type: 'object' });
    expect(other.body['output_schema']).toMatchObject({ type: 'object' });
    expect(other.body['network_policy']).toEqual({ allow: ['direct', 'dc_proxy'] });
    for (const field of ['purpose', 'legal_basis', 'max_cost_usd', 'budget_daily_usd', 'domain_pacing', 'project_id']) expect(other.body, field).not.toHaveProperty(field);
    expect(other.raw.body).not.toMatch(/zz_test_purpose_owner|zz_test_legal_owner|zz-test-proxy-owner/);
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

  test('assert_instance_api_delete_keeps_others_data : DELETE d’une API `instance` utilisée par un autre membre : 409 api_in_use_by_others, données de B intactes (INV12)', async () => {
    const shared = await seedApi(srv.db.url, a.user.id, { visibility: 'instance' });
    const mine = await seedRun(srv.db.url, { apiId: shared.id, ownerId: a.user.id, items: [{ title: 'zz_a' }] });
    // B lance l'API de A (lisible par lui) et la planifie : son run, son dataset (épinglé) et sa planification.
    const ofB = await seedRun(srv.db.url, { apiId: shared.id, ownerId: b.user.id, items: [{ title: 'zz_b' }] });
    await withClient(srv.db.url, (c) => c.query("UPDATE datasets SET pinned = true, pinned_reason = 'zz_test', pinned_until = now() + interval '1 day' WHERE id = $1", [ofB.datasetId]));
    const refused = await api(a, 'DELETE', `/api/apis/${shared.slug}`, '/api/apis/{slug}');
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: 'api_in_use_by_others' } });
    expect(await count('SELECT count(*) FROM datasets WHERE id = ANY($1::uuid[])', [[ofB.datasetId, mine.datasetId]])).toBe(2);
    expect(await count('SELECT count(*) FROM dataset_items WHERE dataset_id = $1', [ofB.datasetId])).toBe(1);
    expect((await api(b, 'GET', `/api/runs/${ofB.runId}`, '/api/runs/{id}')).status).toBe(200);
    expect((await api(a, 'GET', `/api/apis/${shared.slug}`, '/api/apis/{slug}')).status).toBe(200);
    // Une planification de B sur l'API de A suffit aussi à refuser.
    await withClient(srv.db.url, async (c) => {
      await c.query('DELETE FROM datasets WHERE id = $1', [ofB.datasetId]);
      await c.query('DELETE FROM runs WHERE id = $1', [ofB.runId]);
    });
    const schedule = await seedSchedule(srv.db.url, shared.id, b.user.id);
    expect((await api(a, 'DELETE', `/api/apis/${shared.slug}`, '/api/apis/{slug}')).body).toMatchObject({ error: { code: 'api_in_use_by_others' } });
    expect(await count('SELECT count(*) FROM schedules WHERE id = $1', [schedule])).toBe(1);
    await withClient(srv.db.url, (c) => c.query('DELETE FROM schedules WHERE id = $1', [schedule]));
    // Un run ACTIF de B : même refus (A ne peut pas l'annuler, `runs_active` l'inviterait à le faire).
    const activeOfB = await seedRun(srv.db.url, { apiId: shared.id, ownerId: b.user.id, state: 'running' });
    expect((await api(a, 'DELETE', `/api/apis/${shared.slug}`, '/api/apis/{slug}')).body).toMatchObject({ error: { code: 'api_in_use_by_others' } });
    await withClient(srv.db.url, (c) => c.query('DELETE FROM runs WHERE id = $1', [activeOfB.runId]));
    // Un abonnement webhook de B limité à cette API : la cascade l'emporterait sans prévenir B.
    const hookOfB = await api(b, 'POST', '/api/webhook-subscriptions', '/api/webhook-subscriptions', { url: `http://127.0.0.1:${hookPort}/zz-test-hook-b`, events: ['run.failed'], api_slug: shared.slug });
    expect(hookOfB.status).toBe(201);
    expect((await api(a, 'DELETE', `/api/apis/${shared.slug}`, '/api/apis/{slug}')).body).toMatchObject({ error: { code: 'api_in_use_by_others' } });
    expect(await count('SELECT count(*) FROM webhook_subscriptions WHERE id = $1', [hookOfB.body['id']])).toBe(1);
    // Plus rien d'autrui : la suppression passe et n'emporte que les données de A.
    expect((await api(b, 'DELETE', `/api/webhook-subscriptions/${hookOfB.body['id']}`, '/api/webhook-subscriptions/{id}')).status).toBe(204);
    expect((await api(a, 'DELETE', `/api/apis/${shared.slug}`, '/api/apis/{slug}')).status).toBe(204);
    expect(await count('SELECT count(*) FROM datasets WHERE id = $1', [mine.datasetId])).toBe(0);
  });

  test('assert_slug_no_existence_hint : slug : jamais d’indice qu’une API invisible porte un slug (13 § 3) ; URL illisible → 400 invalid_request, jamais 500', async () => {
    // Une API PRIVÉE de B porte le slug que la description de A donnerait.
    await seedApi(srv.db.url, b.user.id, { slug: 'oracle-probe-target' });
    const taken = await api(a, 'POST', '/api/apis', '/api/apis', { description: 'oracle probe target', url: 'https://zz-test-slug.example/' });
    const free = await api(a, 'POST', '/api/apis', '/api/apis', { description: 'oracle probe unused', url: 'https://zz-test-slug.example/' });
    expect(taken.status).toBe(201);
    expect(free.status).toBe(201);
    // Même forme, que la base soit prise par une API invisible ou libre : rien ne distingue les deux cas.
    expect(taken.body['slug']).toMatch(/^oracle-probe-target-[0-9a-f]{6}$/);
    expect(free.body['slug']).toMatch(/^oracle-probe-unused-[0-9a-f]{6}$/);
    const bad = await api(a, 'POST', '/api/apis', '/api/apis', { description: 'zz', url: 'zz-pas-une-url' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: { code: 'invalid_request' } });
  });

  test('assert_rest_inputs_bounded : nombres et curseurs hors bornes → 400, jamais 500 ; entrée de run non objet → 400 invalid_input, aucun run', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    const runId = (await seedRun(srv.db.url, { apiId: api1.id, ownerId: a.user.id, items: [{ title: 'zz' }] })).runId;
    const big = 3_000_000_000;
    const cur = (...parts: string[]) => Buffer.from(JSON.stringify(parts)).toString('base64url');
    const cases: [string, string, string, unknown?][] = [
      ['POST', `/api/apis/${api1.slug}/runs`, '/api/apis/{slug}/runs', { input: {}, strategy_version: big }],
      ['GET', `/api/apis/${api1.slug}/versions/${big}`, '/api/apis/{slug}/versions/{version}'],
      ['GET', `/api/apis/${api1.slug}/versions/1/diff?against=${big}`, '/api/apis/{slug}/versions/{version}/diff'],
      ['GET', `/api/runs/${runId}/logs?after=${big}`, '/api/runs/{id}/logs'],
      ['GET', `/api/apis/${api1.slug}/versions?cursor=${cur('99999999999999999999')}`, '/api/apis/{slug}/versions'],
      ['GET', `/api/apis/${api1.slug}/status-events?cursor=${cur('99999999999999999999')}`, '/api/apis/{slug}/status-events'],
      ['GET', `/api/apis?cursor=${cur('pas une date', 'pas un uuid')}`, '/api/apis'],
      ['GET', `/api/runs?cursor=${cur('pas une date', '00000000-0000-0000-0000-000000000000')}`, '/api/runs'],
    ];
    for (const [method, url, template, body] of cases) {
      const res = await api(a, method, url, template, body);
      expect(res.status, `${method} ${url}`).toBe(400);
    }
    const before = await count('SELECT count(*) FROM runs WHERE api_id = $1', [api1.id]);
    for (const input of ['zz', 42, null, ['zz']]) {
      const res = await api(a, 'POST', `/api/apis/${api1.slug}/runs`, '/api/apis/{slug}/runs', { input });
      expect(res.status, JSON.stringify(input)).toBe(400);
      expect(res.body).toMatchObject({ error: { code: 'invalid_input' } });
    }
    expect(await count('SELECT count(*) FROM runs WHERE api_id = $1', [api1.id])).toBe(before);
  });

  test.todo('assert_brief_optional (REST) : `POST /api/apis` accepte `brief` (05 § 4.2, 19c) ; branché sur le service de 2.14 quand elle sera fusionnée (aujourd’hui `brief` → 400, schéma fermé)');

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

describe('assert_persistence_opt_in_only : PATCH /api/apis/{slug} (D-49, mode « SYM ne lâche pas »)', () => {
  test('clé d’API : 403 human_confirmation_required sans rien écrire ; session : activé, audité, état Api.persistence ; désactivation par clé permise ; 409 sans version courante', async () => {
    const seeded = await seedApi(srv.db.url, a.user.id);
    const path = `/api/apis/${seeded.slug}`;
    const key = (await srv.app.inject({ method: 'POST', url: '/api/api-keys', headers: { cookie: a.cookie, origin: PUBLIC_URL }, payload: { label: 'zz persistence', scopes: ['apis:read', 'apis:write'], currentPassword: a.user.password } })).json<{ key: string }>().key;
    const bearer = { authorization: `Bearer ${key}` };
    const mode = async () => withClient(srv.db.url, async (c) => (await c.query<{ persistence_mode: boolean; persistence_budget_usd: string | null }>('SELECT persistence_mode, persistence_budget_usd::text FROM apis WHERE id = $1', [seeded.id])).rows[0]!);
    const audits = async () =>
      withClient(srv.db.url, async (c) => (await c.query<{ action: string; actor_via: string; outcome: string }>("SELECT action, actor_via, outcome FROM audit_events WHERE target_id = $1 AND action LIKE 'api.persistence%' ORDER BY at, id", [seeded.id])).rows);

    // Fiche : le mode est désactivé par défaut et son état est exposé au propriétaire.
    const before = await api(a, 'GET', path, '/api/apis/{slug}');
    expect(before.status).toBe(200);
    expect(before.body['persistence']).toMatchObject({ enabled: false, budget_usd: 1, attempt: 0, next_at: null, spent_usd: 0, in_progress: false, ended: null });

    // Clé d’API (même avec apis:write) : 403 et rien n’est écrit (ni le mode, ni un autre champ de la même requête).
    const denied = await api(null, 'PATCH', path, '/api/apis/{slug}', { persistence_mode: true, description: 'zz_test ne doit pas changer' }, bearer);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { code: 'human_confirmation_required', what_to_do: expect.any(String) } });
    expect(await mode()).toEqual({ persistence_mode: false, persistence_budget_usd: null });
    expect(await count('SELECT count(*) FROM apis WHERE id = $1 AND description = $2', [seeded.id, 'zz_test ne doit pas changer'])).toBe(0);

    // Session console : activé avec un plafond propre, audité avec l’acteur, état rendu par la fiche.
    const enabled = await api(a, 'PATCH', path, '/api/apis/{slug}', { persistence_mode: true, persistence_budget_usd: 2 });
    expect(enabled.status).toBe(200);
    expect(enabled.body['persistence']).toMatchObject({ enabled: true, budget_usd: 2 });
    expect(await mode()).toEqual({ persistence_mode: true, persistence_budget_usd: '2.000000' });
    expect((await api(a, 'GET', path, '/api/apis/{slug}')).body['persistence']).toMatchObject({ enabled: true, budget_usd: 2 });

    // Changer le plafond d’un mode actif est aussi un acte coûteux : 403 par clé.
    expect((await api(null, 'PATCH', path, '/api/apis/{slug}', { persistence_budget_usd: 50 }, bearer)).status).toBe(403);
    // Désactiver reste permis à toute clé du scope.
    const off = await api(null, 'PATCH', path, '/api/apis/{slug}', { persistence_mode: false }, bearer);
    expect(off.status).toBe(200);
    expect(off.body['persistence']).toMatchObject({ enabled: false });
    expect(await audits()).toEqual([
      { action: 'api.persistence_enable', actor_via: 'apikey', outcome: 'denied' },
      { action: 'api.persistence_enable', actor_via: 'ui', outcome: 'success' },
      { action: 'api.persistence_enable', actor_via: 'apikey', outcome: 'denied' },
      { action: 'api.persistence_disable', actor_via: 'apikey', outcome: 'success' },
    ]);

    // 409 persistence_not_eligible : API sans version courante (jamais validée), raison et marche à suivre.
    const fresh = await seedApi(srv.db.url, a.user.id, { strategy: false, status: 'erreur' });
    const refused = await api(a, 'PATCH', `/api/apis/${fresh.slug}`, '/api/apis/{slug}', { persistence_mode: true });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: 'persistence_not_eligible', reason: 'no_current_version', what_to_do: expect.any(String) } });
    // Plafond propre nul : 409 aussi (jamais un 400 de forme, jamais « illimité »).
    expect((await api(a, 'PATCH', path, '/api/apis/{slug}', { persistence_mode: true, persistence_budget_usd: 0 })).body).toMatchObject({ error: { code: 'persistence_not_eligible', reason: 'budget_not_positive' } });

    // Un autre membre ne voit jamais l’état du mode d’une API qui n’est pas la sienne.
    await withClient(srv.db.url, (c) => c.query("UPDATE apis SET visibility = 'instance' WHERE id = $1", [seeded.id]));
    expect((await api(b, 'GET', path, '/api/apis/{slug}')).body['persistence']).toBeUndefined();
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

describe('validation du schéma : case « j’ai lu » non contournable, ordre déclaré des colonnes', () => {
  /** API créée par `party`, worker simulé : schéma proposé, phase d'attente de validation, run d'enquête terminé. */
  const awaitingValidation = async (party: Party, proposed: Record<string, unknown>) => {
    const created = await api(party, 'POST', '/api/apis', '/api/apis', { description: 'zz_test validation du schéma', url: 'https://zz-test-schema.example/' });
    const apiId = created.body['api_id'] as string;
    await withClient(srv.db.url, async (c) => {
      await c.query(
        "UPDATE apis SET investigation_phase = 'awaiting_schema_validation', investigation = investigation || jsonb_build_object('proposed_schema', $2::jsonb, 'proposed_columns', $3::jsonb) WHERE id = $1",
        [apiId, JSON.stringify(proposed), JSON.stringify(Object.keys((proposed['properties'] ?? {}) as object))],
      );
      await c.query("UPDATE runs SET state = 'succeeded', outcome = 'clean', finished_at = now() WHERE id = $1", [created.body['run_id']]);
    });
    return { apiId, slug: created.body['slug'] as string };
  };

  test('17 § 11 : renvoyer le schéma proposé SANS ses marques `x-personal` ne contourne pas la case', async () => {
    const c: Party = await (async () => {
      const user = await createUser(srv, 'zz_test_rest_c@example.test');
      return { user, cookie: await signIn(srv, user) };
    })();
    const proposed = { type: 'object', properties: { name: { type: 'string', 'x-personal': 'identifier' }, city: { type: 'string' } } };
    const { apiId } = await awaitingValidation(c, proposed);
    const stripped = { type: 'object', properties: { name: { type: 'string' }, city: { type: 'string' } } };
    const res = await api(c, 'POST', `/api/apis/${apiId}/validate-schema`, '/api/apis/{id}/validate-schema', { output_schema: stripped });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'responsible_use_ack_required' } });
    // UX-19 : le message nomme le champ marqué (celui du schéma PROPOSÉ), jamais un champ non marqué.
    expect((res.body['error'] as { message: string }).message).toMatch(/x-personal : name \(/);
    expect(await count("SELECT count(*) FROM apis WHERE id = $1 AND investigation_phase = 'awaiting_schema_validation'", [apiId])).toBe(1);
    // Case cochée : la correction passe.
    await api(c, 'POST', '/api/me/responsible-use', '/api/me/responsible-use', { version: '2026-10-01' });
    // `x-personal` fourni par l'appelant ignoré (05 § 4.1) : la marque qu'il pose sur `city` ne compte pas.
    const forged = { type: 'object', properties: { name: { type: 'string' }, city: { type: 'string', 'x-personal': 'identifier' } } };
    expect((await api(c, 'POST', `/api/apis/${apiId}/validate-schema`, '/api/apis/{id}/validate-schema', { output_schema: forged })).status).toBe(202);
    // Les marques DÉTECTÉES sont réappliquées côté serveur au schéma validé : le masquage RGPD en aval tient.
    const state = await withClient(srv.db.url, async (cl) => (await cl.query<{ investigation: InvestigationState }>('SELECT investigation FROM apis WHERE id = $1', [apiId])).rows[0]!.investigation);
    expect(state.validated_schema).toEqual({ type: 'object', properties: { name: { type: 'string', 'x-personal': 'identifier' }, city: { type: 'string' } } });
  });

  test('assert_csv_declared_column_order : colonnes dans l’ordre DÉCLARÉ du schéma validé (corrigé par l’appelant), jamais dans l’ordre de jsonb', async () => {
    const proposed = { type: 'object', properties: { title: { type: 'string' }, price: { type: 'number' } } };
    const { apiId } = await awaitingValidation(a, proposed);
    // Schéma corrigé dont l'ordre déclaré n'est PAS celui de jsonb (clés courtes d'abord, puis ordre binaire).
    const corrected = { type: 'object', properties: { zeta_title: { type: 'string' }, price: { type: 'number' }, a_note: { type: 'string' } } };
    expect((await api(a, 'POST', `/api/apis/${apiId}/validate-schema`, '/api/apis/{id}/validate-schema', { output_schema: corrected })).status).toBe(202);
    const state = await withClient(srv.db.url, async (c) => (await c.query<{ investigation: InvestigationState }>('SELECT investigation FROM apis WHERE id = $1', [apiId])).rows[0]!.investigation);
    expect(state.validated_columns).toEqual(['zeta_title', 'price', 'a_note']);
    // Worker simulé : fin d'enquête conforme, comme l'exécuteur (ordre des colonnes validé transmis avec le schéma).
    await saveInvestigationStrategy(srv.started.ctx.pool, {
      apiId,
      ownerId: a.user.id,
      execution: 'fetch',
      network: 'direct',
      spec: { kind: 'declarative' },
      estCostUsd: 0,
      outputSchema: state.validated_schema,
      ...(state.validated_columns === undefined ? {} : { outputColumns: state.validated_columns }),
      inputSchema: buildInputSchema({ paginated: false }),
      state,
    });
    const run = await seedRun(srv.db.url, { apiId, ownerId: a.user.id, items: [{ a_note: '=n', price: 2, zeta_title: 't', extra: 'hors schéma' }] });
    const res = await srv.app.inject({ method: 'GET', url: `/api/datasets/${run.datasetId}/items?format=csv`, headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(200);
    const lines = res.body.split('\r\n');
    expect(lines[0]).toBe('zeta_title,price,a_note');
    expect(lines[1]).toBe("t,2,'=n");
    // Un champ hors des propriétés du schéma n'a pas de colonne CSV (documenté) ; `fields` le nomme, JSON et NDJSON le gardent.
    const named = await srv.app.inject({ method: 'GET', url: `/api/datasets/${run.datasetId}/items?format=csv&fields=zeta_title,extra`, headers: { cookie: a.cookie } });
    expect(named.body.split('\r\n').slice(0, 2)).toEqual(['zeta_title,extra', 't,hors schéma']);
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
    // Mots interdits par _exclusions.md compris (« débloquer », « passer » une protection).
    expect(text).not.toMatch(/proxy|tunnel|contourn|bypass|stealth|captcha|d[ée]bloqu|passer|unblock/i);
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

  test('run dégradé → 200, status warning et raisons ; budget épuisé → 200 sur get_run (failed, budget_exceeded et run_budget_exceeded)', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id, { status: 'warning' });
    const pending = api(a, 'POST', `/api/apis/${api1.slug}/runs?wait=10`, '/api/apis/{slug}/runs', { input: {} });
    await completeRun(await latestRun(api1.id), [{ title: 'zz' }], ['optional_fields_missing']);
    const done = await pending;
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ state: 'succeeded', status: 'warning', degraded_reasons: ['optional_fields_missing'] });
    expect(done.body['message']).toMatch(/warnings/);
    // Les deux classes de budget de 05 § 4.3 : plafond journalier (budget_exceeded) et plafond du run (run_budget_exceeded).
    for (const failureClass of ['budget_exceeded', 'run_budget_exceeded']) {
      const failed = await seedRun(srv.db.url, { apiId: api1.id, ownerId: a.user.id, state: 'failed', failureClass });
      const run = await api(a, 'GET', `/api/runs/${failed.runId}`, '/api/runs/{id}');
      expect(run.status).toBe(200);
      expect(run.body).toMatchObject({ state: 'failed', failure_class: failureClass, retryable: false });
    }
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

  test('assert_run_limits_per_user_and_key : limites par utilisateur et par clé (08b § 3) : 429 user_queue_full et key_rate_limited, les autres ne sont pas touchés', async () => {
    const fresh = async (email: string): Promise<Party> => {
      const user = await createUser(srv, email);
      return { user, cookie: await signIn(srv, user) };
    };
    const c = await fresh('zz_test_rest_limit_c@example.test');
    const d = await fresh('zz_test_rest_limit_d@example.test');
    const limits = srv.started.ctx.rest;
    const savedUser = limits.maxActiveRunsPerUser;
    const savedKey = limits.maxRunsPerKeyPerMinute;
    try {
      // Par utilisateur : C a déjà un run actif, D aucun ; plafond 1.
      limits.maxActiveRunsPerUser = 1;
      const apiC = await seedApi(srv.db.url, c.user.id);
      const apiD = await seedApi(srv.db.url, d.user.id);
      await seedRun(srv.db.url, { apiId: apiC.id, ownerId: c.user.id, state: 'queued' });
      const full = await api(c, 'POST', `/api/apis/${apiC.slug}/runs`, '/api/apis/{slug}/runs', { input: {} });
      expect(full.status).toBe(429);
      expect(full.body).toMatchObject({ error: { code: 'user_queue_full' } });
      expect(full.raw.headers['retry-after']).toBe('30');
      expect(await count("SELECT count(*) FROM runs WHERE api_id = $1 AND trigger = 'ui'", [apiC.id])).toBe(0);
      // Un run en pause ne compte pas.
      await withClient(srv.db.url, (cl) => cl.query("UPDATE runs SET paused_at = now(), job_id = NULL WHERE api_id = $1 AND state = 'queued'", [apiC.id]));
      expect((await api(c, 'POST', `/api/apis/${apiC.slug}/runs`, '/api/apis/{slug}/runs', { input: {} })).status).toBe(202);
      expect((await api(d, 'POST', `/api/apis/${apiD.slug}/runs`, '/api/apis/{slug}/runs', { input: {} })).status).toBe(202);
      // Par clé : 2 créations par minute au plus, puis 429 avec Retry-After ; la session du même utilisateur n'est pas touchée.
      limits.maxActiveRunsPerUser = 1000;
      limits.maxRunsPerKeyPerMinute = 2;
      const created = await srv.app.inject({ method: 'POST', url: '/api/api-keys', headers: { cookie: d.cookie, origin: PUBLIC_URL }, payload: { label: 'zz limit', scopes: ['apis:read', 'apis:run'], currentPassword: d.user.password } });
      const key = created.json<{ key: string }>().key;
      const viaKey = async () => {
        const res = await srv.app.inject({ method: 'POST', url: `/api/apis/${apiD.slug}/runs`, headers: { authorization: `Bearer ${key}` }, payload: { input: {} } });
        expect(contract.check('POST', '/api/apis/{slug}/runs', res.statusCode, res.json())).toEqual([]);
        return res;
      };
      expect((await viaKey()).statusCode).toBe(202);
      expect((await viaKey()).statusCode).toBe(202);
      const limited = await viaKey();
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ error: { code: 'key_rate_limited' } });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect((await api(d, 'POST', `/api/apis/${apiD.slug}/runs`, '/api/apis/{slug}/runs', { input: {} })).status).toBe(202);
      // Compteur par clé PARTAGÉ en PostgreSQL (08b § 3) : plusieurs instances du serveur, ou un redémarrage, voient le même.
      const keyId = await withClient(srv.db.url, async (cl) => (await cl.query<{ id: string }>("SELECT id FROM api_keys WHERE user_id = $1 AND label = 'zz limit'", [d.user.id])).rows[0]!.id);
      expect(await count('SELECT coalesce(sum(hits), 0) FROM run_creation_counters WHERE bucket = $1', [`key:${keyId}`])).toBe(3);
      // Création ATOMIQUE sous le plafond utilisateur : six demandes simultanées pour une place libre, une seule passe.
      limits.maxRunsPerKeyPerMinute = 1000;
      limits.maxActiveRunsPerUser = 1;
      const e = await fresh('zz_test_rest_limit_e@example.test');
      const apiE = await seedApi(srv.db.url, e.user.id);
      const burst = await Promise.all(
        Array.from({ length: 6 }, () => srv.app.inject({ method: 'POST', url: `/api/apis/${apiE.slug}/runs`, headers: { cookie: e.cookie, origin: PUBLIC_URL }, payload: { input: {} } })),
      );
      expect(burst.map((r) => r.statusCode).sort()).toEqual([202, 429, 429, 429, 429, 429]);
      expect(await count('SELECT count(*) FROM runs WHERE api_id = $1', [apiE.id])).toBe(1);
    } finally {
      limits.maxActiveRunsPerUser = savedUser;
      limits.maxRunsPerKeyPerMinute = savedKey;
    }
  });

  test('tunnel requis et hors ligne → 202 et run à suivre : waiting_tunnel, puis skipped_tunnel_offline sur get_run (05 § 4.3)', async () => {
    const tunnelled = await seedApi(srv.db.url, a.user.id);
    await withClient(srv.db.url, (c) => c.query(`UPDATE apis SET network_policy = '{"allow": ["tunnel"]}', requires = jsonb_build_object('tunnel', true) WHERE id = $1`, [tunnelled.id]));
    const pending = api(a, 'POST', `/api/apis/${tunnelled.slug}/runs?wait=2`, '/api/apis/{slug}/runs', { input: {} });
    // Worker simulé : extension hors ligne, le run attend le tunnel (07 § 6).
    let runId = '';
    for (let i = 0; i < 200 && runId === ''; i++) {
      runId = (await withClient(srv.db.url, async (c) => (await c.query<{ id: string }>("UPDATE runs SET state = 'waiting_tunnel' WHERE api_id = $1 AND state = 'queued' RETURNING id", [tunnelled.id])).rows[0]?.id)) ?? '';
      if (runId === '') await new Promise((r) => setTimeout(r, 25));
    }
    const accepted = await pending;
    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({ run_id: runId, state: 'waiting_tunnel', poll_after_seconds: 5 });
    // L'attente du tunnel expire : run sauté, sans classe d'échec.
    await withClient(srv.db.url, (c) => c.query("UPDATE runs SET state = 'skipped_tunnel_offline', finished_at = now() WHERE id = $1", [runId]));
    const run = await api(a, 'GET', `/api/runs/${runId}`, '/api/runs/{id}');
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ state: 'skipped_tunnel_offline' });
  });

  test('assert_strategy_version_choice_bounded : strategy_version : courante ou ayant été courante seulement (400 invalid_strategy_version), réservé au propriétaire', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id, { visibility: 'instance' });
    // v2 : vN+1 de réparation jamais validée (jamais courante).
    await withClient(srv.db.url, (c) => c.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, created_by, parent_version) VALUES ($1, 2, $2, 'agent', 'direct', '{}', 'repair', 1)", [api1.id, a.user.id]));
    const never = await api(a, 'POST', `/api/apis/${api1.slug}/runs`, '/api/apis/{slug}/runs', { input: {}, strategy_version: 2 });
    expect(never.status).toBe(400);
    expect(never.body).toMatchObject({ error: { code: 'invalid_strategy_version' } });
    expect(await count('SELECT count(*) FROM runs WHERE api_id = $1', [api1.id])).toBe(0);
    // Un membre sur l'API `instance` d'autrui ne choisit pas la version.
    const other = await api(b, 'POST', `/api/apis/${api1.slug}/runs`, '/api/apis/{slug}/runs', { input: {}, strategy_version: 1 });
    expect(other.status).toBe(403);
    expect(await count('SELECT count(*) FROM runs WHERE api_id = $1', [api1.id])).toBe(0);
    // La version courante (et une version qui l'a été) passe.
    const ok = await api(a, 'POST', `/api/apis/${api1.slug}/runs`, '/api/apis/{slug}/runs', { input: {}, strategy_version: 1 });
    expect(ok.status).toBe(202);
    expect(await count('SELECT count(*) FROM runs WHERE api_id = $1 AND strategy_version = 1', [api1.id])).toBe(1);
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

  test('cancel d’une enquête sans worker (en file ou en pause) : l’API quitte `enquete` par la machine (transition 2), phase close', async () => {
    for (const paused of [false, true]) {
      const created = await api(a, 'POST', '/api/apis', '/api/apis', { description: `zz_test enquête annulée ${paused ? 'en pause' : 'en file'}`, url: 'https://zz-test-cancel.example/' });
      const runId = created.body['run_id'] as string;
      if (paused) expect((await api(a, 'POST', `/api/runs/${runId}/pause`, '/api/runs/{id}/pause')).status).toBe(202);
      const res = await api(a, 'POST', `/api/runs/${runId}/cancel`, '/api/runs/{id}/cancel');
      expect(res.body).toMatchObject({ run_id: runId, state: 'cancelled' });
      const detail = await api(a, 'GET', `/api/apis/${created.body['slug']}`, '/api/apis/{slug}');
      expect(detail.body).toMatchObject({ status: 'erreur', investigation_phase: 'done' });
      const events = await withClient(srv.db.url, async (c) => (await c.query<{ from_status: string; to_status: string; reason: string; run_id: string }>('SELECT from_status, to_status, reason, run_id FROM status_events WHERE api_id = $1 ORDER BY id', [created.body['api_id']])).rows);
      expect(events.at(-1)).toMatchObject({ from_status: 'enquete', to_status: 'erreur', reason: 'investigation_budget_exhausted', run_id: runId });
      // « Ré-enquêter » repart de là (transition 16).
      expect((await api(a, 'POST', `/api/apis/${created.body['slug']}/investigate`, '/api/apis/{slug}/investigate', {})).status).toBe(202);
    }
  });

  test('assert_cancel_reinvestigation_restores_status : cancel d’une RÉ-enquête d’une API saine : retour au statut d’avant (transition 21), stratégie gardée, run accepté ensuite (INV3)', async () => {
    const created = await api(a, 'POST', '/api/apis', '/api/apis', { description: 'zz_test reenquete annulee', url: 'https://zz-test-recancel.example/' });
    const apiId = created.body['api_id'] as string;
    const slug = created.body['slug'] as string;
    // Worker simulé : première enquête conforme (stratégie v1), API saine.
    await withClient(srv.db.url, (c) => c.query("UPDATE runs SET state = 'succeeded', outcome = 'clean', finished_at = now() WHERE id = $1", [created.body['run_id']]));
    const state = await withClient(srv.db.url, async (c) => (await c.query<{ investigation: InvestigationState }>('SELECT investigation FROM apis WHERE id = $1', [apiId])).rows[0]!.investigation);
    await saveInvestigationStrategy(srv.started.ctx.pool, { apiId, ownerId: a.user.id, execution: 'fetch', network: 'direct', spec: { kind: 'declarative' }, estCostUsd: 0, outputSchema: { type: 'object', properties: { title: { type: 'string' } } }, inputSchema: buildInputSchema({ paginated: false }), state });
    await withClient(srv.db.url, (c) => c.query("UPDATE apis SET status = 'sain' WHERE id = $1", [apiId]));
    // Ré-enquête manuelle (transition 19), puis annulation de son run avant qu'un worker ne le prenne.
    const re = await api(a, 'POST', `/api/apis/${slug}/investigate`, '/api/apis/{slug}/investigate', {});
    expect(re.status).toBe(202);
    const runId = await withClient(srv.db.url, async (c) => (await c.query<{ id: string }>("SELECT id FROM runs WHERE api_id = $1 AND kind = 'investigation' AND state = 'queued'", [apiId])).rows[0]!.id);
    expect((await api(a, 'POST', `/api/runs/${runId}/cancel`, '/api/runs/{id}/cancel')).body).toMatchObject({ run_id: runId, state: 'cancelled' });
    const detail = await api(a, 'GET', `/api/apis/${slug}`, '/api/apis/{slug}');
    expect(detail.body).toMatchObject({ status: 'sain', investigation_phase: 'done' });
    expect(await count('SELECT current_strategy_version FROM apis WHERE id = $1', [apiId])).toBe(1);
    const last = await withClient(srv.db.url, async (c) => (await c.query<{ from_status: string; to_status: string; reason: string }>('SELECT from_status, to_status, reason FROM status_events WHERE api_id = $1 ORDER BY id DESC LIMIT 1', [apiId])).rows[0]);
    expect(last).toMatchObject({ from_status: 'enquete', to_status: 'sain', reason: 'reinvestigation_failed' });
    // L'API se lance de nouveau : plus de 409 investigation_in_progress fantôme.
    expect((await api(a, 'POST', `/api/apis/${slug}/runs`, '/api/apis/{slug}/runs', { input: {} })).status).toBe(202);
  });

  test('cancel d’une enquête : annulation et transition au MÊME COMMIT ; si la transition échoue, rien n’est écrit (jamais `enquete` sans run)', async () => {
    const created = await api(a, 'POST', '/api/apis', '/api/apis', { description: 'zz_test annulation atomique', url: 'https://zz-test-atomic-cancel.example/' });
    const apiId = created.body['api_id'] as string;
    const runId = created.body['run_id'] as string;
    expect(apiId).toMatch(/^[0-9a-f-]{36}$/);
    // Panne simulée de l'écriture du statut (status_events refusé pour cette API seulement).
    await withClient(srv.db.url, async (c) => {
      await c.query(`CREATE OR REPLACE FUNCTION zz_test_fail_status() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'zz_test panne du statut'; END $$`);
      await c.query(`CREATE TRIGGER zz_test_fail_status BEFORE INSERT ON status_events FOR EACH ROW WHEN (NEW.api_id = '${apiId}'::uuid) EXECUTE FUNCTION zz_test_fail_status()`);
    });
    try {
      const failed = await srv.app.inject({ method: 'POST', url: `/api/runs/${runId}/cancel`, headers: { cookie: a.cookie, origin: PUBLIC_URL } });
      expect(failed.statusCode).toBe(500);
      // Rien n'est parti : le run est toujours en file (annulable de nouveau), l'API en `enquete` avec SON enquête.
      expect(await count("SELECT count(*) FROM runs WHERE id = $1 AND state = 'queued'", [runId])).toBe(1);
      expect(await count("SELECT count(*) FROM apis WHERE id = $1 AND status = 'enquete' AND investigation_phase = 'access_check'", [apiId])).toBe(1);
    } finally {
      await withClient(srv.db.url, async (c) => {
        await c.query('DROP TRIGGER IF EXISTS zz_test_fail_status ON status_events');
        await c.query('DROP FUNCTION IF EXISTS zz_test_fail_status()');
      });
    }
    expect((await api(a, 'POST', `/api/runs/${runId}/cancel`, '/api/runs/{id}/cancel')).body).toMatchObject({ run_id: runId, state: 'cancelled' });
    expect(await count("SELECT count(*) FROM apis WHERE id = $1 AND status = 'erreur' AND investigation_phase = 'done'", [apiId])).toBe(1);
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

  test('resume : statut de l’API relu (bloquee → 409 blocked, INV3) et accès relu (API d’autrui redevenue privée → 404, INV12), aucun job', async () => {
    // Run en pause sur une API passée ensuite en `bloquee` : la reprise n'est pas un contournement du 409 de POST /runs.
    const api1 = await seedApi(srv.db.url, a.user.id);
    const runId = (await api(a, 'POST', `/api/apis/${api1.slug}/runs`, '/api/apis/{slug}/runs', { input: {} })).body['run_id'] as string;
    expect((await api(a, 'POST', `/api/runs/${runId}/pause`, '/api/runs/{id}/pause')).status).toBe(202);
    await withClient(srv.db.url, (c) => c.query("UPDATE apis SET status = 'bloquee' WHERE id = $1", [api1.id]));
    const refused = await api(a, 'POST', `/api/runs/${runId}/resume`, '/api/runs/{id}/resume');
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: 'blocked' } });
    expect(await count('SELECT count(*) FROM runs WHERE id = $1 AND job_id IS NULL AND paused_at IS NOT NULL', [runId])).toBe(1);
    // B met en pause son run sur l'API `instance` de A, puis A la rend privée : B ne la relance plus (404 uniforme).
    const shared = await seedApi(srv.db.url, a.user.id, { visibility: 'instance' });
    const bRun = (await api(b, 'POST', `/api/apis/${shared.slug}/runs`, '/api/apis/{slug}/runs', { input: {} })).body['run_id'] as string;
    expect((await api(b, 'POST', `/api/runs/${bRun}/pause`, '/api/runs/{id}/pause')).status).toBe(202);
    await withClient(srv.db.url, (c) => c.query("UPDATE apis SET visibility = 'private' WHERE id = $1", [shared.id]));
    expect((await api(b, 'POST', `/api/runs/${bRun}/resume`, '/api/runs/{id}/resume')).status).toBe(404);
    expect(await count('SELECT count(*) FROM runs WHERE id = $1 AND job_id IS NULL AND paused_at IS NOT NULL', [bRun])).toBe(1);
  });
});

describe('aperçu des règles résolues (19 § 2, 19b § 2, tâche 2.10)', () => {
  test('GET /api/apis/{slug}/resolved-rules?role= : A voit son ensemble résolu (budget 3000 ou 1000 selon le rôle), B reçoit le 404 uniforme, même sur une API partagée d’instance', async () => {
    const own = await seedApi(srv.db.url, a.user.id, { visibility: 'instance' });
    // Hôte de l'API (demande d'enquête) : la politique par défaut, partagée d'instance (`*`), s'y applique.
    await withClient(srv.db.url, (c) => c.query(`UPDATE apis SET investigation = '{"request": {"url": "https://zz-test-rules.example/", "description": "zz_test", "auto_validate": true, "budget_usd": 1, "timeout_s": 600}, "spent_usd": 0, "elapsed_ms": 0}' WHERE id = $1`, [own.id]));
    const path = '/api/apis/{slug}/resolved-rules';
    const investigate = await api(a, 'GET', `/api/apis/${own.slug}/resolved-rules`, path);
    expect(investigate.status).toBe(200);
    expect(investigate.body).toMatchObject({ role: 'investigate', budget_tokens: 3000, skills_listing_truncated: false });
    expect((investigate.body['rules'] as { name: string; sha256: string }[]).map((r) => r.name)).toContain('escalade-par-defaut');
    expect(JSON.stringify(investigate.body)).not.toContain('Transcription de 04');
    expect((await api(a, 'GET', `/api/apis/${own.slug}/resolved-rules?role=repair`, path)).body).toMatchObject({ role: 'repair', budget_tokens: 3000 });
    expect((await api(a, 'GET', `/api/apis/${own.slug}/resolved-rules?role=embedded`, path)).body).toMatchObject({ role: 'embedded', budget_tokens: 1000 });
    expect((await api(a, 'GET', `/api/apis/${own.slug}/resolved-rules?role=autre`, path)).status).toBe(400);
    const other = await api(b, 'GET', `/api/apis/${own.slug}/resolved-rules`, path);
    expect(other.status).toBe(404);
    expect((await api(b, 'GET', '/api/apis/zz-inexistante/resolved-rules', path)).body).toEqual(other.body);
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

  test('investigate : transition et enquête au MÊME COMMIT ; l’enquête refusée ne laisse jamais l’API en `enquete` sans run', async () => {
    const created = await api(a, 'POST', '/api/apis', '/api/apis', { description: 'zz_test reenquete atomique', url: 'https://zz-test-re-atomic.example/' });
    const apiId = created.body['api_id'] as string;
    const slug = created.body['slug'] as string;
    // Première enquête terminée, API saine ; la demande gardée devient illisible (refusée par startInvestigation).
    await withClient(srv.db.url, async (c) => {
      await c.query("UPDATE runs SET state = 'succeeded', finished_at = now() WHERE api_id = $1", [apiId]);
      await c.query(`UPDATE apis SET status = 'sain', investigation = jsonb_set(investigation, '{request,url}', '"zz-pas-une-url"') WHERE id = $1`, [apiId]);
    });
    const events = await count('SELECT count(*) FROM status_events WHERE api_id = $1', [apiId]);
    const runs = await count('SELECT count(*) FROM runs WHERE api_id = $1', [apiId]);
    const res = await api(a, 'POST', `/api/apis/${slug}/investigate`, '/api/apis/{slug}/investigate', {});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'invalid_request' } });
    expect(await count("SELECT count(*) FROM apis WHERE id = $1 AND status = 'sain'", [apiId])).toBe(1);
    expect(await count('SELECT count(*) FROM status_events WHERE api_id = $1', [apiId])).toBe(events);
    expect(await count('SELECT count(*) FROM runs WHERE api_id = $1', [apiId])).toBe(runs);
    // L'API se lance toujours (aucun 409 investigation_in_progress fantôme).
    await withClient(srv.db.url, (c) => c.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, created_by) VALUES ($1, 1, $2, 'fetch', 'direct', '{}', 'investigation') ON CONFLICT DO NOTHING", [apiId, a.user.id]));
    await withClient(srv.db.url, (c) => c.query('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [apiId]));
    expect((await api(a, 'POST', `/api/apis/${slug}/runs`, '/api/apis/{slug}/runs', { input: {} })).status).toBe(202);
  });

  test('assert_blocked_reinvestigation_human_only : clé d’API sur une API `bloquee` → 403 human_confirmation_required, aucune transition, aucun run (04 § 6, transition 18)', async () => {
    const created = await api(a, 'POST', '/api/apis', '/api/apis', { description: 'zz_test bloquee par cle', url: 'https://zz-test-blocked-key.example/' });
    const apiId = created.body['api_id'] as string;
    const slug = created.body['slug'] as string;
    await withClient(srv.db.url, async (c) => {
      await c.query("UPDATE runs SET state = 'succeeded', finished_at = now() WHERE api_id = $1", [apiId]);
      await c.query("UPDATE apis SET status = 'bloquee', status_reason = 'forbidden' WHERE id = $1", [apiId]);
    });
    const key = (await srv.app.inject({ method: 'POST', url: '/api/api-keys', headers: { cookie: a.cookie, origin: PUBLIC_URL }, payload: { label: 'zz blocked', scopes: ['apis:read', 'apis:write', 'apis:run'], currentPassword: a.user.password } })).json<{ key: string }>().key;
    const events = await count('SELECT count(*) FROM status_events WHERE api_id = $1', [apiId]);
    const runs = await count('SELECT count(*) FROM runs WHERE api_id = $1', [apiId]);
    const res = await srv.app.inject({ method: 'POST', url: `/api/apis/${slug}/investigate`, headers: { authorization: `Bearer ${key}` }, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(contract.check('POST', '/api/apis/{slug}/investigate', 403, res.json())).toEqual([]);
    expect(res.json()).toMatchObject({ error: { code: 'human_confirmation_required' } });
    // `force_investigate` reste refusé par la machine (409 blocked : ne pas réessayer).
    const forced = await srv.app.inject({ method: 'POST', url: `/api/apis/${slug}/runs`, headers: { authorization: `Bearer ${key}` }, payload: { input: {}, force_investigate: true } });
    expect(forced.statusCode).toBe(409);
    expect(forced.json()).toMatchObject({ error: { code: 'blocked' } });
    expect(await count("SELECT count(*) FROM apis WHERE id = $1 AND status = 'bloquee'", [apiId])).toBe(1);
    expect(await count('SELECT count(*) FROM status_events WHERE api_id = $1', [apiId])).toBe(events);
    expect(await count('SELECT count(*) FROM runs WHERE api_id = $1', [apiId])).toBe(runs);
    // Dans la console (session), la ré-enquête manuelle reste permise (transition 18).
    expect((await api(a, 'POST', `/api/apis/${slug}/investigate`, '/api/apis/{slug}/investigate', {})).status).toBe(202);
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
    // assert_version_revert_bounded : version jamais courante (vN+1 de réparation non validée, brouillon) → 400
    // version_not_revertable, rien ne change.
    await withClient(srv.db.url, (c) => c.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, created_by, parent_version) VALUES ($1, 4, $2, 'agent', 'direct', '{}', 'repair', 3)", [api1.id, a.user.id]));
    const notRevertable = await api(a, 'POST', `/api/apis/${api1.slug}/versions/4/revert`, '/api/apis/{slug}/versions/{version}/revert');
    expect(notRevertable.status).toBe(400);
    expect(notRevertable.body).toMatchObject({ error: { code: 'version_not_revertable' } });
    expect(await count('SELECT count(*) FROM strategy_versions WHERE api_id = $1', [api1.id])).toBe(4);
    expect(await count('SELECT current_strategy_version FROM apis WHERE id = $1', [api1.id])).toBe(3);
    expect((await api(a, 'POST', `/api/apis/${api1.slug}/versions/3/revert`, '/api/apis/{slug}/versions/{version}/revert')).body).toMatchObject({ error: { code: 'already_current' } });
    expect(await count('SELECT count(*) FROM strategy_versions WHERE api_id = $1', [api1.id])).toBe(4);
    // Transition refusée par la machine (statut erreur) : ni nouvelle version ni changement de la version courante (INV3).
    const failed = await seedApi(srv.db.url, a.user.id, { status: 'erreur' });
    await withClient(srv.db.url, async (c) => {
      await c.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, created_by, parent_version) VALUES ($1, 2, $2, 'playwright', 'direct', '{}', 'repair', 1)", [failed.id, a.user.id]);
      await c.query('UPDATE apis SET current_strategy_version = 2 WHERE id = $1', [failed.id]);
    });
    expect((await api(a, 'POST', `/api/apis/${failed.slug}/versions/1/revert`, '/api/apis/{slug}/versions/{version}/revert')).body).toMatchObject({ error: { code: 'status_not_runnable' } });
    expect(await count('SELECT count(*) FROM strategy_versions WHERE api_id = $1', [failed.id])).toBe(2);
    expect(await count('SELECT current_strategy_version FROM apis WHERE id = $1', [failed.id])).toBe(2);
  });
});

/** Lots de 1 000 items lus d'avance par le serveur pour un client qui ne lit plus (contre-pression), hors tampons TCP. */
const EXPORT_MAX_READ_AHEAD_BATCHES = 5;

/**
 * Octets que les tampons TCP du noyau peuvent garder entre le serveur et le client (envoi + réception, plafonds de
 * l'autoréglage Linux) : ils ne sont pas dans la mémoire du serveur mais remplissent son avance. 0 hors Linux.
 */
function kernelTcpBufferBytes(): number {
  const max = (name: string) => {
    try {
      return Number(readFileSync(`/proc/sys/net/ipv4/${name}`, 'utf8').trim().split(/\s+/)[2] ?? 0) || 0;
    } catch {
      return 0;
    }
  };
  return max('tcp_rmem') + max('tcp_wmem');
}

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
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const res = await fetch(`${base}/api/datasets/${ds}/items?format=ndjson`, { headers: { cookie: a.cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/x-ndjson/);
      expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="dataset-/);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      reader = res.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      // Client lent : il ne lit plus rien. Le serveur cesse de lire le dataset dès que les tampons du flux sont pleins
      // (contre-pression) : on attend que le compteur de lots se STABILISE (aucune durée fixe : un serveur sans
      // contre-pression lirait les 101 lots, même lentement sur une machine chargée), puis on borne l'avance à quelques lots
      // (~460 Ko chacun : tampons du flux Node, du socket et du client HTTP), loin des 101 lots (~45 Mo) du dataset.
      let readAhead = batches;
      let stableSince = Date.now();
      const deadline = Date.now() + 30_000;
      while (Date.now() - stableSince < 1500 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        if (batches !== readAhead) {
          readAhead = batches;
          stableSince = Date.now();
        }
      }
      let text = new TextDecoder().decode(first.value);
      let bytes = first.value!.byteLength;
      let lines = 0;
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        text += decoder.decode(value, { stream: true });
        const cut = text.lastIndexOf('\n');
        if (cut >= 0) {
          lines += text.slice(0, cut).split('\n').length;
          text = text.slice(cut + 1);
        }
      }
      expect(lines).toBe(total);
      // Avance bornée : quelques lots (tampons du flux Node et du client HTTP), plus ce que les tampons TCP du noyau
      // peuvent contenir. La borne doit rester loin des 101 lots, sinon le test ne prouve rien (tampons à régler).
      const lots = Math.ceil(total / 1000);
      // Plafonnée sous la moitié des lots : sur un noyau aux tampons TCP très larges (exécuteurs Linux : borne brute 90 sur 100),
      // la borne brute ne prouverait rien ; l'avance réelle (7 lots) reste très en dessous.
      const bound = Math.min(EXPORT_MAX_READ_AHEAD_BATCHES + Math.ceil(kernelTcpBufferBytes() / (bytes / lots)), Math.floor(lots / 2) - 1);
      console.info(`assert_export_streaming : ${readAhead} lots lus d'avance (borne ${bound} sur ${lots})`);
      expect(bound).toBeLessThan(lots / 2);
      expect(readAhead).toBeLessThanOrEqual(bound);
      // Lots de 1 000 lus un à un, au fil de la lecture du client : la mémoire du serveur reste bornée par un lot et les
      // tampons du flux, quelle que soit la taille du dataset (~45 Mo ici).
      expect(batches).toBe(Math.ceil(total / 1000) + 1);
    } finally {
      await reader?.cancel().catch(() => undefined);
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

  test('assert_export_resume_after_cut : export interrompu repris par `offset` (lignes complètes reçues) ou `after=<seq>` ; `since` ; `fields` en JSON et NDJSON, `omit` en CSV', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    const items = Array.from({ length: 10 }, (_, i) => ({ title: `zz_${i}`, price: i, note: 'n' }));
    const run = await seedRun(srv.db.url, { apiId: api1.id, ownerId: a.user.id, items });
    const ds = run.datasetId!;
    // Quatre items écrits avant la date de coupure, six après (dates proches : `dataset_items` est partitionnée par date).
    const cutoff = await withClient(srv.db.url, async (c) => {
      await c.query("UPDATE dataset_items SET created_at = CASE WHEN seq < 4 THEN now() - interval '2 minutes' ELSE now() END WHERE dataset_id = $1", [ds]);
      return (await c.query<{ t: string }>("SELECT to_char((now() - interval '1 minute') AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS t")).rows[0]!.t;
    });
    const later = new Date(Date.parse(cutoff) + 3_600_000).toISOString();
    const get = async (query: string) => {
      const res = await fetch(`${base}/api/datasets/${ds}/items?${query}`, { headers: { cookie: a.cookie } });
      expect(res.status, query).toBe(200);
      return res.text();
    };
    const prices = (text: string) => text.trim().split('\n').filter((l) => l !== '').map((l) => (JSON.parse(l) as { price: number }).price);
    // Coupure délibérée au milieu d'une ligne : le client garde ses lignes COMPLÈTES et reprend par `offset`.
    const full = await get('format=ndjson');
    const cut = full.slice(0, full.indexOf('\n', full.indexOf('\n', full.indexOf('\n') + 1) + 1) + 7);
    const received = cut.slice(0, cut.lastIndexOf('\n') + 1);
    const kept = prices(received);
    expect(kept).toEqual([0, 1, 2]);
    const resumed = prices(await get(`format=ndjson&offset=${kept.length}`));
    expect([...kept, ...resumed]).toEqual(items.map((x) => x.price));
    // Même reprise en CSV (en-tête exclu du compte) et par `after=<seq>` (seq du dernier item reçu, 0 pour le premier).
    const csvRest = (await get('format=csv&offset=8')).split('\r\n');
    expect(csvRest.slice(0, 3)).toEqual(['title,price,note', 'zz_8,8,n', 'zz_9,9,n']);
    expect(prices(await get('format=ndjson&after=6'))).toEqual([7, 8, 9]);
    // `since` : seuls les items écrits à partir de la date ; avec `offset`, le compte porte sur la sélection.
    expect(prices(await get(`format=ndjson&since=${cutoff}`))).toEqual([4, 5, 6, 7, 8, 9]);
    expect(prices(await get(`format=ndjson&since=${cutoff}&offset=2`))).toEqual([6, 7, 8, 9]);
    const sinceJson = await api(a, 'GET', `/api/datasets/${ds}/items?since=${cutoff}&limit=100`, '/api/datasets/{id}/items');
    expect(sinceJson.body['items'].map((x: { price: number }) => x.price)).toEqual([4, 5, 6, 7, 8, 9]);
    expect((await api(a, 'GET', `/api/datasets/${ds}/items?since=${later}`, '/api/datasets/{id}/items')).body['items']).toEqual([]);
    // `fields` en JSON et en NDJSON ; `omit` en CSV.
    expect((await api(a, 'GET', `/api/datasets/${ds}/items?fields=title,price&limit=1`, '/api/datasets/{id}/items')).body['items']).toEqual([{ title: 'zz_0', price: 0 }]);
    expect((await get('format=ndjson&fields=title&limit=2')).trim().split('\n').map((l) => JSON.parse(l))).toEqual([{ title: 'zz_0' }, { title: 'zz_1' }]);
    expect((await get('format=csv&omit=price&limit=1')).split('\r\n').slice(0, 2)).toEqual(['title,note', 'zz_0,n']);
    // `offset` illisible → 400.
    expect((await api(a, 'GET', `/api/datasets/${ds}/items?offset=-1`, '/api/datasets/{id}/items')).status).toBe(400);
  });
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
    // Colonnes dans l'ordre DÉCLARÉ du schéma de sortie (title, price, note : 05 § 2, T3), jamais dans l'ordre de jsonb.
    expect(lines[0]).toBe('title,price,note');
    expect(lines[1]).toBe("'=cmd|'/C calc'!A0,-5,'@x");
    expect(lines[2]).toBe("'+1,3.5,'\tTAB");
    expect(lines[3]).toBe("'-2+3,,\"'\rCR\"");
    expect(lines[4]).toBe('"ok, ""quoted""",0,');
    const fields = await srv.app.inject({ method: 'GET', url: `/api/datasets/${run.datasetId}/items?format=csv&fields=note,title`, headers: { cookie: a.cookie } });
    expect(fields.body.split('\r\n')[0]).toBe('note,title');
  });

  test('séparateur `;` (Excel en locale fr ou de) : un déclencheur après un séparateur interne est neutralisé, en colonne non initiale et dans les noms de colonnes', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    // Nom de propriété hostile (repris des clés d'un item à l'enquête) : il devient un nom de colonne.
    const schema = { type: 'object', properties: { title: { type: 'string' }, note: { type: 'string' }, 'k;=1+1': { type: 'string' } } };
    await withClient(srv.db.url, (c) => c.query('UPDATE apis SET output_schema = $2::jsonb, output_columns = $3::text[] WHERE id = $1', [api1.id, JSON.stringify(schema), ['title', 'note', 'k;=1+1']]));
    const run = await seedRun(srv.db.url, {
      apiId: api1.id,
      ownerId: a.user.id,
      items: [{ title: 'ok', note: "x;=cmd|' /C calc'!A0;", 'k;=1+1': 'v' }],
    });
    const res = await srv.app.inject({ method: 'GET', url: `/api/datasets/${run.datasetId}/items?format=csv`, headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(200);
    const lines = res.body.split('\r\n');
    expect(lines[0]).toBe("title,note,k;'=1+1");
    expect(lines[1]).toBe("ok,x;'=cmd|' /C calc'!A0;,v");
    // Découpé comme Excel en locale française (sur `;`, guillemets ignorés au milieu d'un champ) : aucune cellule ne commence
    // par un déclencheur.
    for (const line of lines) expect(line.split(/[;,]/).filter((cell) => /^\s*[=+\-@]/.test(cell))).toEqual([]);
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
    // Flux servi jusqu'à sa fin : un client SSE standard (EventSource) qui se reconnecte avec `Last-Event-ID: end` reçoit
    // 204 No Content, qui l'arrête (jamais un 200 vide suivi d'une reconnexion toutes les 3 s, sans fin).
    const finished = await fetch(`${base}/api/runs/${inv.runId}/events`, { headers: { cookie: a.cookie, 'last-event-id': 'end' } });
    expect(finished.status).toBe(204);
    expect(await finished.text()).toBe('');
    expect(contract.check('GET', '/api/runs/{id}/events', 204, undefined)).toEqual([]);
    expect((await api(b, 'GET', `/api/runs/${inv.runId}/events`, '/api/runs/{id}/events')).status).toBe(404);
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

  test('assert_sse_commit_order : une clôture de run validée APRÈS une plus récente n’est jamais sautée, reprise comprise', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    const slow = await seedRun(srv.db.url, { apiId: api1.id, ownerId: a.user.id, state: 'running' });
    const quick = await seedRun(srv.db.url, { apiId: api1.id, ownerId: a.user.id, state: 'running' });
    const s = await openStream('/api/events', a);
    try {
      await s.waitFor(() => s.raw().includes(': connected'));
      await new Promise((r) => setTimeout(r, 300)); // curseur initial posé
      // Transaction longue (clôture d'un gros dataset) : `finished_at` = son début, validée bien plus tard.
      let commit!: () => void;
      const gate = new Promise<void>((r) => (commit = r));
      let begun!: () => void;
      const started = new Promise<void>((r) => (begun = r));
      const holder = withClient(srv.db.url, async (c) => {
        await c.query('BEGIN');
        await c.query("UPDATE runs SET state = 'succeeded', outcome = 'clean', finished_at = now() WHERE id = $1", [slow.runId]);
        begun();
        await gate;
        await c.query('COMMIT');
      });
      await started;
      await new Promise((r) => setTimeout(r, 50));
      // Clôture plus récente, validée tout de suite ; le flux a largement le temps de la servir avant la première.
      await withClient(srv.db.url, (c) => c.query("UPDATE runs SET state = 'succeeded', outcome = 'clean', finished_at = now() WHERE id = $1", [quick.runId]));
      await new Promise((r) => setTimeout(r, 800));
      commit();
      await holder;
      const finished = () => s.frames.filter((f) => f.event === 'run.finished').map((f) => (JSON.parse(f.data) as { run_id: string }).run_id);
      await s.waitFor(() => finished().includes(slow.runId) && finished().includes(quick.runId));
    } finally {
      await s.close();
    }
  });

  test('assert_sse_identity_revalidated : identité revalidée pendant le flux : clé révoquée ou session fermée → le serveur ferme le flux, plus aucune trame', async () => {
    const created = await srv.app.inject({ method: 'POST', url: '/api/api-keys', headers: { cookie: a.cookie, origin: PUBLIC_URL }, payload: { label: 'zz sse', scopes: ['runs:read'], currentPassword: a.user.password } });
    expect(created.statusCode).toBe(201);
    const key = created.json<{ id: string; key: string }>();
    const viaKey = await openStream('/api/events', null, undefined, { authorization: `Bearer ${key.key}` });
    let viaSession: Awaited<ReturnType<typeof openStream>> | null = null;
    try {
      expect(viaKey.res.status).toBe(200);
      await viaKey.waitFor(() => viaKey.raw().includes(': connected'));
      await new Promise((r) => setTimeout(r, 300));
      expect(viaKey.ended()).toBe(false);
      expect((await api(a, 'DELETE', `/api/api-keys/${key.id}`, '/api/api-keys/{id}')).status).toBe(204);
      await viaKey.waitFor(() => viaKey.ended(), 5000);
      // Session d'interface : déconnexion → le flux ouvert avec elle se ferme aussi.
      const session: Party = { user: a.user, cookie: await signIn(srv, a.user) };
      viaSession = await openStream('/api/events', session);
      await viaSession.waitFor(() => viaSession!.raw().includes(': connected'));
      await new Promise((r) => setTimeout(r, 300));
      expect(viaSession.ended()).toBe(false);
      const out = await srv.app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: { cookie: session.cookie, origin: PUBLIC_URL }, payload: {} });
      expect(out.statusCode).toBeLessThan(300);
      await viaSession.waitFor(() => viaSession!.ended(), 5000);
      // Un événement de l'utilisateur après la fermeture n'est servi à aucun des deux flux.
      const framesBefore = viaKey.frames.length + viaSession.frames.length;
      const api1 = await seedApi(srv.db.url, a.user.id);
      await seedRun(srv.db.url, { apiId: api1.id, ownerId: a.user.id, items: [{ title: 'zz' }] });
      await new Promise((r) => setTimeout(r, 400));
      expect(viaKey.frames.length + viaSession.frames.length).toBe(framesBefore);
    } finally {
      await viaKey.close();
      await viaSession?.close();
    }
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

  test('entrée hors input_schema de l’API → 400 invalid_input à la création et à la modification (jamais un run planifié voué à l’échec)', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    const before = await count('SELECT count(*) FROM schedules WHERE api_id = $1', [api1.id]);
    for (const input of [{ page: 0 }, { zz_inconnu: 1 }]) {
      const refused = await api(a, 'POST', `/api/apis/${api1.slug}/schedules`, '/api/apis/{slug}/schedules', { cron: '0 3 * * *', timezone: 'UTC', input });
      expect(refused.status, JSON.stringify(input)).toBe(400);
      expect(refused.body).toMatchObject({ error: { code: 'invalid_input' } });
    }
    expect(await count('SELECT count(*) FROM schedules WHERE api_id = $1', [api1.id])).toBe(before);
    const created = await api(a, 'POST', `/api/apis/${api1.slug}/schedules`, '/api/apis/{slug}/schedules', { cron: '0 3 * * *', timezone: 'UTC', input: { page: 2 } });
    expect(created.status).toBe(201);
    const path = `/api/apis/${api1.slug}/schedules/${created.body['id']}`;
    const patched = await api(a, 'PATCH', path, '/api/apis/{slug}/schedules/{id}', { input: { page: -1 } });
    expect(patched.status).toBe(400);
    expect(patched.body).toMatchObject({ error: { code: 'invalid_input' } });
    expect((await api(a, 'GET', path, '/api/apis/{slug}/schedules/{id}')).body).toMatchObject({ input: { page: 2 } });
    expect((await api(a, 'DELETE', path, '/api/apis/{slug}/schedules/{id}')).status).toBe(204);
  });

  test('planification de B sur l’API `instance` de A redevenue privée : B la lit, la désactive et la supprime ; rien d’autre (404 sinon)', async () => {
    const shared = await seedApi(srv.db.url, a.user.id, { visibility: 'instance' });
    const created = await api(b, 'POST', `/api/apis/${shared.slug}/schedules`, '/api/apis/{slug}/schedules', { cron: '0 4 * * *', timezone: 'UTC', input: {} });
    expect(created.status).toBe(201);
    const id = created.body['id'] as string;
    await withClient(srv.db.url, (c) => c.query("UPDATE apis SET visibility = 'private' WHERE id = $1", [shared.id]));
    const path = `/api/apis/${shared.slug}/schedules/${id}`;
    expect((await api(b, 'GET', path, '/api/apis/{slug}/schedules/{id}')).body).toMatchObject({ id, api_slug: shared.slug });
    // Seule la désactivation passe : modifier le cron ou réactiver relancerait l'API d'autrui.
    expect((await api(b, 'PATCH', path, '/api/apis/{slug}/schedules/{id}', { cron: '0 5 * * *' })).status).toBe(404);
    expect((await api(b, 'PATCH', path, '/api/apis/{slug}/schedules/{id}', { enabled: true })).status).toBe(404);
    expect((await api(b, 'PATCH', path, '/api/apis/{slug}/schedules/{id}', { enabled: false })).body).toMatchObject({ id, enabled: false });
    // Un autre membre (ni A, propriétaire de l'API, par ce chemin) ne voit pas la planification de B.
    expect((await api(a, 'GET', path, '/api/apis/{slug}/schedules/{id}')).status).toBe(404);
    expect((await api(b, 'DELETE', path, '/api/apis/{slug}/schedules/{id}')).status).toBe(204);
    expect(await count('SELECT count(*) FROM schedules WHERE id = $1', [id])).toBe(0);
  });
});

describe('webhooks (Standard Webhooks, 08 § 5) : garde SSRF, secret rendu une fois, rotation, test signé', () => {
  test('création, test, rotation, désactivation, suppression ; URL interdite → 400 ssrf_blocked', async () => {
    const api1 = await seedApi(srv.db.url, a.user.id);
    const target = `http://127.0.0.1:${hookPort}/zz-test-hook`;
    expect((await api(a, 'POST', '/api/webhook-subscriptions', '/api/webhook-subscriptions', { url: 'http://169.254.169.254/latest', events: ['run.failed'] })).body).toMatchObject({ error: { code: 'ssrf_blocked' } });
    // URL illisible (sans schéma) : 400, jamais 500, et la valeur saisie n'est pas recopiée.
    const unreadable = await api(a, 'POST', '/api/webhook-subscriptions', '/api/webhook-subscriptions', { url: 'hooks.example.test/zz_test_hook_token', events: ['run.failed'] });
    expect(unreadable.status).toBe(400);
    expect(unreadable.body).toMatchObject({ error: { code: 'invalid_webhook' } });
    expect(unreadable.raw.body).not.toContain('zz_test_hook_token');
    const created = await api(a, 'POST', '/api/webhook-subscriptions', '/api/webhook-subscriptions', { url: target, events: ['run.failed', 'api.status_changed'], api_slug: api1.slug });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ api_slug: api1.slug, status: 'active', secret: expect.stringMatching(/^whsec_/) });
    const id = created.body['id'] as string;
    expect((await api(a, 'PATCH', `/api/webhook-subscriptions/${id}`, '/api/webhook-subscriptions/{id}', { url: 'not a url' })).body).toMatchObject({ error: { code: 'invalid_webhook' } });
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

  test('secret lié à sa destination : changer l’URL fait tourner le secret (rendu une fois) ; l’ancien ne signe plus rien vers la nouvelle URL', async () => {
    const created = await api(a, 'POST', '/api/webhook-subscriptions', '/api/webhook-subscriptions', { url: `http://127.0.0.1:${hookPort}/zz-test-hook-old`, events: ['run.failed'] });
    expect(created.status).toBe(201);
    const id = created.body['id'] as string;
    const moved = await api(a, 'PATCH', `/api/webhook-subscriptions/${id}`, '/api/webhook-subscriptions/{id}', { url: `http://127.0.0.1:${hookPort}/zz-test-hook-new` });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ url: `http://127.0.0.1:${hookPort}/zz-test-hook-new`, secret: expect.stringMatching(/^whsec_/) });
    expect(moved.body['secret']).not.toBe(created.body['secret']);
    // Aucune période de grâce vers la nouvelle destination : une seule signature, celle du nouveau secret.
    expect((await api(a, 'POST', `/api/webhook-subscriptions/${id}/test`, '/api/webhook-subscriptions/{id}/test')).body).toMatchObject({ ok: true });
    const signatures = String(hookCalls.at(-1)!.headers['webhook-signature']).split(' ');
    expect(signatures).toHaveLength(1);
    // Même URL (ou autre champ) : le secret ne tourne pas.
    const same = await api(a, 'PATCH', `/api/webhook-subscriptions/${id}`, '/api/webhook-subscriptions/{id}', { events: ['run.failed', 'api.status_changed'] });
    expect(same.body).not.toHaveProperty('secret');
    expect((await api(a, 'DELETE', `/api/webhook-subscriptions/${id}`, '/api/webhook-subscriptions/{id}')).status).toBe(204);
  });
});

describe('réglages de l’admin (08 § 1, § 2, § 7) : secrets en écriture seule (INV8), assert_write_only_secret_bound_to_destination', () => {
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
    // Secret lié à sa destination (INV8) : même fournisseur, autre base_url, sans clé → 400 ; la clé gardée ne part jamais
    // vers la nouvelle URL (« Tester » vise toujours l'ancienne), aucune requête n'atteint la cible de l'attaquant.
    const evil = `http://127.0.0.1:${hookPort}/v1`;
    const before = hookCalls.length;
    const moved = await api(admin, 'PUT', '/api/settings/llm', '/api/settings/llm', { providers: [{ id: 'zz-local', preset: 'custom', base_url: evil }] });
    expect(moved.status).toBe(400);
    expect(moved.body).toMatchObject({ error: { code: 'api_key_required' } });
    expect((await api(admin, 'GET', '/api/settings/llm', '/api/settings/llm')).body['providers'][0]).toMatchObject({ id: 'zz-local', base_url: 'http://127.0.0.1:9/v1', api_key_set: true });
    await api(admin, 'POST', '/api/settings/llm/test', '/api/settings/llm/test', { provider: 'zz-local', model: 'zz-model' });
    expect(hookCalls.slice(before)).toEqual([]);
    // Destination changée AVEC une clé ressaisie : accepté (la nouvelle clé remplace l'ancienne).
    const rekeyed = await api(admin, 'PUT', '/api/settings/llm', '/api/settings/llm', { providers: [{ id: 'zz-local', preset: 'custom', base_url: 'http://127.0.0.1:9/v2', api_key: 'zz_test_llm_key_rekeyed_0123' }] });
    expect(rekeyed.status).toBe(200);
    expect(await count("SELECT count(*) FROM secrets WHERE kind = 'llm_api_key' AND owner_id IS NULL")).toBe(1);
    const probe = await api(admin, 'POST', '/api/settings/llm/test', '/api/settings/llm/test', { provider: 'zz-local', model: 'zz-model' });
    expect(probe.body).toMatchObject({ ok: false, profile: null, error: { code: expect.stringMatching(/^llm_/) } });
    expect((await api(admin, 'POST', '/api/settings/llm/test', '/api/settings/llm/test', { provider: 'zz-absent', model: 'm' })).status).toBe(404);
    expect((await api(a, 'GET', '/api/settings/llm', '/api/settings/llm')).status).toBe(403);
  });

  test('UX-17 — le prix d’un modèle survit à toute écriture de settings.llm qui ne le mentionne pas ; seul price: null le retire', async () => {
    const price = { in: 5, out: 25, in_cached: 0.5 };
    const profile = { tools: true, tool_choice: ['auto'], structured: 'json_schema', cache: false };
    const provider = { id: 'zz-price', preset: 'custom', base_url: 'http://127.0.0.1:9/v1', api_key: 'zz_test_llm_key_price_0123456789' };
    const modelsOf = async () => ((await api(admin, 'GET', '/api/settings/llm', '/api/settings/llm')).body['providers'] as { id: string; models: Record<string, Record<string, unknown>> }[]).find((p) => p.id === 'zz-price')?.models;
    expect((await api(admin, 'PUT', '/api/settings/llm', '/api/settings/llm', { providers: [{ ...provider, models: { 'claude-opus-4-8': { price } } }] })).status).toBe(200);
    expect(await modelsOf()).toEqual({ 'claude-opus-4-8': { price } });
    // Console au GET périmé, ou script qui ne pose que le profil : la requête ne parle pas du prix, le prix reste.
    const { api_key: _key, ...keep } = provider;
    expect((await api(admin, 'PUT', '/api/settings/llm', '/api/settings/llm', { providers: [{ ...keep, models: { 'claude-opus-4-8': { profile } } }] })).status).toBe(200);
    expect(await modelsOf()).toEqual({ 'claude-opus-4-8': { price, profile } });
    // Une requête sans `models` ne touche à rien (déjà le cas) ; une requête qui change le prix le remplace.
    expect((await api(admin, 'PUT', '/api/settings/llm', '/api/settings/llm', { providers: [keep] })).status).toBe(200);
    expect(await modelsOf()).toEqual({ 'claude-opus-4-8': { price, profile } });
    expect((await api(admin, 'PUT', '/api/settings/llm', '/api/settings/llm', { providers: [{ ...keep, models: { 'claude-opus-4-8': { price: { in: 4, out: 20 } } } }] })).status).toBe(200);
    expect(await modelsOf()).toEqual({ 'claude-opus-4-8': { price: { in: 4, out: 20 }, profile } });
    // Retrait explicite.
    expect((await api(admin, 'PUT', '/api/settings/llm', '/api/settings/llm', { providers: [{ ...keep, models: { 'claude-opus-4-8': { price: null } } }] })).status).toBe(200);
    expect(await modelsOf()).toEqual({ 'claude-opus-4-8': { profile } });
    // Restaure l'état attendu par les tests suivants (aucun fournisseur de ce test).
    await api(admin, 'PUT', '/api/settings/llm', '/api/settings/llm', { providers: [] });
  });

  test('revue fix-ux-11 — known_prices en lecture seule (forme KnownModelPrice) ; prix fermé (>= 0) ; models[m]: null retire ; table bornée à 50', async () => {
    const got = await api(admin, 'GET', '/api/settings/llm', '/api/settings/llm');
    expect(got.status).toBe(200);
    const known = got.body['known_prices'] as { model: string; provider: string; status: string; price: { in: number; out: number; in_cached?: number } | null; source: string }[];
    expect(known.length).toBeGreaterThan(0);
    for (const entry of known) {
      expect(['verified', 'to_validate']).toContain(entry.status);
      expect(typeof entry.model).toBe('string');
      expect(typeof entry.source).toBe('string');
      if (entry.status === 'verified') expect(entry.price).toMatchObject({ in: expect.any(Number), out: expect.any(Number) });
      else expect(entry.price).toBeNull();
    }
    // Lecture seule : une écriture qui renvoie known_prices est refusée.
    expect((await api(admin, 'PUT', '/api/settings/llm', '/api/settings/llm', { providers: [], known_prices: [] })).status).toBe(400);
    const provider = { id: 'zz-closed', preset: 'custom', base_url: 'http://127.0.0.1:9/v1', api_key: 'zz_test_llm_key_closed_0123456789' };
    const put = (models: Record<string, unknown>, withKey = true) => {
      const { api_key: _key, ...keep } = provider;
      return api(admin, 'PUT', '/api/settings/llm', '/api/settings/llm', { providers: [{ ...(withKey ? provider : keep), models }] });
    };
    const modelsOf = async () => ((await api(admin, 'GET', '/api/settings/llm', '/api/settings/llm')).body['providers'] as { id: string; models: Record<string, unknown> }[]).find((p) => p.id === 'zz-closed')?.models ?? {};
    // Prix fermé : négatif, sans `out`, clé inconnue.
    expect((await put({ m: { price: { in: -1, out: 2 } } })).status).toBe(400);
    expect((await put({ m: { price: { in: 1 } } })).status).toBe(400);
    expect((await put({ m: { price: { in: 1, out: 2, zz: 1 } } })).status).toBe(400);
    expect((await put({ m: { price: { in: 0, out: 0 } } })).status).toBe(200);
    // Retrait d'un modèle entier.
    expect((await put({ n: { price: { in: 1, out: 2 } } }, false)).status).toBe(200);
    expect(Object.keys(await modelsOf()).sort()).toEqual(['m', 'n']);
    expect((await put({ m: null }, false)).status).toBe(200);
    expect(Object.keys(await modelsOf())).toEqual(['n']);
    // La table fusionnée reste bornée à 50.
    const fifty = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`zz-m${i}`, { price: { in: 1, out: 2 } }]));
    expect((await put(fifty, false)).status).toBe(400);
    expect(Object.keys(await modelsOf())).toEqual(['n']);
    await api(admin, 'PUT', '/api/settings/llm', '/api/settings/llm', { providers: [] });
  });

  test('sonde « Tester » LLM pendant un changement de fournisseur : le profil relevé n’écrase jamais la nouvelle destination ni sa clé', async () => {
    // Fournisseur lent : la première requête de la sonde attend qu'on la libère ; chaque réponse est un 400 (paramètre non
    // supporté), donc la sonde aboutit et veut écrire son profil.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const firstRequest = new Promise<void>((resolve) => (reached = resolve));
    const slow = createServer((req, res) => {
      req.resume();
      reached();
      void gate.then(() => res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'unsupported', type: 'invalid_request_error' } })));
    });
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/v1`;
      const put = await api(admin, 'PUT', '/api/settings/llm', '/api/settings/llm', { providers: [{ id: 'zz-race', preset: 'custom', base_url: base, api_key: 'zz_test_llm_key_race_old_0123', models: { 'zz-model': {} } }] });
      expect(put.status).toBe(200);
      const probe = api(admin, 'POST', '/api/settings/llm/test', '/api/settings/llm/test', { provider: 'zz-race', model: 'zz-model' });
      await firstRequest;
      // Pendant la sonde, l'admin déplace le fournisseur avec une clé ressaisie (l'ancien secret est supprimé).
      const moved = await api(admin, 'PUT', '/api/settings/llm', '/api/settings/llm', { providers: [{ id: 'zz-race', preset: 'custom', base_url: 'http://127.0.0.1:9/v3', api_key: 'zz_test_llm_key_race_new_0123', models: { 'zz-model': {} } }] });
      expect(moved.status).toBe(200);
      release();
      expect((await probe).status).toBe(200);
      const view = (await api(admin, 'GET', '/api/settings/llm', '/api/settings/llm')).body['providers'] as Record<string, unknown>[];
      expect(view.find((p) => p['id'] === 'zz-race')).toMatchObject({ base_url: 'http://127.0.0.1:9/v3', api_key_set: true, api_key_unreadable: false });
      const stored = await withClient(srv.db.url, async (c) => (await c.query<{ value: { providers: { id: string; api_key_secret_id: string; models?: Record<string, { profile?: unknown }> }[] } }>("SELECT value FROM settings WHERE key = 'llm'")).rows[0]!.value);
      const race = stored.providers.find((p) => p.id === 'zz-race')!;
      expect(await count('SELECT count(*) FROM secrets WHERE id = $1', [race.api_key_secret_id])).toBe(1);
      // Le profil relevé sur l'ancienne destination n'est pas attribué à la nouvelle.
      expect(race.models?.['zz-model']?.profile).toBeUndefined();
    } finally {
      release();
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
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
      // Identifiants liés au proxy (INV8) : une autre URL sans identifiants ressaisis → 400, rien ne change ; la même URL passe.
      const moved = await api(admin, 'PATCH', `/api/settings/proxies/${id}`, '/api/settings/proxies/{id}', { url: `http://127.0.0.1:${hookPort}` });
      expect(moved.status).toBe(400);
      expect(moved.body).toMatchObject({ error: { code: 'credentials_required' } });
      expect((await api(admin, 'GET', `/api/settings/proxies/${id}`, '/api/settings/proxies/{id}')).body).toMatchObject({ url: `http://127.0.0.1:${port}` });
      expect((await api(admin, 'PATCH', `/api/settings/proxies/${id}`, '/api/settings/proxies/{id}', { url: `http://127.0.0.1:${port}/` })).status).toBe(200);
      const rehomed = await api(admin, 'PATCH', `/api/settings/proxies/${id}`, '/api/settings/proxies/{id}', { url: `http://127.0.0.1:${hookPort}`, username: 'zz_user', password: 'zz_test_proxy_password_2' });
      expect(rehomed.body).toMatchObject({ url: `http://127.0.0.1:${hookPort}`, password_set: true });
      expect((await api(admin, 'PATCH', `/api/settings/proxies/${id}`, '/api/settings/proxies/{id}', { url: `http://127.0.0.1:${port}`, username: 'zz_user', password: 'zz_test_proxy_password' })).status).toBe(200);
      expect(await count("SELECT count(*) FROM secrets WHERE kind = 'proxy'")).toBe(1);
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

  test('SMTP : mot de passe jamais relu, conservé si absent pour le même relais, exigé si l’hôte ou le port change ; test sans relais → échec lisible', async () => {
    const put = await api(owner, 'PUT', '/api/settings/smtp', '/api/settings/smtp', { host: '127.0.0.1', port: 9, security: 'starttls', from: 'zz_test@example.test', username: 'zz_user', password: 'zz_test_smtp_password' });
    expect(put.body).toMatchObject({ host: '127.0.0.1', username_set: true, password_set: true, tested_at: null });
    // Même relais, même identifiant, sans mot de passe : gardé.
    const again = await api(owner, 'PUT', '/api/settings/smtp', '/api/settings/smtp', { host: '127.0.0.1', port: 9, security: 'tls', from: 'zz_test_2@example.test', username: 'zz_user' });
    expect(again.body).toMatchObject({ port: 9, security: 'tls', password_set: true });
    // Autre port, ou autre hôte, sans mot de passe : 400 password_required (le mot de passe ne part jamais vers un autre relais).
    for (const target of [{ host: '127.0.0.1', port: 10 }, { host: 'localhost', port: 9 }]) {
      const moved = await api(admin, 'PUT', '/api/settings/smtp', '/api/settings/smtp', { ...target, security: 'starttls', from: 'zz_test@example.test', username: 'zz_user' });
      expect(moved.status).toBe(400);
      expect(moved.body).toMatchObject({ error: { code: 'password_required' } });
    }
    expect((await api(owner, 'GET', '/api/settings/smtp', '/api/settings/smtp')).body).toMatchObject({ host: '127.0.0.1', port: 9 });
    expect(await count("SELECT count(*) FROM secrets WHERE kind = 'smtp_password'")).toBe(1);
    expect((await api(owner, 'GET', '/api/settings/smtp', '/api/settings/smtp')).raw.body).not.toContain('zz_test_smtp_password');
    const tested = await api(owner, 'POST', '/api/settings/smtp/test', '/api/settings/smtp/test', { to: 'zz_test@example.test' });
    expect(tested.body).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^smtp_/) } });
  });

  test('modèles IA : deux PUT concurrents se suivent ; le réglage écrit ne pointe jamais vers une clé supprimée par l’autre', async () => {
    const provider = { id: 'zz-concurrent', preset: 'custom', base_url: 'http://127.0.0.1:9/v1', models: { 'zz-model': {} } };
    expect((await api(admin, 'PUT', '/api/settings/llm', '/api/settings/llm', { providers: [{ ...provider, api_key: 'zz_test_llm_key_concurrent_k0' }] })).status).toBe(200);
    const lockWaiters = () => count("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    const waitLocks = async (n: number) => {
      const deadline = Date.now() + 10_000;
      while ((await lockWaiters()) < n) {
        if (Date.now() > deadline) throw new Error(`attente de ${n} verrous dépassée`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    // La ligne `llm` est tenue : A (nouvelle clé kA) puis B (clé gardée) arrivent l'un après l'autre et attendent.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const holding = new Promise<void>((r) => (locked = r));
    const holder = withClient(srv.db.url, async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT 1 FROM settings WHERE key = 'llm' FOR UPDATE");
      locked();
      await held;
      await c.query('COMMIT');
    });
    await holding;
    try {
      const putA = api(admin, 'PUT', '/api/settings/llm', '/api/settings/llm', { providers: [{ ...provider, api_key: 'zz_test_llm_key_concurrent_ka' }] });
      await waitLocks(1);
      const putB = api(admin, 'PUT', '/api/settings/llm', '/api/settings/llm', { providers: [provider] });
      await waitLocks(2);
      release();
      expect((await putA).status).toBe(200);
      expect((await putB).status).toBe(200);
    } finally {
      release();
      await holder;
    }
    const stored = await withClient(srv.db.url, async (c) => (await c.query<{ value: { providers: { id: string; api_key_secret_id: string }[] } }>("SELECT value FROM settings WHERE key = 'llm'")).rows[0]!.value);
    const keyId = stored.providers.find((p) => p.id === 'zz-concurrent')!.api_key_secret_id;
    // B a lu l'état écrit par A : il garde kA (jamais k0, supprimée par A) ; aucun secret orphelin.
    expect(await count('SELECT count(*) FROM secrets WHERE id = $1', [keyId])).toBe(1);
    expect(await count("SELECT count(*) FROM secrets WHERE kind = 'llm_api_key' AND owner_id IS NULL")).toBe(1);
    expect((await api(admin, 'PUT', '/api/settings/llm', '/api/settings/llm', { providers: [] })).status).toBe(200);
    expect(await count("SELECT count(*) FROM secrets WHERE kind = 'llm_api_key' AND owner_id IS NULL")).toBe(0);
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

// Portabilité (tâche 3.12) : contrat de l'export, de l'aperçu d'import et de l'OpenAPI par API. Les cas détaillés
// (assert_export_no_secret, import par l'enquête, modèles) sont dans portability.integration.test.ts.
describe('portabilité (3.12) : export, aperçu d’import, OpenAPI par API au contrat', () => {
  test('GET export → POST import (aperçu, rien d’écrit) → GET openapi.json', async () => {
    const seeded = await seedApi(srv.db.url, a.user.id);
    await withClient(srv.db.url, (c) =>
      c.query('UPDATE apis SET investigation = $2::jsonb, input_schema = $3::jsonb WHERE id = $1', [
        seeded.id,
        JSON.stringify({ request: { url: 'https://zz-test-port.example/liste', description: 'zz_test liste', auto_validate: false, budget_usd: 1, timeout_s: 600 }, spent_usd: 0, elapsed_ms: 0 }),
        JSON.stringify({ type: 'object', additionalProperties: false, properties: {} }),
      ]),
    );
    const exported = await api(a, 'GET', `/api/apis/${seeded.slug}/export`, '/api/apis/{slug}/export');
    expect(exported.status).toBe(200);
    const apis = await count('SELECT count(*) FROM apis');
    const preview = await api(a, 'POST', '/api/apis/import', '/api/apis/import', exported.body);
    expect(preview).toMatchObject({ status: 200, body: { preview: true, ignored_fields: [] } });
    expect(await count('SELECT count(*) FROM apis')).toBe(apis);
    expect((await api(a, 'GET', `/api/apis/${seeded.slug}/openapi.json`, '/api/apis/{slug}/openapi.json')).status).toBe(200);
  });
});

describe('agent instruit (2.13, 19 § 4) : confirmation humaine des étapes instruites, opt-in explicite — assert_instructed_mode_explicit', () => {
  test('fiche : étapes instruites et empreinte ; activation sans confirmation → 409 ; clé d’API → 403 human_confirmation_required ; empreinte changée → 409 ; confirmé depuis la console → activable, puis désactivable', async () => {
    const seeded = await seedApi(srv.db.url, a.user.id);
    const steps = [{ id: 's1', intent: 'Ouvrir la liste des vélos', post: [{ kind: 'url_changed' }] }];
    const checked = validateInstructedSteps(steps);
    if (!checked.ok) throw new Error('étapes instruites invalides');
    const sha = instructedStepsSha256(checked.steps);
    await withClient(srv.db.url, (c) =>
      c.query("UPDATE strategy_versions SET compilable = 'no', instructed_steps = $2::jsonb, instructed_steps_sha256 = $3 WHERE api_id = $1 AND version = 1", [seeded.id, JSON.stringify(steps), sha]),
    );
    const detail = await api(a, 'GET', `/api/apis/${seeded.slug}`, '/api/apis/{slug}');
    expect(detail.body).toMatchObject({ instructed_mode: false, instructed: { version: 1, compilable: 'no', sha256: sha, confirmed_by: null, steps: [{ id: 's1', intent: 'Ouvrir la liste des vélos' }] } });
    // Un membre qui lit l'API instance d'autrui ne reçoit jamais les étapes instruites (propriétaire seul).
    const shared = await seedApi(srv.db.url, a.user.id, { visibility: 'instance' });
    const seen = await api(b, 'GET', `/api/apis/${shared.slug}`, '/api/apis/{slug}');
    expect(seen.body).not.toHaveProperty('instructed');

    const unconfirmed = await api(a, 'PUT', `/api/apis/${seeded.slug}/instructed-mode`, '/api/apis/{slug}/instructed-mode', { enabled: true });
    expect(unconfirmed).toMatchObject({ status: 409, body: { error: { code: 'instructed_steps_unconfirmed' } } });

    const key = (await srv.app.inject({ method: 'POST', url: '/api/api-keys', headers: { cookie: a.cookie, origin: PUBLIC_URL }, payload: { label: 'zz instruit', scopes: ['apis:read', 'apis:write'], currentPassword: a.user.password } })).json<{ key: string }>().key;
    const viaKey = await srv.app.inject({ method: 'POST', url: `/api/apis/${seeded.slug}/instructed-steps/confirm`, headers: { authorization: `Bearer ${key}` }, payload: { version: 1, sha256: sha } });
    expect(viaKey.statusCode).toBe(403);
    expect(contract.check('POST', '/api/apis/{slug}/instructed-steps/confirm', 403, viaKey.json())).toEqual([]);
    expect(viaKey.json()).toMatchObject({ error: { code: 'human_confirmation_required' } });

    const stale = await api(a, 'POST', `/api/apis/${seeded.slug}/instructed-steps/confirm`, '/api/apis/{slug}/instructed-steps/confirm', { version: 1, sha256: 'a'.repeat(64) });
    expect(stale).toMatchObject({ status: 409, body: { error: { code: 'sha_mismatch' } } });
    expect(await count("SELECT count(*) FROM strategy_versions WHERE api_id = $1 AND instructed_steps_confirmed IS NOT NULL", [seeded.id])).toBe(0);

    const confirmed = await api(a, 'POST', `/api/apis/${seeded.slug}/instructed-steps/confirm`, '/api/apis/{slug}/instructed-steps/confirm', { version: 1, sha256: sha });
    expect(confirmed).toMatchObject({ status: 200, body: { instructed_mode: false, instructed: { confirmed_by: a.user.id } } });
    const enabled = await api(a, 'PUT', `/api/apis/${seeded.slug}/instructed-mode`, '/api/apis/{slug}/instructed-mode', { enabled: true });
    expect(enabled).toMatchObject({ status: 200, body: { instructed_mode: true } });
    const disabled = await api(a, 'PUT', `/api/apis/${seeded.slug}/instructed-mode`, '/api/apis/{slug}/instructed-mode', { enabled: false });
    expect(disabled).toMatchObject({ status: 200, body: { instructed_mode: false } });

    // API compilable (une stratégie rejouable sans agent existe) : jamais activable.
    const compilable = await seedApi(srv.db.url, a.user.id);
    const refused = await api(a, 'PUT', `/api/apis/${compilable.slug}/instructed-mode`, '/api/apis/{slug}/instructed-mode', { enabled: true });
    expect(refused.status).toBe(409);
    expect(await count('SELECT count(*) FROM apis WHERE id = $1 AND instructed_mode', [compilable.id])).toBe(0);
  });
});

describe('assert_rest_endpoints_contract : chaque endpoint livré par 3.1 a des réponses contrôlées au contrat', () => {
  test('couverture', () => {
    // Routes livrées par 3.1 : le bloc du registre qui commence à GET /api/openapi.json (aucune liste à tenir à la main).
    const first = ROUTES.findIndex((r) => r.method === 'GET' && r.url === '/api/openapi.json');
    expect(first).toBeGreaterThan(0);
    const delivered31 = ROUTES.slice(first).filter((r) => !r.mcp).map((r) => `${r.method} ${r.url.replace(/:(\w+)/g, '{$1}')}`);
    expect(delivered31).toEqual(expect.arrayContaining(['GET /api/events', 'GET /api/runs/{id}/events', 'POST /api/me/responsible-use']));
    const covered = [...contract.covered].map((c) => c.split(' ').slice(0, 2).join(' '));
    const successes = [...contract.covered].filter((c) => /\s2\d\d$/.test(c)).map((c) => c.split(' ').slice(0, 2).join(' '));
    expect(delivered31.filter((op) => !covered.includes(op))).toEqual([]);
    expect(delivered31.filter((op) => !successes.includes(op))).toEqual([]);
  });

  test('chaque route que la garde peut refuser (session seule, scope, permission) déclare 403 dans l’OpenAPI servie', () => {
    const missing = ROUTES.filter((r) => r.auth !== 'public' && !r.library && !r.mcp && (r.auth === 'session' || r.auth === 'extension' || r.scope !== undefined || r.permission !== undefined))
      .map((r) => `${r.method} ${r.url.replace(/:(\w+)/g, '{$1}')}`)
      .filter((op) => {
        const [method, path] = op.split(' ');
        return contract.check(method!, path!, 403, { error: { code: 'forbidden', message: 'zz' } }).length > 0;
      });
    expect(missing).toEqual([]);
  });
});
