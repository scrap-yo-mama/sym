// SPDX-License-Identifier: AGPL-3.0-only
// assert_robots_respected (INV11) pour les exécuteurs agentiques E4-E6 (correctif fix-inv11-agent), étage S : run réel
// (file → worker → `createStrategyExecutor` de production avec les ports agentiques : Stagehand 3.7.3 par
// `stagehandEngineFor`, Chromium dédié par `launchAgentBrowser`, faux fournisseur LLM) contre la fixture `zz_test_robots`
// (`Disallow: /prive/`). La garde robots de Chromium (1.11 : contrôle CDP de chaque requête, sauts compris, WebSocket,
// workers, SharedWorker, préchargement coupé) couvrait E1-E3 mais ni le navigateur d'E4 (`fetch_in_page`), ni le Chromium
// dédié d'E5 délégué et d'E6 piloté par Stagehand, ni les contextes E5 et les rejeux de compilation E6. Ici, dans chacun :
// navigation, redirection, fetch lancé par la page, WebSocket et workers vers /prive/ → 0 requête (compteur
// `GET /__stats`) ; une navigation du cadre principal refusée donne `robots_disallowed` à l'essai (`robots_unreachable`
// si robots.txt de l'hôte d'arrivée répond 5xx), une sous-ressource refusée est seulement coupée. Revue de fix-inv11-agent :
// cadre hors processus d'un second hôte (workers, WebSocket), règles de spéculation, robots.txt injoignable, SharedWorker
// (F-20261001-07) et service worker enregistré par `ServiceWorkerContainer.prototype.register` puis commandé par
// postMessage, avec Stagehand attaché comme en production (sa propre auto-attache CDP) ; E5 à étape déléguée ; rejeux de
// vérification d'une compilation E6 → E5 réussie.
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
/** Second hôte autorisé dont robots.txt (derrière deux redirections) interdit /prive/ (cadres d'un autre site). */
const OTHER = 'zz_test_robots_redirect.localhost';
/** Hôte dont robots.txt répond 503 : interdiction totale (`robots_unreachable`). */
const UNREACHABLE = 'zz_test_robots_5xx.localhost';
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
/** Requêtes reçues sous /prive/ (hors /prive/ouvert, permis) : doit rester à 0. */
const forbiddenHits = async (host = ROBOTS) =>
  Object.entries(await paths(host))
    .filter(([p]) => p.startsWith('/prive/') && !p.startsWith('/prive/ouvert'))
    .reduce((n, [, c]) => n + c, 0);

/** E4 par le navigateur (`fetch_in_page`). */
const e4 = (path: string, extraHosts: string[] = []) => ({
  execution: 'agent_fetch',
  spec: { schema_version: 1, kind: 'agent_fetch', via: 'fetch_in_page', request: { url: `${base()}${path}`, allowed_hosts: [ROBOTS, ...extraHosts] }, instruction: 'Liste les identifiants de la page.' },
});
/** E6 : l'agent part de `path`. */
const e6 = (path: string, extraHosts: string[] = []) => ({
  execution: 'agent',
  spec: { schema_version: 1, kind: 'agent', start_url: `${base()}${path}`, allowed_hosts: [ROBOTS, ...extraHosts], instruction: 'Trouve l’identifiant de la fiche.', limits: { max_steps: 6 } },
});
/** E5 sans LLM (contexte du pool, même chemin que les rejeux de compilation E6). */
const e5 = (path: string) => ({
  execution: 'hybrid',
  spec: { schema_version: 1, kind: 'hybrid', start_url: `${base()}${path}`, allowed_hosts: [ROBOTS], steps: [], extract: { mode: 'labels', fields: { id: { label: 'Identifiant', ops: [] } } } },
});
/** E5 à étape déléguée (`op: 'agent'`) : Chromium dédié piloté par Stagehand (`runHybridDelegated`). */
const e5Agent = (path: string) => ({
  execution: 'hybrid',
  spec: {
    schema_version: 1,
    kind: 'hybrid',
    start_url: `${base()}${path}`,
    allowed_hosts: [ROBOTS],
    steps: [{ op: 'agent', instruction: 'Ouvre la fiche.' }],
    extract: { mode: 'labels', fields: { id: { label: 'Identifiant', ops: [] } } },
  },
});

