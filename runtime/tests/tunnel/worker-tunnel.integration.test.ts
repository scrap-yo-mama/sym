// SPDX-License-Identifier: AGPL-3.0-only
// Mode réseau `tunnel` de bout en bout sans Chromium (tâche 2.7) : run mis en file → worker → exécuteur de stratégie →
// `tunnel_jobs` + NOTIFY → passerelle (serveur en écoute) → WSS → exécuteur RÉEL de l'extension (navigateur simulé sous
// Node, fixtures locales) → réponse → dataset. Défi en tunnel → 0 commande après la détection, run arrêté
// `challenge_in_tunnel`, API en `action_requise` (assert_challenge_in_tunnel_stops). E6 refusé (assert_e6_not_in_tunnel_mode).
// Extension hors ligne → `waiting_tunnel` puis `skipped_tunnel_offline` (04 §6, 05), sans essai ni classe d'échec.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createLogger, DomainPacer, generateExtensionToken } from '@runtime/core';
import * as net from '@runtime/core/net';
import { createRun, PgBossJobQueue, PgPacingStore, readRun, runQueueDefinition, withActor } from '@runtime/db';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { TunnelExecutor } from '../../apps/extension/src/core/tunnel-executor.ts';
import { loadWorkerConfig } from '../../apps/worker/src/config.js';
import { createStrategyExecutor } from '../../apps/worker/src/exec/strategy-executor.js';
import { TunnelJobClient } from '../../apps/worker/src/tunnel/client.js';
import { startWorker, type Worker } from '../../apps/worker/src/worker.js';
import { contactsSpecInput, fixtureGuard, SCHEMA_CONTACT } from '../helpers/fixture-net.js';
import { closeTestPool, createTestPool } from '../helpers/pg.js';
import { createUser, runSetup, startTestServer, type TestServer, type TestUser } from '../helpers/server.js';
import { nodeBrowserApi } from '../helpers/tunnel-browser.js';
import { SimExtension } from '../helpers/tunnel-sim.js';

const SHOP = 'zz-test-shop.example';
const CHALLENGE = '<!doctype html><html><head><title>Security check</title></head><body><main id="zz-test-challenge"><p>Please verify you are human to continue.</p></main></body></html>';
const silent = createLogger({ name: 'zz_test', level: 'fatal' });

let srv: TestServer;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let worker: Worker;
let tunnel: TunnelJobClient;
let fixtures: Server;
let port: number;
let user: TestUser;
const hits: string[] = [];
let ext: SimExtension;
let browserCalls: string[];

function fixtureServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    hits.push(`${url.pathname}${url.search}`);
    const page = Number(url.searchParams.get('page') ?? '1');
    if (url.pathname === '/') {
      res.setHeader('content-type', 'text/html');
      return res.end('<html><head><title>zz-test shop</title></head><body>ok</body></html>');
    }
    if (url.pathname.startsWith('/guarded/') && page >= 2) {
      res.statusCode = 403;
      res.setHeader('content-type', 'text/html');
      return res.end(CHALLENGE);
    }
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `zz_test_${page}_${i}`, name: ` Contact ${page}-${i} `, email: `ZZ_TEST_${page}_${i}@EXAMPLE.TEST`, city: 'Lyon', score: i }));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ items: page <= 3 ? items : [], has_more: page < 3 }));
  });
}

