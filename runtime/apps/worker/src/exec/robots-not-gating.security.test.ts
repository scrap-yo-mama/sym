// SPDX-License-Identifier: AGPL-3.0-only
// D-91, étage S : run réel (file → worker → `createStrategyExecutor` de production, Chromium réel, bac à sable de 1.5)
// contre la fixture `zz_test_robots`, dont le robots.txt interdit `/prive/`. Le robots.txt est une source d'information,
// il ne conditionne pas la collecte : dans TOUS les modes d'exécution — E1 `fetch`, E2 `fetch_in_page`, E3 `playwright`
// déclaratif, E3 en script (page de départ, `ctx.fetch`, `ctx.page.goto`) — le run sur un chemin que robots.txt interdit
// réussit, le statut ne change pas, l'agent de réparation n'est jamais invoqué (`assert_robots_not_gating`), et aucun run
// en rejeu ne demande /robots.txt de lui-même (`assert_robots_not_auto_fetched`, compteur `GET /__stats`). Le User-Agent
// du robot est celui du moteur, avec le jeton de l'instance seulement si `identify_instance` est activé.
// PostgreSQL : un conteneur propre à ce fichier (le job security n'a pas le globalSetup du projet integration).
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DomainPacer, generateMasterKey, MasterKey } from '@runtime/core';
import * as net from '@runtime/core/net';
import { createRun, keyCheck, migrateUp, PgBossJobQueue, PgPacingStore, readRun, runQueueDefinition, withActor } from '@runtime/db';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { BrowserPool } from '../browser/pool.js';
import { createLocalProvider } from '../browser/provider-local.js';
import { loadWorkerConfig } from '../config.js';
import { ProcessSandboxEngine, sandboxOptionsFromEnv } from '../sandbox/engine.js';
import { startWorker, type Worker } from '../worker.js';
import { startClient, type Client } from '../../../../fixtures/src/test-helpers.ts';
import { fixtureGuard } from '../../../../tests/helpers/fixture-net.ts';
import { loadInlineScript } from './script-executor.js';
import { createStrategyExecutor, type RepairPort } from './strategy-executor.js';

const ROBOTS = 'zz_test_robots.localhost';
const UNREACHABLE = 'zz_test_robots_5xx.localhost';
/** Second hôte autorisé dont robots.txt (derrière deux redirections) interdit /prive/. */
const OTHER = 'zz_test_robots_redirect.localhost';
const A = randomUUID();
const actorA = { userId: A, role: 'member' as const };
const ID_SCHEMA = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
let identifyInstance = false;
const UA_SCHEMA = { type: 'object', required: ['ua'], properties: { ua: { type: 'string' } } };

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let client: Client;
let worker: Worker;
let browsers: BrowserPool;
let launchProxy: net.EgressProxy;
const repair = vi.fn<RepairPort>(async () => ({ kind: 'failed', cause: 'budget_exhausted', detail: 'zz_test_no_repair' }));

const base = (host: string) => `http://${host}:${client.server.port}`;