/** Agent scripté : `turns` tours d'outils, puis la sortie `{ items: [{ id }] }`. */
const agentScript = (turns: Parameters<typeof scripted.toolCalls>[0][]) =>
  fake.setScenario('zz-agent', stagehandScript(turns.map((calls) => scripted.toolCalls(calls)), { items: [{ id: 'zz_test_item_1' }] }));

async function expectRobotsDisallowed(run: Awaited<ReturnType<typeof runOf>>) {
  expect(run).toMatchObject({ state: 'failed', failure_class: 'robots_disallowed', retryable: false, items: 0, dataset_id: null });
  expect(await forbiddenHits()).toBe(0);
}

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
  const guard = fixtureGuard(client.server.port, [ROBOTS, OTHER, UNREACHABLE], net);
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

describe('assert_robots_respected — E4 par le navigateur (fetch_in_page) : chaque requête de Chromium contrôlée', () => {
  test('page interdite : 0 requête sur /prive/, robots_disallowed, aucun appel LLM', async () => {
    await expectRobotsDisallowed(await runOf(await insertApi(e4('/prive/x'))));
    expect(fake.requests).toBe(0);
  }, 120_000);

  test('redirection /depart (permis) → 302 /prive/x : 0 requête sur /prive/, robots_disallowed', async () => {
    await expectRobotsDisallowed(await runOf(await insertApi(e4('/depart'))));
    expect((await paths())['/depart']).toBe(1);
    expect(fake.requests).toBe(0);
  }, 120_000);

  test('fetch lancé par la page vers /prive/ (direct et redirigé) : coupé, 0 requête, la page est extraite', async () => {
    const run = await runOf(await insertApi(e4('/page-fetch')));
    expect((await paths())['/page-fetch']).toBe(1);
    expect(await forbiddenHits()).toBe(0);
    expect(run).toMatchObject({ state: 'succeeded', items: 1 });
  }, 120_000);

  test('WebSocket de la page et des workers dédiés (blob, http, module) vers /prive/ : 0 requête', async () => {
    await runOf(await insertApi(e4('/page-ws')));
    await runOf(await insertApi(e4('/page-ws-worker')));
    expect((await paths())['/page-ws-worker']).toBe(1);
    expect(await forbiddenHits()).toBe(0);
  }, 120_000);

  test('cadre hors processus d’un second hôte autorisé dont les workers ouvrent un WebSocket vers /prive/ : 0 requête', async () => {
    await runOf(await insertApi(e4('/page-cadre-ws', [OTHER])));
    expect((await paths())['/page-cadre-ws']).toBe(1);
    expect((await paths(OTHER))['/cadre-ws-worker']).toBe(1);
    expect(await forbiddenHits()).toBe(0);
    expect(await forbiddenHits(OTHER)).toBe(0);
  }, 120_000);

  test('règles de spéculation (prefetch, prerender, en-tête Speculation-Rules) vers /prive/ : 0 requête', async () => {
    await runOf(await insertApi(e4('/page-spec')));
    expect((await paths())['/lent']).toBe(1);
    expect(await forbiddenHits()).toBe(0);
  }, 120_000);

  test('redirection vers un second hôte autorisé dont robots.txt répond 503 : robots_unreachable, 0 requête de contenu, aucun appel LLM', async () => {
    const run = await runOf(await insertApi(e4('/vers-injoignable', [UNREACHABLE])));
    expect(run).toMatchObject({ state: 'failed', failure_class: 'robots_unreachable', retryable: true, items: 0, dataset_id: null });
    expect(Object.keys(await paths(UNREACHABLE)).filter((p) => p !== '/robots.txt')).toEqual([]);
    expect(fake.requests).toBe(0);
  }, 120_000);

  // F-20261001-07 : course entre la reprise d'un SharedWorker (Playwright s'en détache) et sa fermeture.
  test('SharedWorker du site (fetch direct et redirigé vers /prive/) : 0 requête', async () => {
    await runOf(await insertApi(e4('/page-sw')));
    expect((await paths())['/page-sw']).toBe(1);
    expect(await forbiddenHits()).toBe(0);
    expect((await paths())['/depart']).toBeUndefined();
  }, 120_000);

  test('service worker enregistré par ServiceWorkerContainer.prototype.register puis commandé par postMessage : 0 requête, script jamais chargé', async () => {
    await runOf(await insertApi(e4('/page-sw-register')));
    expect((await paths())['/page-sw-register']).toBe(1);
    expect((await paths())['/lent']).toBe(1);
    expect(await forbiddenHits()).toBe(0);
    expect((await paths())['/sw-register.js']).toBeUndefined();
    expect((await paths())['/depart']).toBeUndefined();
  }, 120_000);
});

