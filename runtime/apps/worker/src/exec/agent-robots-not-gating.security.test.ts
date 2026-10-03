// SPDX-License-Identifier: AGPL-3.0-only
// D-91 pour les exécuteurs agentiques E4-E6, étage S : run réel (file → worker → `createStrategyExecutor` de production
// avec les ports agentiques : Stagehand 3.7.3 par `stagehandEngineFor`, Chromium dédié par `launchAgentBrowser`, faux
// fournisseur LLM) contre la fixture `zz_test_robots`, dont le robots.txt interdit `/prive/`. Le robots.txt ne conditionne
// pas la collecte : E4 par le navigateur, E6 (puis sa compilation en E5 et les deux rejeux de vérification) et E5 sans
// LLM réussissent, la page demande /prive/ comme le site le prévoit (`assert_robots_not_gating`), et aucun de ces runs
// ne demande /robots.txt de lui-même (`assert_robots_not_auto_fetched`). La garde des contextes de run reste posée :
// un service worker enregistré par `ServiceWorkerContainer.prototype.register` n'est jamais chargé.
// PostgreSQL : un conteneur propre à ce fichier (le job security n'a pas le globalSetup du projet integration).
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DomainPacer, generateMasterKey, MasterKey, Secret } from '@runtime/core';
import * as net from '@runtime/core/net';
import { createRun, keyCheck, migrateUp, PgBossJobQueue, PgPacingStore, readRun, runQueueDefinition, withActor } from '@runtime/db';
import { createLlmClient, type CapabilityProfile, type LlmConfig } from '@runtime/llm';
import { createFakeProvider, scripted, type FakeProvider } from '@runtime/llm/testing';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { launchAgentBrowser } from '../browser/agent-browser.js';
import { BrowserPool, playwrightLauncher } from '../browser/pool.js';
import { loadWorkerConfig } from '../config.js';
import { startWorker, type Worker } from '../worker.js';
import { stagehandEngineFor } from './factory.js';
import { createStrategyExecutor } from './strategy-executor.js';
import { startClient, type Client } from '../../../../fixtures/src/test-helpers.ts';
import { fixtureGuard } from '../../../../tests/helpers/fixture-net.ts';
import { stagehandScript } from '../../../../tests/helpers/stagehand-script.ts';

const ROBOTS = 'zz_test_robots.localhost';
const A = randomUUID();
const actorA = { userId: A, role: 'member' as const };
const ID_SCHEMA = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
/** Profil sondé du modèle du rôle agent (08 §1 : sans profil à appel d'outils, le rôle est refusé). */
const AGENT_PROFILE: CapabilityProfile = {
  model: 'zz-agent',
  tools: true,
  tool_choice: ['auto'],
  structured_modes: ['json_object'],
  structured: 'json_object',
  stream_tools: null,
  stream_usage: null,
  cache: false,
  reasoning_field: null,
  probed_at: '2026-10-01T00:00:00Z',
  probe_tokens: 0,
  notes: [],
};

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let client: Client;
let worker: Worker;
let browsers: BrowserPool;
let launchProxy: net.EgressProxy;
let fake: FakeProvider;

const base = (host = ROBOTS) => `http://${host}:${client.server.port}`;