async function insertApi(strategy: { execution: string; spec: unknown; scriptRef?: string }, outputSchema: unknown = ID_SCHEMA): Promise<string> {
  const id = (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, output_schema, network_policy, domain_pacing) VALUES ($1, $2, $3, '{"allow": ["direct"]}', '{"min_delay_ms": 5, "max_requests_per_run": 50, "max_wait_ms": 60000}') RETURNING id`,
      [`zz_test_robots_${randomUUID().slice(0, 8)}`, A, JSON.stringify(outputSchema)],
    )
  ).rows[0]!.id;
  await pool.query(
    "INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, script_ref, est_cost_usd, created_by) VALUES ($1, 1, $2, $3, 'direct', $4, $5, 0, 'user')",
    [id, A, strategy.execution, JSON.stringify(strategy.spec), strategy.scriptRef ?? null],
  );
  await pool.query('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [id]);
  return id;
}

const runOf = async (apiId: string) => {
  const { runId } = await withActor(pool, actorA, (tx) => createRun(tx, queue, { apiId, ownerId: A, trigger: 'rest' }));
  await vi.waitFor(async () => expect(['succeeded', 'failed']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), {
    timeout: 60_000,
    interval: 200,
  });
  return (await withActor(pool, actorA, (tx) => readRun(tx, runId)))!;
};

const paths = async (host: string) => (await client.stats()).hosts[host]?.paths ?? {};
/** Requêtes reçues sur /robots.txt par les trois sites : un run n'en émet jamais de lui-même. */
const robotsHits = async () => {
  let n = 0;
  for (const host of [ROBOTS, UNREACHABLE, OTHER]) n += (await paths(host))['/robots.txt'] ?? 0;
  return n;
};

const declarative = (host: string, path: string, extraHosts: string[] = []) => ({
  schema_version: 1,
  kind: 'declarative',
  request: { method: 'GET', url: `${base(host)}${path}`, allowed_hosts: [host, ...extraHosts] },
  sources: [{ id: 'api', from: 'response', records: '$.items[*]' }],
  fields: { id: { path: '$.id', type: 'string', required: true } },
});
const script = (host: string, startPath: string, source: string, extraHosts: string[] = []) => ({
  execution: 'playwright',
  scriptRef: 'inline',
  spec: { kind: 'script', allowed_hosts: [host, ...extraHosts], start_url: `${base(host)}${startPath}`, source },
});

beforeAll(async () => {
  container = await new PostgreSqlContainer(`postgres:${process.env.PG_VERSION ?? '16'}`).start();
  const url = container.getConnectionUri();
  await migrateUp({ connectionString: url });
  const masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: url, max: 6 });
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_robots_s@example.test', 'active')", [A]);
  queue = new PgBossJobQueue({ connectionString: url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  client = await startClient();
  const guard = fixtureGuard(client.server.port, [ROBOTS, UNREACHABLE, OTHER], net);
  launchProxy = await net.startEgressProxy({ guard, refuseAll: true });
  browsers = new BrowserPool({ size: 1, launch: createLocalProvider({ launchProxyUrl: launchProxy.url, env: process.env }).launchShared, recycleAfterRuns: 100 });
  const engine = new ProcessSandboxEngine({ ...sandboxOptionsFromEnv(process.env), production: false });
  const executor = createStrategyExecutor({
    pool,
    guard,
    pacer: new DomainPacer(new PgPacingStore(pool)),
    browsers,
    repair,
    logger: pino({ level: 'silent' }),
    script: { engine, loadScript: loadInlineScript, limits: { timeoutMs: 20_000, memoryMb: 128 } },
    instanceContact: async () => 'mailto:ops@zz-test.example',
    // Réglage `identify_instance` : désactivé par défaut, activé le temps d'un test (17 §5).
    identifyInstance: async () => identifyInstance,
    version: '9.9.9',
  });
  worker = await startWorker({
    config: loadWorkerConfig({ DATABASE_URL: url, MASTER_KEY: masterKey, QUEUE_POLLING_SECONDS: '0.5', RUN_HEARTBEAT_SECONDS: '0.5', RUN_STALE_SECONDS: '10', BROWSER_CONCURRENCY: '1' }),
    executor,
    logger: pino({ level: 'silent' }),
  });
}, 240_000);

afterAll(async () => {
  await worker?.stop();
  await queue?.stop({ timeoutMs: 1000 });
  await browsers?.close();
  await launchProxy?.close();
  await pool?.end();
  await client?.close();
  await container?.stop();
}, 120_000);

beforeEach(async () => {
  await client.reset();
  repair.mockClear();
});

/** Run réussi sur un chemin que robots.txt interdit : items livrés, aucun agent, statut inchangé, robots.txt jamais lu. */
async function expectCollected(run: Awaited<ReturnType<typeof runOf>>, minItems = 1) {
  expect(run, JSON.stringify(run)).toMatchObject({ state: 'succeeded', failure_class: null });
  expect(run.items).toBeGreaterThanOrEqual(minItems);
  expect(repair).not.toHaveBeenCalled();
  const events = (await pool.query<{ to_status: string }>('SELECT to_status FROM status_events WHERE run_id = $1', [run.id])).rows;
  expect(events.map((e) => e.to_status)).not.toContain('bloquee');
  expect(await robotsHits()).toBe(0);
}

describe('assert_robots_not_gating — robots.txt Disallow: /prive/ ne bloque aucun mode d’exécution (D-91)', () => {
  test('E1 fetch : URL sous /prive/ collectée', async () => {
    await expectCollected(await runOf(await insertApi({ execution: 'fetch', spec: declarative(ROBOTS, '/prive/liste') })), 2);
    expect((await paths(ROBOTS))['/prive/liste']).toBe(1);
  }, 120_000);

  test('E2 fetch_in_page : URL de données sous /prive/ collectée', async () => {
    await expectCollected(await runOf(await insertApi({ execution: 'fetch_in_page', spec: declarative(ROBOTS, '/prive/api') })), 2);
    expect((await paths(ROBOTS))['/prive/api']).toBe(1);
  }, 120_000);

  test('E3 en script : page de départ, ctx.fetch et ctx.page.goto sous /prive/', async () => {
    const source = `await ctx.fetch('${base(ROBOTS)}/prive/donnees'); await ctx.page.goto('${base(ROBOTS)}/prive/suite'); ctx.emit({ id: 'apres' });`;
    await expectCollected(await runOf(await insertApi(script(ROBOTS, '/prive/depart', source))));
    const seen = await paths(ROBOTS);
    expect(seen['/prive/depart']).toBe(1);
    expect(seen['/prive/donnees']).toBe(1);
    expect(seen['/prive/suite']).toBe(1);
  }, 120_000);

  test('redirection d’un chemin permis vers /prive/ (E2, E3 en script) : suivie', async () => {
    await expectCollected(await runOf(await insertApi({ execution: 'fetch_in_page', spec: declarative(ROBOTS, '/depart') })), 2);
    const source = `await ctx.page.goto('${base(ROBOTS)}/depart'); ctx.emit({ id: 'apres' });`;
    await expectCollected(await runOf(await insertApi(script(ROBOTS, '/', source))));
    expect((await paths(ROBOTS))['/prive/x']).toBe(2);
  }, 120_000);

  test('robots.txt injoignable (503) ou redirigé en boucle : sans effet, collecte normale', async () => {
    await expectCollected(await runOf(await insertApi({ execution: 'fetch', spec: declarative(UNREACHABLE, '/liste') })), 2);
    await client.control({ op: 'site', site: 'robots_redirect', loop: true });
    await expectCollected(await runOf(await insertApi({ execution: 'fetch', spec: declarative(OTHER, '/prive/x') })), 2);
    expect((await paths(UNREACHABLE))['/robots.txt']).toBeUndefined();
    expect((await paths(OTHER))['/robots.txt']).toBeUndefined();
  }, 120_000);
});

describe('assert_robots_not_auto_fetched — aucun run en rejeu ne demande /robots.txt de lui-même', () => {
  test('E1, E2, E3 en script sur les trois sites : 0 requête vers /robots.txt', async () => {
    for (const [execution, host] of [['fetch', ROBOTS], ['fetch_in_page', OTHER], ['fetch', UNREACHABLE]] as const) {
      await expectCollected(await runOf(await insertApi({ execution, spec: declarative(host, '/liste') })));
    }
    await expectCollected(await runOf(await insertApi(script(ROBOTS, '/', `await ctx.fetch('${base(ROBOTS)}/liste'); ctx.emit({ id: 'x' });`))));
    for (const host of [ROBOTS, OTHER, UNREACHABLE]) expect((await paths(host))['/robots.txt'], host).toBeUndefined();
  }, 180_000);

  test('le robots.txt reste une page comme une autre : un script qui choisit de le lire le reçoit', async () => {
    const source = `const r = await ctx.fetch('${base(ROBOTS)}/robots.txt'); const t = await r.text(); ctx.emit({ id: t.includes('Disallow') ? 'lu' : 'vide' });`;
    const run = await runOf(await insertApi(script(ROBOTS, '/', source)));
    expect(run).toMatchObject({ state: 'succeeded', items: 1 });
    const items = (await withActor(pool, actorA, (tx) => tx.query<{ item: { id: string } }>('SELECT item FROM dataset_items WHERE dataset_id = $1', [run.dataset_id]))).rows;
    expect(items.map((r) => r.item.id)).toEqual(['lu']);
    expect((await paths(ROBOTS))['/robots.txt']).toBe(1);
  }, 120_000);
});

describe('assert_user_agent_engine_real — identité du robot dans Chromium (17 §5)', () => {
  test('User-Agent réel du moteur, avec le jeton de l’instance seulement si identify_instance est activé', async () => {
    const source = `const ua = await ctx.page.evaluate('navigator.userAgent'); ctx.emit({ ua: String(ua) });`;
    const uaOf = async (): Promise<string> => {
      const run = await runOf(await insertApi(script(ROBOTS, '/prive/ouvert', source), UA_SCHEMA));
      expect(run).toMatchObject({ state: 'succeeded', items: 1 });
      return (await withActor(pool, actorA, (tx) => tx.query<{ item: { ua: string } }>('SELECT item FROM dataset_items WHERE dataset_id = $1', [run.dataset_id]))).rows[0]!.item.ua;
    };
    // Valeur attendue : browser.version() du Chromium du pool et plateforme réelle (jamais une constante).
    const version = await browsers.run(new AbortController().signal, async (browser) => browser.version());
    const platform = { darwin: 'Macintosh; Intel Mac OS X 10_15_7', linux: 'X11; Linux x86_64', win32: 'Windows NT 10.0; Win64; x64' }[process.platform as 'darwin' | 'linux' | 'win32'];
    const engine = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version.split('.')[0]}.0.0.0 Safari/537.36`;
    expect(await uaOf()).toBe(engine);
    identifyInstance = true;
    try {
      expect(await uaOf()).toBe(`${engine} (compatible; Scrapyomama/9.9.9; +mailto:ops@zz-test.example)`);
    } finally {
      identifyInstance = false;
    }
  }, 120_000);
});
