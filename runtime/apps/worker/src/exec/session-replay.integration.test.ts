// SPDX-License-Identifier: AGPL-3.0-only
// A2 de bout en bout sur base réelle : une API `requires_session` dont le propriétaire a consenti l'usage serveur s'exécute
// sur le serveur, SANS navigateur ni tunnel, avec le Cookie de son propriétaire (E1, lecture). Le serveur HTTP local
// enregistre ce qu'il reçoit. INV5 (propriétaire seul), INV8 (aucune valeur dans les traces), INV10 (cadence, SSRF).
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DomainPacer, generateMasterKey, kekFor, MasterKey, secretValues, type RunExecutor } from '@runtime/core';
import * as net from '@runtime/core/net';
import { connectSite, createRun, keyCheck, migrateUp, PgBossJobQueue, PgPacingStore, readRun, runQueueDefinition, siteCookiesForRun, storeSiteCookies, withActor } from '@runtime/db';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { fixtureGuard } from '../../../../tests/helpers/fixture-net.ts';
import { createTestDatabase, type TestDatabase } from '../../../../tests/helpers/pg.js';
import { loadWorkerConfig } from '../config.js';
import { startWorker, type Worker } from '../worker.js';
import { createStrategyExecutor } from './strategy-executor.js';

const SESSION_HOST = 'zz-sess-api.example.test';
const OTHER_HOST = 'zz-sess-other.example.test';
const COOKIE_VALUE = 'zz_test_session_cookie_value_7f3a';
const A = randomUUID();
const B = randomUUID();
const actorB = { userId: B, role: 'member' as const };
const actorA = { userId: A, role: 'member' as const };

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let worker: Worker;
let port = 0;
const received: { host: string; path: string; cookie: string | undefined; at: number }[] = [];
const server = createServer((req, res) => {
  received.push({ host: (req.headers.host ?? '').split(':')[0]!, path: req.url ?? '', cookie: req.headers.cookie, at: Date.now() });
  if (req.url?.startsWith('/leave')) {
    res.writeHead(302, { location: `http://${OTHER_HOST}:${port}/landing` }).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ items: [{ id: 'a1', name: 'Alpha' }, { id: 'a2', name: 'Beta' }] }));
});

const SCHEMA = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' } }, additionalProperties: false };
const specFor = (host: string, path = '/api/items', allowed = [host]) => ({
  schema_version: 1,
  kind: 'declarative',
  request: { method: 'GET', url: `http://${host}:${port}${path}`, allowed_hosts: allowed },
  sources: [{ id: 'api', from: 'response', records: '$.items[*]' }],
  fields: { id: { path: '$.id', type: 'string', required: true }, name: { path: '$.name', type: 'string', required: true } },
});