async function insertApi(slug: string, strategy: { execution: string; network: string; spec: unknown }, status = 'sain'): Promise<string> {
  const id = (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, output_schema, domain_pacing, status) VALUES ($1, $2, $3, '{"min_delay_ms": 5, "max_requests_per_run": 50, "max_wait_ms": 60000}', $4) RETURNING id`,
      [slug, user.id, JSON.stringify(SCHEMA_CONTACT), status],
    )
  ).rows[0]!.id;
  await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, est_cost_usd, created_by) VALUES ($1, 1, $2, $3, $4, $5, 0, 'user')", [
    id,
    user.id,
    strategy.execution,
    strategy.network,
    JSON.stringify(strategy.spec),
  ]);
  await pool.query('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [id]);
  return id;
}

async function startRun(apiId: string): Promise<string> {
  const { runId } = await withActor(pool, { userId: user.id, role: 'member' }, (tx) => createRun(tx, queue, { apiId, ownerId: user.id, trigger: 'rest' }));
  return runId;
}

async function finished(runId: string) {
  await vi.waitFor(async () => expect(['succeeded', 'failed', 'skipped_tunnel_offline']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), {
    timeout: 60_000,
    interval: 100,
  });
  return (await withActor(pool, { userId: user.id, role: 'member' }, (tx) => readRun(tx, runId)))!;
}

/** `runs.error_detail` (non exposé par `readRun`). */
const detail = async (runId: string) => (await pool.query<{ error_detail: string | null }>('SELECT error_detail FROM runs WHERE id = $1', [runId])).rows[0]!.error_detail;

beforeAll(async () => {
  fixtures = fixtureServer();
  await new Promise<void>((r) => fixtures.listen(0, '127.0.0.1', r));
  port = (fixtures.address() as AddressInfo).port;
  srv = await startTestServer('tunw', { GATEWAY_INSTANCE: 'zz_test_gw_w' });
  await srv.started.app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(srv.started.app.server.address() as AddressInfo).port}`;
  pool = createTestPool(srv.db.url, 6);
  await runSetup(srv);
  user = await createUser(srv, 'zz_test_tunnel_w@example.test');
  queue = new PgBossJobQueue({ connectionString: srv.db.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  tunnel = new TunnelJobClient({ pool, sessionUrl: srv.db.url, logger: silent, pollMs: 100, offlineGraceMs: 2500 });
  await tunnel.start();
  const executor = createStrategyExecutor({
    pool,
    guard: fixtureGuard(port, [], net),
    pacer: new DomainPacer(new PgPacingStore(pool)),
    browsers: null,
    tunnel,
  });
  worker = await startWorker({
    config: loadWorkerConfig({ DATABASE_URL: srv.db.url, MASTER_KEY: srv.masterKey, QUEUE_POLLING_SECONDS: '0.5', RUN_HEARTBEAT_SECONDS: '0.5', RUN_STALE_SECONDS: '30', DISABLE_BROWSER: 'true' }),
    executor,
    logger: silent,
  });
  // Extension de l'utilisateur : jeton d'appareil, WSS, exécuteur réel avec le domaine connecté dans « son » navigateur.
  const { token, hash } = generateExtensionToken();
  await pool.query(`INSERT INTO tunnels (owner_id, device_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '90 days')`, [user.id, `zz_test_${randomUUID().slice(0, 8)}`, hash]);
  // Site connecté en mode tunnel (« Connecter ce site ») : l'instance refuse tout domaine non connecté (07 § 5).
  await pool.query('INSERT INTO site_sessions (owner_id, domain) VALUES ($1, $2)', [user.id, SHOP]);
  const browser = nodeBrowserApi(port);
  browserCalls = browser.calls;
  const executorExt = new TunnelExecutor({ browser: browser.api, connectedDomains: async () => new Set([SHOP]) });
  ext = new SimExtension(base, token, { handler: (frame) => executorExt.run(frame) });
  expect(await ext.welcome).toBe(true);
}, 180_000);

afterAll(async () => {
  await ext?.close();
  await worker?.stop();
  await tunnel?.close();
  await queue?.stop({ timeoutMs: 1000 });
  await closeTestPool(pool);
  await srv?.close();
  await new Promise<void>((r) => fixtures?.close(() => r()));
});

describe('mode tunnel : stratégie déclarative par l’extension du propriétaire', () => {
  test('E1 en tunnel : page_fetch dans un onglet du site, 30 contacts conformes, essai tracé en `tunnel`', async () => {
    const base = `http://${SHOP}:${port}`;
    const apiId = await insertApi('zz_test_tunnel_e1', { execution: 'fetch', network: 'tunnel', spec: contactsSpecInput(base, SHOP, 10) });
    const before = ext.received.length;
    const run = await finished(await startRun(apiId));
    expect(run).toMatchObject({ state: 'succeeded', items: 30 });
    expect(run.attempts).toEqual([expect.objectContaining({ execution: 'fetch', network: 'tunnel', result: 'ok', cost_usd: 0 })]);
    const cmds = ext.received.slice(before);
    expect(cmds.map((c) => c.cmd)).toEqual(['page_fetch', 'page_fetch', 'page_fetch']);
    expect(cmds.every((c) => c.domain === SHOP && c.run_id === run.id)).toBe(true);
    expect(browserCalls.some((c) => c.startsWith('tabs.create http://zz-test-shop.example'))).toBe(true);
    const rows = await pool.query<{ n: number; results: number }>('SELECT count(*)::int AS n, count(result)::int AS results FROM tunnel_jobs WHERE run_id = $1', [run.id]);
    expect(rows.rows[0]).toEqual({ n: 3, results: 0 }); // réponses effacées après lecture
  });

  test('assert_challenge_in_tunnel_stops : défi à la page 2 → 0 commande après la détection, challenge_in_tunnel, action_requise', async () => {
    const base = `http://${SHOP}:${port}`;
    const spec = contactsSpecInput(base, SHOP, 10) as { request: { url: string } };
    spec.request.url = `${base}/guarded/api/contacts?per_page=10`;
    const apiId = await insertApi('zz_test_tunnel_challenge', { execution: 'fetch', network: 'tunnel', spec });
    const before = ext.received.length;
    const runId = await startRun(apiId);
    const run = await finished(runId);
    expect(run).toMatchObject({ state: 'failed', failure_class: null, items: 0 });
    expect(await detail(runId)).toBe('challenge_in_tunnel');
    expect(run.dataset_id).toBeNull();
    expect(run.attempts).toEqual([expect.objectContaining({ network: 'tunnel', result: 'blocked_by_protection' })]);
    // Deux commandes : page 1, puis la page 2 qui affiche le défi. Aucune après.
    const cmds = ext.received.slice(before);
    expect(cmds).toHaveLength(2);
    const challengeHits = hits.filter((h) => h.startsWith('/guarded/') && h.includes('page=2'));
    expect(challengeHits).toHaveLength(1);
    expect(hits.filter((h) => h.startsWith('/guarded/') && /page=[3-9]/.test(h))).toEqual([]);
    expect((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM tunnel_jobs WHERE run_id = $1', [runId])).rows[0]!.n).toBe(2);
    // La main revient à l'humain : action_requise, raison challenge_in_tunnel (04 §6, transitions 10 puis 14).
    await vi.waitFor(async () => expect((await pool.query('SELECT status, status_reason FROM apis WHERE id = $1', [apiId])).rows[0]).toEqual({ status: 'action_requise', status_reason: 'challenge_in_tunnel' }), {
      timeout: 10_000,
    });
    const events = await pool.query<{ to_status: string; reason: string }>('SELECT to_status, reason FROM status_events WHERE api_id = $1 ORDER BY id', [apiId]);
    expect(events.rows.at(-1)).toEqual({ to_status: 'action_requise', reason: 'challenge_in_tunnel' });
  });

  test('assert_e6_not_in_tunnel_mode : E6 (agent) en tunnel refusé avant toute commande', async () => {
    const apiId = await insertApi('zz_test_tunnel_e6', { execution: 'agent', network: 'tunnel', spec: { kind: 'agent' } });
    const before = ext.received.length;
    const run = await finished(await startRun(apiId));
    expect(run).toMatchObject({ state: 'failed', failure_class: 'code_error' });
    expect(await detail(run.id)).toBe('execution_server_only');
    expect(ext.received.length).toBe(before);
  });

  test('correctif 2 : extension hors ligne → waiting_tunnel, puis skipped_tunnel_offline (jamais repassé en running, aucun essai network)', async () => {
    await ext.close();
    await vi.waitFor(async () => expect((await pool.query('SELECT count(*)::int AS n FROM tunnels WHERE owner_id = $1 AND gateway_instance IS NOT NULL', [user.id])).rows[0]).toEqual({ n: 0 }));
    const apiId = await insertApi('zz_test_tunnel_offline', { execution: 'fetch', network: 'tunnel', spec: contactsSpecInput(`http://${SHOP}:${port}`, SHOP, 10) });
    const runId = await startRun(apiId);
    await vi.waitFor(async () => expect((await pool.query('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]).toEqual({ state: 'waiting_tunnel' }), { timeout: 10_000 });
    // Échantillonnage de l'état jusqu'à la fin : jamais de retour à `running` après `waiting_tunnel`.
    const states = new Set<string>();
    await vi.waitFor(
      async () => {
        const state = (await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state;
        states.add(state);
        expect(state).toBe('skipped_tunnel_offline');
      },
      { timeout: 30_000, interval: 50 },
    );
    expect(states.has('running')).toBe(false);
    const run = await finished(runId);
    expect(run).toMatchObject({ state: 'skipped_tunnel_offline', failure_class: null, items: 0 });
    expect(await detail(runId)).toBe('tunnel_offline');
    expect(run.attempts).toEqual([]);
    // Le statut de l'API ne change pas (04 §6).
    expect((await pool.query('SELECT status FROM apis WHERE id = $1', [apiId])).rows[0]).toEqual({ status: 'sain' });
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM run_attempts WHERE run_id = $1 AND result_class = 'network'", [runId])).rows[0]!.n).toBe(0);
  });
});