describe('assert_robots_respected — E6 : Chromium dédié piloté par Stagehand', () => {
  test('page de départ interdite : 0 requête sur /prive/, robots_disallowed', async () => {
    agentScript([]);
    await expectRobotsDisallowed(await runOf(await insertApi(e6('/prive/x'))));
  }, 180_000);

  test('page de départ redirigée vers /prive/ (/depart → 302) : 0 requête, robots_disallowed', async () => {
    agentScript([]);
    await expectRobotsDisallowed(await runOf(await insertApi(e6('/depart'))));
    expect((await paths())['/depart']).toBe(1);
  }, 180_000);

  test('l’agent navigue vers /prive/ (outil goto) : 0 requête, robots_disallowed', async () => {
    agentScript([[{ name: 'goto', arguments: { url: `${base()}/prive/x` } }]]);
    await expectRobotsDisallowed(await runOf(await insertApi(e6('/page-fetch'))));
    expect((await paths())['/page-fetch']).toBe(1);
  }, 180_000);

  test('l’agent navigue vers /depart (→ 302 /prive/x) : 0 requête, robots_disallowed', async () => {
    agentScript([[{ name: 'goto', arguments: { url: `${base()}/depart` } }]]);
    await expectRobotsDisallowed(await runOf(await insertApi(e6('/page-fetch'))));
    expect((await paths())['/depart']).toBeGreaterThanOrEqual(1);
  }, 180_000);

  test('fetch lancé par la page (direct, redirigé), WebSocket et workers de la page vers /prive/ : 0 requête', async () => {
    agentScript([[{ name: 'goto', arguments: { url: `${base()}/page-ws` } }], [{ name: 'goto', arguments: { url: `${base()}/page-ws-worker` } }]]);
    await runOf(await insertApi(e6('/page-fetch')));
    expect((await paths())['/page-fetch']).toBeGreaterThanOrEqual(1);
    expect((await paths())['/page-ws-worker']).toBeGreaterThanOrEqual(1);
    expect(await forbiddenHits()).toBe(0);
  }, 180_000);

  test('cadre hors processus d’un second hôte (workers, WebSocket) et règles de spéculation (outil goto) : 0 requête, les workers du cadre tournent', async () => {
    // Attente sur la page du cadre (outil wait) : ses workers ont le temps de tourner (témoin) avant la navigation suivante.
    agentScript([[{ name: 'goto', arguments: { url: `${base()}/page-cadre-ws` } }], [{ name: 'wait', arguments: { timeMs: 2000 } }], [{ name: 'goto', arguments: { url: `${base()}/page-spec` } }]]);
    await runOf(await insertApi(e6('/page-fetch', [OTHER])));
    expect((await paths())['/page-cadre-ws']).toBeGreaterThanOrEqual(1);
    expect((await paths())['/page-spec']).toBeGreaterThanOrEqual(1);
    expect(await forbiddenHits()).toBe(0);
    expect(await forbiddenHits(OTHER)).toBe(0);
    // Témoin : le worker http du cadre (hors processus, auto-attaché par Stagehand aussi) a exécuté son code.
    expect((await paths(OTHER))['/temoin-cadre-worker']).toBeGreaterThanOrEqual(1);
  }, 180_000);

  test('l’agent navigue vers /vers-injoignable (→ 302 vers un hôte dont robots.txt répond 503) : robots_unreachable, 0 requête de contenu', async () => {
    agentScript([[{ name: 'goto', arguments: { url: `${base()}/vers-injoignable` } }]]);
    const run = await runOf(await insertApi(e6('/page-fetch', [UNREACHABLE])));
    expect(run).toMatchObject({ state: 'failed', failure_class: 'robots_unreachable', retryable: true, items: 0, dataset_id: null });
    expect((await paths())['/vers-injoignable']).toBeGreaterThanOrEqual(1);
    expect(Object.keys(await paths(UNREACHABLE)).filter((p) => p !== '/robots.txt')).toEqual([]);
  }, 180_000);

  // Stagehand pose sa propre auto-attache CDP (waitForDebuggerOnStart, puis runIfWaitingForDebugger) : SharedWorker et
  // service worker restent coupés avec lui attaché comme en production.
  test('SharedWorker du site et service worker enregistré par le prototype puis commandé par postMessage (outil goto) : 0 requête', async () => {
    agentScript([[{ name: 'goto', arguments: { url: `${base()}/page-sw` } }], [{ name: 'goto', arguments: { url: `${base()}/page-sw-register` } }]]);
    await runOf(await insertApi(e6('/page-fetch')));
    expect((await paths())['/page-sw']).toBeGreaterThanOrEqual(1);
    expect((await paths())['/page-sw-register']).toBeGreaterThanOrEqual(1);
    expect(await forbiddenHits()).toBe(0);
    expect((await paths())['/sw-register.js']).toBeUndefined();
  }, 180_000);

  test('E6 réussi puis compilé en E5 : la page finale demande /prive/ (fetch direct et redirigé) pendant l’agent et les deux rejeux de vérification : 0 requête', async () => {
    agentScript([]);
    const run = await runOf(await insertApi(e6('/page-fetch')));
    expect(run).toMatchObject({ state: 'succeeded', items: 1 });
    const compiled = (await pool.query<{ data: Record<string, unknown> }>("SELECT data FROM run_logs WHERE run_id = $1 AND event = 'strategy_compiled'", [run.id])).rows;
    expect(compiled).toEqual([expect.objectContaining({ data: expect.objectContaining({ promoted: true }) })]);
    // L'agent, puis les deux rejeux de vérification (contextes du pool) : chacun a chargé la page et lancé ses fetch.
    expect((await paths())['/page-fetch']).toBe(3);
    expect(await forbiddenHits()).toBe(0);
  }, 180_000);
});