async function insertApi(owner: string, slug: string, spec: unknown, pacing = '{"min_delay_ms": 5, "max_requests_per_run": 50, "max_wait_ms": 60000}'): Promise<string> {
  const id = (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, output_schema, domain_pacing, requires_session, requires) VALUES ($1, $2, $3, $4, true, $5) RETURNING id`,
      [slug, owner, JSON.stringify(SCHEMA), pacing, JSON.stringify({ session_domain: SESSION_HOST })],
    )
  ).rows[0]!.id;
  // Stratégie « tunnel » comme l'enquête la produit aujourd'hui pour une API à session.
  await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, est_cost_usd, created_by) VALUES ($1, 1, $2, 'fetch', 'tunnel', $3, 0, 'user')", [id, owner, JSON.stringify(spec)]);
  await pool.query('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [id]);
  return id;
}

async function connect(owner: string, cookies: object[], serverUse = true): Promise<void> {
  await connectSite(pool, { ownerId: owner, domain: SESSION_HOST, serverUseAllowed: serverUse });
  if (serverUse) await storeSiteCookies(pool, kek, { ownerId: owner, domain: SESSION_HOST, cookies: cookies as never });
}
let kek: ReturnType<typeof kekFor>;

const cookie = (over: object = {}) => ({ name: 'sid', value: COOKIE_VALUE, domain: `.${SESSION_HOST}`, path: '/', secure: false, httpOnly: true, ...over });

const runOf = async (apiId: string, owner: string, actor: { userId: string; role: 'member' }) => {
  const { runId } = await withActor(pool, actor, (tx) => createRun(tx, queue, { apiId, ownerId: owner, trigger: 'rest' }));
  await vi.waitFor(async () => expect(['succeeded', 'failed']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), { timeout: 30_000, interval: 100 });
  const run = (await withActor(pool, actor, (tx) => readRun(tx, runId)))!;
  const trace = JSON.stringify([
    run,
    (await pool.query('SELECT to_jsonb(l)::text AS t FROM run_logs l WHERE run_id = $1', [runId])).rows,
    (await pool.query('SELECT to_jsonb(r)::text AS t FROM runs r WHERE id = $1', [runId])).rows,
    (await pool.query('SELECT item FROM dataset_items WHERE dataset_id = $1', [run.dataset_id])).rows,
  ]);
  return { run, runId, trace };
};

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  tdb = await createTestDatabase('sessreplay');
  await migrateUp({ connectionString: tdb.url });
  const masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: tdb.url, max: 6 });
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  kek = kekFor(MasterKey.parse(masterKey), 0, 'site_sessions');
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_sess_a@example.test', 'active'), ($2, 'zz_test_sess_b@example.test', 'active')", [A, B]);
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  const guard = fixtureGuard(port, [SESSION_HOST, OTHER_HOST], net);
  const real = createStrategyExecutor({ pool, guard, pacer: new DomainPacer(new PgPacingStore(pool)), browsers: null, siteSessions: { kek } });
  const executor: RunExecutor = async (ctx) => real(ctx);
  worker = await startWorker({
    config: loadWorkerConfig({ DATABASE_URL: tdb.url, MASTER_KEY: masterKey, QUEUE_POLLING_SECONDS: '0.5', RUN_HEARTBEAT_SECONDS: '0.5', RUN_STALE_SECONDS: '5', BROWSER_CONCURRENCY: '1' }),
    executor,
    logger: pino({ level: 'silent' }),
  });
}, 180_000);

afterAll(async () => {
  await worker?.stop();
  await queue?.stop({ timeoutMs: 1000 });
  await pool?.end();
  await tdb?.drop();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('rejeu serveur d’une session (A2)', () => {
  test('assert_no_secret_in_logs, bout en bout : sans navigateur ni tunnel, la requête porte le Cookie du propriétaire, items rendus, usage écrit, aucune valeur dans les traces', async () => {
    await connect(A, [cookie(), cookie({ name: 'admin_only', value: 'zz_test_admin_path', path: '/admin' })]);
    const apiId = await insertApi(A, 'zz_test_sess_e2e', specFor(SESSION_HOST));
    received.length = 0;
    const { run, runId, trace } = await runOf(apiId, A, actorA);
    expect(run).toMatchObject({ state: 'succeeded', items: 2 });
    expect(run.attempts[0]).toMatchObject({ execution: 'fetch', result: 'ok' });
    expect(received).toHaveLength(1);
    expect(received[0]!.cookie).toBe(`sid=${COOKIE_VALUE}`);
    // Usage : last_used_at et événement `used` cohérents (propriétaire, session, domaine, run), sans valeur.
    const site = (await pool.query<{ id: string; last_used_at: Date | null }>('SELECT id, last_used_at FROM site_sessions WHERE owner_id = $1 AND domain = $2', [A, SESSION_HOST])).rows[0]!;
    expect(site.last_used_at).not.toBeNull();
    const events = (await pool.query<{ owner_id: string; site_session_id: string; domain: string; run_id: string; event: string; outcome: string }>('SELECT * FROM site_session_events WHERE run_id = $1', [runId])).rows;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ owner_id: A, site_session_id: site.id, domain: SESSION_HOST, event: 'used', outcome: 'ok' });
    // assert_no_secret_in_logs : la valeur du cookie n'apparaît ni dans le run, ni dans ses journaux, ni dans les items, ni dans l'événement.
    expect(trace).not.toContain(COOKIE_VALUE);
    expect(JSON.stringify(events)).not.toContain(COOKIE_VALUE);
    expect(secretValues.values()).toContain(COOKIE_VALUE);
  });

  test('assert_session_only_owner_run : le run d’un autre utilisateur n’obtient jamais la session (ni sans cookie, ni en tunnel serveur)', async () => {
    const apiId = await insertApi(A, 'zz_test_sess_owner', specFor(SESSION_HOST));
    // B lance l'API de A : refus à la source ; et, forcé en base, `siteCookiesForRun` refuse.
    const forged = (await pool.query<{ id: string }>("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state) VALUES ($1, $2, $2, 'rest', 'queued') RETURNING id", [apiId, B])).rows[0]!.id;
    expect(await siteCookiesForRun(pool, kek, { runId: forged, domain: SESSION_HOST })).toEqual({ ok: false, reason: 'auth_required' });
    const copied = (await pool.query<{ id: string }>("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state) VALUES ($1, $2, $3, 'rest', 'queued') RETURNING id", [apiId, B, A])).rows[0]!.id;
    expect(await siteCookiesForRun(pool, kek, { runId: copied, domain: SESSION_HOST })).toEqual({ ok: false, reason: 'auth_required' });
    // `api_owner_id` recopié au nom de B sur une API de A : la jointure sur `apis.owner_id` refuse.
    const own = (await pool.query<{ id: string }>("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state) VALUES ($1, $2, $2, 'rest', 'queued') RETURNING id", [apiId, A])).rows[0]!.id;
    const ownResult = await siteCookiesForRun(pool, kek, { runId: own, domain: SESSION_HOST });
    expect(ownResult.ok).toBe(true);
    // B a sa propre session sur le même domaine : jamais celle de A.
    await connect(B, [cookie({ value: 'zz_test_bs_cookie_value_b' })]);
    const bOwn = (await pool.query<{ id: string }>("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state) VALUES ($1, $2, $3, 'rest', 'queued') RETURNING id", [apiId, B, B])).rows[0]!.id;
    expect(await siteCookiesForRun(pool, kek, { runId: bOwn, domain: SESSION_HOST })).toEqual({ ok: false, reason: 'auth_required' });
    void actorB;
  });

  test('assert_session_never_cross_origin : redirection hors domaine, le Cookie ne suit pas (le verrou de domaines refuse)', async () => {
    const apiId = await insertApi(A, 'zz_test_sess_leave', specFor(SESSION_HOST, '/leave'));
    received.length = 0;
    const { run, trace } = await runOf(apiId, A, actorA);
    expect(run.state).toBe('failed');
    expect(received.map((r) => r.host)).toEqual([SESSION_HOST]);
    expect(received.every((r) => r.host === SESSION_HOST || r.cookie === undefined)).toBe(true);
    expect(trace).not.toContain(COOKIE_VALUE);
  });

  test('assert_session_run_paced : deux runs avec session sur le même domaine respectent la cadence par domaine', async () => {
    const pacing = '{"min_delay_ms": 400, "max_requests_per_run": 50, "max_wait_ms": 60000}';
    const one = await insertApi(A, 'zz_test_sess_paced1', specFor(SESSION_HOST, '/api/p1'), pacing);
    const two = await insertApi(A, 'zz_test_sess_paced2', specFor(SESSION_HOST, '/api/p2'), pacing);
    received.length = 0;
    await Promise.all([runOf(one, A, actorA), runOf(two, A, actorA)]);
    const paced = received.filter((r) => r.path.startsWith('/api/p'));
    expect(paced).toHaveLength(2);
    expect(paced.every((r) => r.cookie === `sid=${COOKIE_VALUE}`)).toBe(true);
    expect(Math.abs(paced[1]!.at - paced[0]!.at)).toBeGreaterThanOrEqual(350);
    expect((await pool.query<{ domain: string }>('SELECT domain FROM domain_pacing_state')).rows.map((r) => r.domain)).toContain('example.test');
  });

  test('assert_ssrf_guard : cible non autorisée par la garde refusée même avec session, aucun cookie envoyé', async () => {
    // Le domaine de session résout vers une adresse que le résolveur du harnais ne connaît pas : refus de la garde.
    await connectSite(pool, { ownerId: A, domain: 'zz-sess-ssrf.example.test', serverUseAllowed: true });
    await storeSiteCookies(pool, kek, { ownerId: A, domain: 'zz-sess-ssrf.example.test', cookies: [cookie({ domain: '.zz-sess-ssrf.example.test' })] });
    const id = (
      await pool.query<{ id: string }>(
        `INSERT INTO apis (slug, owner_id, output_schema, domain_pacing, requires_session, requires) VALUES ('zz_test_sess_ssrf', $1, $2, '{"min_delay_ms": 5, "max_requests_per_run": 50, "max_wait_ms": 60000}', true, '{"session_domain": "zz-sess-ssrf.example.test"}') RETURNING id`,
        [A, JSON.stringify(SCHEMA)],
      )
    ).rows[0]!.id;
    const spec = { ...specFor('zz-sess-ssrf.example.test'), request: { method: 'GET', url: `http://zz-sess-ssrf.example.test:${port}/api/items`, allowed_hosts: ['zz-sess-ssrf.example.test'] } };
    await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, est_cost_usd, created_by) VALUES ($1, 1, $2, 'fetch', 'tunnel', $3, 0, 'user')", [id, A, JSON.stringify(spec)]);
    await pool.query('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [id]);
    received.length = 0;
    const { run, trace } = await runOf(id, A, actorA);
    expect(run.state).toBe('failed');
    expect(received).toHaveLength(0);
    expect(trace).not.toContain(COOKIE_VALUE);
  });

  test('session non consentie pour le serveur : comportement d’avant (tunnel indisponible), aucune requête', async () => {
    await pool.query('DELETE FROM site_sessions WHERE owner_id = $1 AND domain = $2', [A, SESSION_HOST]);
    await connect(A, [], false);
    const apiId = await insertApi(A, 'zz_test_sess_noconsent', specFor(SESSION_HOST));
    received.length = 0;
    const { run } = await runOf(apiId, A, actorA);
    expect(run.state).toBe('failed');
    expect(received).toHaveLength(0);
  });
});
