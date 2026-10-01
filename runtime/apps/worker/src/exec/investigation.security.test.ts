// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.1, étage S (Chromium réel) : la reconnaissance est une passe E3 sur N1 (04 §4) qui CAPTURE le trafic de la
// page (XHR / fetch vers un domaine de l'API) dans le contexte gardé des essais (proxy d'egress, SSRF, robots.txt à
// chaque requête, navigations lancées par la page coupées). Sur la fixture SPA, l'API JSON n'est appelée que par un
// script externe : seule la passe navigateur la trouve ; l'enquête retient pourtant `fetch/direct` (le moins cher
// conforme), après un plan qui compte E1, E2 et E3. Sur la fixture API JSON, même résultat (`assert_cheapest_first_logged`
// avec Chromium). Un tiers appelé par la page (`zz_test_evil`) n'est jamais un gisement ni contacté.
// PostgreSQL : un conteneur propre à ce fichier (le job security n'a pas le globalSetup du projet integration).
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DomainPacer, generateMasterKey, MasterKey, Secret } from '@runtime/core';
import { firstCostInversion } from '@runtime/core/investigation';
import * as net from '@runtime/core/net';
import { keyCheck, listInvestigationEvents, migrateUp, PgBossJobQueue, PgPacingStore, readRun, runQueueDefinition, startInvestigation, withActor } from '@runtime/db';
import { createLlmClient, type LlmConfig } from '@runtime/llm';
import { createFakeProvider, scripted, type FakeProvider } from '@runtime/llm/testing';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { startClient, type Client } from '../../../../fixtures/src/test-helpers.ts';
import { fixtureGuard } from '../../../../tests/helpers/fixture-net.ts';
import { BrowserPool, playwrightLauncher } from '../browser/pool.js';
import { loadWorkerConfig } from '../config.js';
import { startWorker, type Worker } from '../worker.js';
import { createInvestigationExecutor, dispatchByKind } from './investigation-executor.js';
import { createStrategyRuntime } from './strategy-executor.js';

const SPA = 'zz_test_spa.localhost';
const API = 'zz_test_api_json.localhost';
const EVIL = 'zz_test_evil.localhost';
const MODEL = 'zz_investigate';
const A = randomUUID();
const actorA = { userId: A, role: 'member' as const };

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let client: Client;
let worker: Worker;
let browsers: BrowserPool;
let launchProxy: net.EgressProxy;
let fake: FakeProvider;

const base = (host: string) => `http://${host}:${client.server.port}`;

const llmConfig = (): LlmConfig => ({
  providers: [{ id: 'fake', baseUrl: fake.baseUrl, apiKey: new Secret('zz-test-key-0000'), models: [{ id: MODEL, price: { in: 1, out: 1 } }] }],
  roles: { investigate: { provider: 'fake', model: MODEL } },
});