describe('assert_robots_respected — E5 à étape déléguée (Chromium dédié piloté par Stagehand, runHybridDelegated)', () => {
  test('l’étape agent navigue vers /prive/x (outil goto) : 0 requête, robots_disallowed', async () => {
    agentScript([[{ name: 'goto', arguments: { url: `${base()}/prive/x` } }]]);
    await expectRobotsDisallowed(await runOf(await insertApi(e5Agent('/page-fetch'))));
    expect((await paths())['/page-fetch']).toBe(1);
  }, 180_000);
});

describe('assert_robots_respected — E5 sans LLM (contexte du pool, chemin des rejeux de compilation E6)', () => {
  test('page de départ interdite : 0 requête, robots_disallowed', async () => {
    await expectRobotsDisallowed(await runOf(await insertApi(e5('/prive/x'))));
  }, 120_000);

  test('page de départ redirigée (/depart → 302 /prive/x) : 0 requête, robots_disallowed', async () => {
    await expectRobotsDisallowed(await runOf(await insertApi(e5('/depart'))));
  }, 120_000);

  test('fetch lancé par la page vers /prive/ : coupé, 0 requête, la page est extraite', async () => {
    const run = await runOf(await insertApi(e5('/page-fetch')));
    expect(await forbiddenHits()).toBe(0);
    expect(run).toMatchObject({ state: 'succeeded', items: 1 });
  }, 120_000);

  test('service worker enregistré par le prototype puis commandé par postMessage : 0 requête, script jamais chargé, la page est extraite', async () => {
    const run = await runOf(await insertApi(e5('/page-sw-register')));
    expect(run).toMatchObject({ state: 'succeeded', items: 1 });
    expect(await forbiddenHits()).toBe(0);
    expect((await paths())['/sw-register.js']).toBeUndefined();
  }, 120_000);
});