async function insertApi(strategy: { execution: string; spec: unknown }): Promise<string> {
  const id = (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, output_schema, network_policy, domain_pacing, max_cost_usd) VALUES ($1, $2, $3, '{"allow": ["direct"]}', '{"min_delay_ms": 5, "max_requests_per_run": 50, "max_wait_ms": 60000}', 0.5) RETURNING id`,
      [`zz_test_agent_robots_${randomUUID().slice(0, 8)}`, A, JSON.stringify(ID_SCHEMA)],
    )
  ).rows[0]!.id;
  await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, est_cost_usd, created_by) VALUES ($1, 1, $2, $3, 'direct', $4, 0.01, 'user')", [
    id,
    A,
    strategy.execution,
    JSON.stringify(strategy.spec),
  ]);
  await pool.query('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [id]);
  return id;
}

const runOf = async (apiId: string) => {
  const { runId } = await withActor(pool, actorA, (tx) => createRun(tx, queue, { apiId, ownerId: A, trigger: 'rest' }));
  await vi.waitFor(async () => expect(['succeeded', 'failed']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), {
    timeout: 120_000,
    interval: 200,
  });
  return (await withActor(pool, actorA, (tx) => readRun(tx, runId)))!;
};

const paths = async (host = ROBOTS) => (await client.stats()).hosts[host]?.paths ?? {};
/** Requêtes reçues sous /prive/, chemin que robots.txt interdit : servies, comme les autres. */
const privateHits = async (host = ROBOTS) =>
  Object.entries(await paths(host))
    .filter(([p]) => p.startsWith('/prive/'))
    .reduce((n, [, c]) => n + c, 0);

/** E4 par le navigateur (`fetch_in_page`). */
const e4 = (path: string) => ({
  execution: 'agent_fetch',
  spec: { schema_version: 1, kind: 'agent_fetch', via: 'fetch_in_page', request: { url: `${base()}${path}`, allowed_hosts: [ROBOTS] }, instruction: 'Liste les identifiants de la page.' },
});
/** E6 : l'agent part de `path`. */
const e6 = (path: string) => ({
  execution: 'agent',
  spec: { schema_version: 1, kind: 'agent', start_url: `${base()}${path}`, allowed_hosts: [ROBOTS], instruction: 'Trouve l’identifiant de la fiche.', limits: { max_steps: 6 } },
});
/** E5 sans LLM (contexte du pool, même chemin que les rejeux de compilation E6). */
const e5 = (path: string) => ({
  execution: 'hybrid',
  spec: { schema_version: 1, kind: 'hybrid', start_url: `${base()}${path}`, allowed_hosts: [ROBOTS], steps: [], extract: { mode: 'labels', fields: { id: { label: 'Identifiant', ops: [] } } } },
});
/** Agent scripté : `turns` tours d'outils, puis la sortie `{ items: [{ id }] }`. */
const agentScript = (turns: Parameters<typeof scripted.toolCalls>[0][]) =>
  fake.setScenario('zz-agent', stagehandScript(turns.map((calls) => scripted.toolCalls(calls)), { items: [{ id: 'zz_test_item_1' }] }));

beforeAll(async () => {
  container = await new PostgreSqlContainer(`postgres:${process.env.PG_VERSION ?? '16'}`).start();
  const dbUrl = container.getConnectionUri();
  await migrateUp({ connectionString: dbUrl });
  const masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: dbUrl, max: 6 });
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_agent_robots@example.test', 'active')", [A]);
  queue = new PgBossJobQueue({ connectionString: dbUrl, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  client = await startClient();
  fake = await createFakeProvider();
  const guard = fixtureGuard(client.server.port, [ROBOTS], net);
  launchProxy = await net.startEgressProxy({ guard, refuseAll: true });
  browsers = new BrowserPool({ size: 1, launch: playwrightLauncher(launchProxy.url, process.env), recycleAfterRuns: 100 });
  const llmConfig: LlmConfig = {
    providers: [
      {
        id: 'fake',
        baseUrl: fake.baseUrl,
        apiKey: new Secret('zz_test_fake_key'),
        models: [
          { id: 'zz-extract', price: { in: 1, out: 2 } },
          { id: 'zz-agent', price: { in: 1, out: 2 }, profile: AGENT_PROFILE },
        ],
      },
    ],
    roles: { extract: { provider: 'fake', model: 'zz-extract' }, agent: { provider: 'fake', model: 'zz-agent' } },
  };
  const executor = createStrategyExecutor({
    pool,
    guard,
    pacer: new DomainPacer(new PgPacingStore(pool)),
    browsers,
    logger: pino({ level: 'silent' }),
    instanceContact: async () => 'mailto:ops@zz-test.example',
    version: '9.9.9',
    agent: {
      llmConfig: async () => llmConfig,
      client: (c) => createLlmClient(c),
      engineFor: (c) => stagehandEngineFor(c, {}),
      agentBrowser: (options) => launchAgentBrowser({ ...options, env: process.env }),
    },
  });
  worker = await startWorker({
    config: loadWorkerConfig({ DATABASE_URL: dbUrl, MASTER_KEY: masterKey, QUEUE_POLLING_SECONDS: '0.5', RUN_HEARTBEAT_SECONDS: '0.5', RUN_STALE_SECONDS: '30', BROWSER_CONCURRENCY: '1' }),
    executor,
    logger: pino({ level: 'silent' }),
  });
}, 240_000);

afterAll(async () => {
  await worker?.stop();
  await queue?.stop({ timeoutMs: 1000 });
  await browsers?.close();
  await launchProxy?.close();
  await fake?.close();
  await pool?.end();
  await client?.close();
  await container?.stop();
}, 120_000);

beforeEach(async () => {
  await client.reset();
  fake.reset();
  fake.setScenario('zz-extract', Array.from({ length: 5 }, () => scripted.json({ items: [{ id: 'zz_test_item_1' }] })));
});

describe('assert_robots_not_gating — E4, E5 et E6 sur un site dont robots.txt interdit /prive/ (D-91)', () => {
  test('E4 par le navigateur (fetch_in_page) : page extraite, fetch de la page vers /prive/ servi, robots.txt jamais demandé', async () => {
    const run = await runOf(await insertApi(e4('/page-fetch')));
    expect(run).toMatchObject({ state: 'succeeded', items: 1 });
    expect(await privateHits()).toBeGreaterThanOrEqual(1);
    expect((await paths())['/robots.txt']).toBeUndefined();
  }, 120_000);

  test('E6 réussi puis compilé en E5 : l’agent et les deux rejeux chargent la page et ses fetch vers /prive/, robots.txt jamais demandé', async () => {
    agentScript([]);
    const run = await runOf(await insertApi(e6('/page-fetch')));
    expect(run).toMatchObject({ state: 'succeeded', items: 1 });
    const compiled = (await pool.query<{ data: Record<string, unknown> }>("SELECT data FROM run_logs WHERE run_id = $1 AND event = 'strategy_compiled'", [run.id])).rows;
    expect(compiled).toEqual([expect.objectContaining({ data: expect.objectContaining({ promoted: true }) })]);
    expect((await paths())['/page-fetch']).toBe(3);
    expect(await privateHits()).toBeGreaterThanOrEqual(3);
    expect((await paths())['/robots.txt']).toBeUndefined();
  }, 180_000);

  test('E6 : l’agent navigue vers /prive/ (outil goto) puis rend la sortie : run réussi, aucun refus', async () => {
    agentScript([[{ name: 'goto', arguments: { url: `${base()}/prive/x` } }]]);
    const run = await runOf(await insertApi(e6('/page-fetch')));
    expect(run).toMatchObject({ state: 'succeeded', items: 1 });
    expect((await paths())['/prive/x']).toBeGreaterThanOrEqual(1);
    expect((await paths())['/robots.txt']).toBeUndefined();
  }, 180_000);

  test('E5 sans LLM (contexte du pool) : page redirigée par /depart vers /prive/x suivie ; /page-fetch extraite', async () => {
    const run = await runOf(await insertApi(e5('/page-fetch')));
    expect(run).toMatchObject({ state: 'succeeded', items: 1 });
    expect(await privateHits()).toBeGreaterThanOrEqual(1);
    expect((await paths())['/robots.txt']).toBeUndefined();
  }, 120_000);
});

describe('garde des contextes de run, inchangée par D-91', () => {
  test('E5 sans LLM : service worker enregistré par le prototype puis commandé par postMessage : script jamais chargé, la page est extraite', async () => {
    const run = await runOf(await insertApi(e5('/page-sw-register')));
    expect(run).toMatchObject({ state: 'succeeded', items: 1 });
    expect((await paths())['/sw-register.js']).toBeUndefined();
  }, 120_000);
});