async function investigate(slug: string, url: string, description: string) {
  const apiId = (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, domain_pacing) VALUES ($1, $2, '{"min_delay_ms": 5, "max_requests_per_run": 200, "max_wait_ms": 60000}') RETURNING id`,
      [slug, A],
    )
  ).rows[0]!.id;
  const { runId } = await withActor(pool, actorA, (tx) => startInvestigation(tx, queue, { apiId, ownerId: A, trigger: 'rest', request: { url, description, auto_validate: true } }));
  await vi.waitFor(async () => expect(['succeeded', 'failed']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), {
    timeout: 90_000,
    interval: 200,
  });
  return { apiId, run: (await withActor(pool, actorA, (tx) => readRun(tx, runId)))! };
}

const proposal = (fields: { name: string; path: string; type: string }[], pagination: Record<string, unknown> = { type: 'none', param: null, start: null, has_more_path: null, next_path: null }) => ({
  fields: fields.map((f) => ({ name: f.name, type: f.type, required: true, personal: false, description: f.name })),
  sources: [{ candidate: 'c1', paths: fields.map((f) => ({ field: f.name, path: f.path, ops: [] })), pagination }],
});

beforeAll(async () => {
  container = await new PostgreSqlContainer(`postgres:${process.env.PG_VERSION ?? '16'}`).start();
  const url = container.getConnectionUri();
  await migrateUp({ connectionString: url });
  const masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: url, max: 8 });
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_inv_s@example.test', 'active')", [A]);
  queue = new PgBossJobQueue({ connectionString: url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  client = await startClient();
  fake = await createFakeProvider();
  const guard = fixtureGuard(client.server.port, [SPA, API, EVIL], net);
  launchProxy = await net.startEgressProxy({ guard, refuseAll: true });
  browsers = new BrowserPool({ size: 1, launch: playwrightLauncher(launchProxy.url, process.env), recycleAfterRuns: 100 });
  const pacer = new DomainPacer(new PgPacingStore(pool));
  const strategy = createStrategyRuntime({ pool, guard, pacer, browsers, logger: pino({ level: 'silent' }), instanceContact: async () => 'mailto:ops@zz-test.example', version: '9.9.9' });
  const investigation = createInvestigationExecutor({
    pool,
    guard,
    pacer,
    browsers,
    strategy,
    llm: { config: async () => llmConfig(), client: (config) => createLlmClient(config) },
    instanceContact: async () => 'mailto:ops@zz-test.example',
    version: '9.9.9',
  });
  worker = await startWorker({
    config: loadWorkerConfig({ DATABASE_URL: url, MASTER_KEY: masterKey, QUEUE_POLLING_SECONDS: '0.5', RUN_HEARTBEAT_SECONDS: '0.5', RUN_STALE_SECONDS: '20', BROWSER_CONCURRENCY: '1' }),
    executor: dispatchByKind({ run: strategy.executor, investigation }),
    logger: pino({ level: 'silent' }),
  });
}, 240_000);

afterAll(async () => {
  await worker?.stop();
  await queue?.stop({ timeoutMs: 1000 });
  await browsers?.close();
  await launchProxy?.close();
  await pool?.end();
  await fake?.close();
  await client?.close();
  await container?.stop();
}, 120_000);

beforeEach(async () => {
  fake.reset();
  await client.reset();
});

describe('reconnaissance E3 (Chromium) : trafic capturé, moins cher d’abord', () => {
  test('fixture SPA : API JSON appelée par un script externe, trouvée par la capture XHR ; plan E1 < E2 < E3, fetch/direct retenu', async () => {
    fake.setScenario(MODEL, [
      scripted.json(
        proposal([
          { name: 'sku', path: '$.id', type: 'string' },
          { name: 'title', path: '$.title', type: 'string' },
          { name: 'price_cents', path: '$.price_cents', type: 'integer' },
        ]),
      ),
    ]);
    const { apiId, run } = await investigate('zz_test_inv_spa', `${base(SPA)}/`, 'liste des articles');
    expect(run).toMatchObject({ state: 'succeeded', strategy_version: 1, items: 30 });
    const events = await listInvestigationEvents(pool, { runId: run.id, ownerId: A });
    const recon = events.find((e) => e.kind === 'reconnaissance.finished')!.payload as { mode: string; candidates: { from: string; request: { url: string } }[] };
    expect(recon.mode).toBe('browser');
    expect(recon.candidates[0]).toMatchObject({ from: 'response', request: { url: `${base(SPA)}/api/items.json` } });
    const plan = (events.find((e) => e.kind === 'phase.started' && (e.payload as { phase: string }).phase === 'testing')!.payload as { plan: { execution: string; est_cost_usd: number }[] }).plan;
    expect(plan.map((p) => p.execution)).toEqual(['fetch', 'fetch_in_page', 'playwright']);
    expect(firstCostInversion(plan.map((p) => p.est_cost_usd))).toBe(-1);
    expect(run.attempts.map((a) => `${a.execution}/${a.network}/${a.result}`)).toEqual(['fetch/direct/ok']);
    const sv = (await pool.query<{ execution: string; network: string }>('SELECT execution, network FROM strategy_versions WHERE api_id = $1', [apiId])).rows;
    expect(sv).toEqual([{ execution: 'fetch', network: 'direct' }]);
    expect((await pool.query<{ status: string }>('SELECT status FROM apis WHERE id = $1', [apiId])).rows[0]!.status).toBe('sain');
  }, 120_000);

  test('assert_cheapest_first_logged — fixture API JSON en Chromium : XHR capturé, premier essai fetch/direct retenu ; aucun tiers contacté', async () => {
    fake.setScenario(MODEL, [
      scripted.json(
        proposal(
          [
            { name: 'id', path: '$.id', type: 'string' },
            { name: 'score', path: '$.score', type: 'integer' },
          ],
          { type: 'page_param', param: 'url.query.page', start: 1, has_more_path: '$.has_more', next_path: null },
        ),
      ),
    ]);
    const { run } = await investigate('zz_test_inv_json_s', `${base(API)}/`, 'liste des contacts');
    expect(run).toMatchObject({ state: 'succeeded', strategy_version: 1 });
    expect(run.attempts[0]).toMatchObject({ execution: 'fetch', network: 'direct', result: 'ok' });
    expect(firstCostInversion(run.attempts.map((a) => a.est_cost_usd))).toBe(-1);
    expect((await client.stats()).hosts[EVIL]?.total ?? 0).toBe(0);
  }, 120_000);
});
