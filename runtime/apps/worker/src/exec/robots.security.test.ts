// SPDX-License-Identifier: AGPL-3.0-only
// assert_robots_respected (INV11, tâche 1.11), étage S : run réel (file → worker → `createStrategyExecutor` de production,
// Chromium réel, bac à sable de 1.5) contre la fixture `zz_test_robots` (`Disallow: /prive/`). Dans TOUS les modes
// d'exécution — E1 `fetch`, E2 `fetch_in_page`, E3 `playwright` déclaratif, E3 en script (page de départ, `ctx.fetch`,
// `ctx.page.goto`) — un chemin interdit reçoit 0 requête (compteur `GET /__stats`), le run rend `robots_disallowed`
// (statut visé `bloquee`, transition 4), l'agent de réparation n'est jamais invoqué. Le User-Agent du robot porte le
// contact de l'instance, y compris dans Chromium (ajouté à celui du navigateur, aucun masquage).
// PostgreSQL : un conteneur propre à ce fichier (le job security n'a pas le globalSetup du projet integration).
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DomainPacer, generateMasterKey, MasterKey } from '@runtime/core';
import * as net from '@runtime/core/net';
import { applyStatusTransition, createRun, keyCheck, migrateUp, PgBossJobQueue, PgPacingStore, readRun, runQueueDefinition, withActor } from '@runtime/db';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { BrowserPool, playwrightLauncher } from '../browser/pool.js';
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
const UA_SCHEMA = { type: 'object', required: ['ua'], properties: { ua: { type: 'string' } } };

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let client: Client;
let worker: Worker;
let browsers: BrowserPool;
let launchProxy: net.EgressProxy;
const repair = vi.fn<RepairPort>(async () => null);

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

const detailOf = async (runId: string) => (await pool.query<{ error_detail: string | null }>('SELECT error_detail FROM runs WHERE id = $1', [runId])).rows[0]!.error_detail;
const paths = async (host: string) => (await client.stats()).hosts[host]?.paths ?? {};
/** Requêtes reçues sous /prive/ (hors /prive/ouvert, permis) : doit rester à 0. */
const forbiddenHits = async (host: string) =>
  Object.entries(await paths(host))
    .filter(([p]) => p.startsWith('/prive/') && !p.startsWith('/prive/ouvert'))
    .reduce((n, [, c]) => n + c, 0);

const declarative = (host: string, path: string, extraHosts: string[] = []) => ({
  schema_version: 1,
  kind: 'declarative',
  request: { method: 'GET', url: `${base(host)}${path}`, allowed_hosts: [host, ...extraHosts] },
  sources: [{ id: 'api', from: 'response', records: '$.items[*]' }],
  fields: { id: { path: '$.id', type: 'string', required: true } },
});
const htmlDeclarative = (host: string, path: string, extraHosts: string[] = []) => ({
  schema_version: 1,
  kind: 'declarative',
  request: { method: 'GET', url: `${base(host)}${path}`, allowed_hosts: [host, ...extraHosts] },
  sources: [{ id: 'dom', from: 'html', records: 'body' }],
  fields: { id: { attr: 'text', type: 'string', required: true } },
});
const script = (host: string, startPath: string, source: string) => ({
  execution: 'playwright',
  scriptRef: 'inline',
  spec: { kind: 'script', allowed_hosts: [host], start_url: `${base(host)}${startPath}`, source },
});

/** Run échoué en robots_disallowed, sans agent, 0 requête sur /prive/, statut visé bloquee (transition 4). */
async function expectBlocked(apiId: string, run: Awaited<ReturnType<typeof runOf>>) {
  expect(run).toMatchObject({ state: 'failed', failure_class: 'robots_disallowed', retryable: false, items: 0, dataset_id: null });
  expect(await detailOf(run.id)).toBe('robots_disallowed');
  expect(await forbiddenHits(ROBOTS)).toBe(0);
  expect(repair).not.toHaveBeenCalled();
  const route = (await pool.query<{ data: Record<string, unknown> }>("SELECT data FROM run_logs WHERE run_id = $1 AND event = 'failure_route'", [run.id])).rows.map((r) => r.data);
  expect(route).toEqual([expect.objectContaining({ failure_class: 'robots_disallowed', next: 'stop', agent_invoked: false })]);
  // Machine à états appliquée par le test (câblage run → statut : 2.3) : enquete → bloquee, transition existante (21 au total).
  const res = await applyStatusTransition(pool, { apiId, runId: run.id, event: { type: 'run_failed', failureClass: 'robots_disallowed' }, clock: { now: () => new Date() } });
  expect(res.ok).toBe(true);
  expect((await pool.query<{ status: string }>('SELECT status FROM apis WHERE id = $1', [apiId])).rows[0]!.status).toBe('bloquee');
}

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
  browsers = new BrowserPool({ size: 1, launch: playwrightLauncher(launchProxy.url, process.env), recycleAfterRuns: 100 });
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

describe('assert_robots_respected : chemin interdit, 0 requête, robots_disallowed → bloquee, dans tous les modes', () => {
  test('E1 fetch : URL interdite', async () => {
    const apiId = await insertApi({ execution: 'fetch', spec: declarative(ROBOTS, '/prive/liste') });
    await expectBlocked(apiId, await runOf(apiId));
  }, 120_000);

  test('E2 fetch_in_page : URL de données interdite (page du site permise)', async () => {
    const apiId = await insertApi({ execution: 'fetch_in_page', spec: declarative(ROBOTS, '/prive/api') });
    await expectBlocked(apiId, await runOf(apiId));
  }, 120_000);

  test('E3 playwright déclaratif : page interdite', async () => {
    const apiId = await insertApi({ execution: 'playwright', spec: htmlDeclarative(ROBOTS, '/prive/page') });
    await expectBlocked(apiId, await runOf(apiId));
  }, 120_000);

  test('E3 en script : page de départ interdite', async () => {
    const apiId = await insertApi(script(ROBOTS, '/prive/depart', 'ctx.emit({ id: "x" });'));
    await expectBlocked(apiId, await runOf(apiId));
  }, 120_000);

  test('E3 en script : ctx.fetch vers un chemin interdit (page de départ permise)', async () => {
    const source = `try { await ctx.fetch('${base(ROBOTS)}/prive/donnees'); } catch (e) {} ctx.emit({ id: 'apres' });`;
    const apiId = await insertApi(script(ROBOTS, '/', source));
    await expectBlocked(apiId, await runOf(apiId));
    expect((await paths(ROBOTS))['/']).toBe(1);
  }, 120_000);

  test('E3 en script : ctx.page.goto vers un chemin interdit', async () => {
    const source = `try { await ctx.page.goto('${base(ROBOTS)}/prive/suite'); } catch (e) {} ctx.emit({ id: 'apres' });`;
    const apiId = await insertApi(script(ROBOTS, '/', source));
    await expectBlocked(apiId, await runOf(apiId));
  }, 120_000);

  test('robots.txt injoignable (503) : robots_unreachable, rien n’est collecté, aucun agent', async () => {
    const apiId = await insertApi({ execution: 'fetch', spec: declarative(UNREACHABLE, '/liste') });
    const run = await runOf(apiId);
    expect(run).toMatchObject({ state: 'failed', failure_class: 'robots_unreachable', retryable: true, items: 0, dataset_id: null });
    expect(Object.keys(await paths(UNREACHABLE)).filter((p) => p !== '/robots.txt')).toEqual([]);
    expect(repair).not.toHaveBeenCalled();
  }, 120_000);

  // Revue de 1.11 : la lecture de robots.txt suit ses redirections vers un autre hôte (RFC 9309 : CDN, apex → www), sous la
  // garde SSRF, sans le verrou de domaines de l'API (qui donnait à tort robots_unreachable).
  test('robots.txt redirigé vers un autre hôte : suivi ; ses règles s’appliquent (chemin interdit, chemin permis)', async () => {
    await client.control({ op: 'site', site: 'robots_redirect', cross: true });
    const blocked = await runOf(await insertApi({ execution: 'fetch', spec: declarative(OTHER, '/prive/x') }));
    expect(blocked).toMatchObject({ state: 'failed', failure_class: 'robots_disallowed', items: 0 });
    const ok = await runOf(await insertApi({ execution: 'fetch', spec: declarative(OTHER, '/liste') }));
    expect(ok).toMatchObject({ state: 'succeeded', items: 2 });
    expect(Object.keys(await paths(OTHER)).filter((p) => p.startsWith('/prive/'))).toEqual([]);
    expect((await paths(ROBOTS))['/robots.txt']).toBeGreaterThanOrEqual(1);
  }, 120_000);

  test('chemin permis (Allow plus long) : collecte normale ; User-Agent du navigateur suivi de celui du robot', async () => {
    const e1 = await runOf(await insertApi({ execution: 'fetch', spec: declarative(ROBOTS, '/prive/ouvert') }));
    expect(e1).toMatchObject({ state: 'succeeded', items: 2 });
    const source = `const ua = await ctx.page.evaluate('navigator.userAgent'); ctx.emit({ ua: String(ua) });`;
    const run = await runOf(await insertApi(script(ROBOTS, '/prive/ouvert', source), UA_SCHEMA));
    expect(run).toMatchObject({ state: 'succeeded', items: 1 });
    const item = (await withActor(pool, actorA, (tx) => tx.query<{ item: { ua: string } }>('SELECT item FROM dataset_items WHERE dataset_id = $1', [run.dataset_id]))).rows[0]!.item;
    expect(item.ua).toMatch(/Chrome\/[\d.]+.* Scrapyomama\/9\.9\.9 \(\+mailto:ops@zz-test\.example\)$/);
    expect(await forbiddenHits(ROBOTS)).toBe(0);
  }, 120_000);
});

// Revue de 1.11 : Playwright n'appelle `context.route` que pour la PREMIÈRE URL d'une chaîne de redirections, et le proxy
// d'egress ne voit pas le chemin (CONNECT en https). Chaque saut que Chromium suit est donc contrôlé à part (CDP Fetch,
// cadres hors processus compris : browser/request-guard.security.test.ts) : un chemin permis qui redirige vers un chemin interdit ne fait partir aucune requête
// vers celui-ci, en E2, en E3 déclaratif et en E3 en script (`ctx.page.goto`, `fetch` dans `evaluate`).
describe('assert_robots_respected : redirections suivies par Chromium (chaque saut contrôlé)', () => {
  test('E2 fetch_in_page : /depart (permis) → 302 /prive/x : 0 requête sur /prive/, robots_disallowed', async () => {
    const apiId = await insertApi({ execution: 'fetch_in_page', spec: declarative(ROBOTS, '/depart') });
    await expectBlocked(apiId, await runOf(apiId));
    expect((await paths(ROBOTS))['/depart']).toBe(1);
  }, 120_000);

  test('E3 playwright déclaratif : /depart → 302 /prive/x', async () => {
    const apiId = await insertApi({ execution: 'playwright', spec: htmlDeclarative(ROBOTS, '/depart') });
    await expectBlocked(apiId, await runOf(apiId));
    expect((await paths(ROBOTS))['/depart']).toBe(1);
  }, 120_000);

  test('E3 playwright déclaratif : redirection de barre oblique finale /prive → 301 /prive/', async () => {
    const apiId = await insertApi({ execution: 'playwright', spec: htmlDeclarative(ROBOTS, '/prive') });
    await expectBlocked(apiId, await runOf(apiId));
    expect((await paths(ROBOTS))['/prive']).toBe(1);
  }, 120_000);

  test('E3 en script : ctx.page.goto(/depart) → 302 /prive/x', async () => {
    const source = `try { await ctx.page.goto('${base(ROBOTS)}/depart'); } catch (e) {} ctx.emit({ id: 'apres' });`;
    const apiId = await insertApi(script(ROBOTS, '/', source));
    await expectBlocked(apiId, await runOf(apiId));
  }, 120_000);

  test('E3 en script : fetch(/depart) dans evaluate → 302 /prive/x', async () => {
    const source = `await ctx.page.evaluate("fetch('/depart').then((r) => r.status).catch(() => 0)"); ctx.emit({ id: 'apres' });`;
    const apiId = await insertApi(script(ROBOTS, '/', source));
    await expectBlocked(apiId, await runOf(apiId));
  }, 120_000);

  test('E3 déclaratif : redirection vers un second hôte autorisé dont robots.txt interdit le chemin', async () => {
    const apiId = await insertApi({ execution: 'playwright', spec: htmlDeclarative(ROBOTS, '/vers-autre', [OTHER]) });
    const run = await runOf(apiId);
    expect(run).toMatchObject({ state: 'failed', failure_class: 'robots_disallowed', items: 0, dataset_id: null });
    expect(Object.keys(await paths(OTHER)).filter((p) => p.startsWith('/prive/'))).toEqual([]);
    expect(repair).not.toHaveBeenCalled();
  }, 120_000);

  test('E2 : redirection vers un second hôte autorisé dont robots.txt répond 503 → robots_unreachable, 0 requête de contenu', async () => {
    const apiId = await insertApi({ execution: 'fetch_in_page', spec: declarative(ROBOTS, '/vers-injoignable', [UNREACHABLE]) });
    const run = await runOf(apiId);
    expect(run).toMatchObject({ state: 'failed', failure_class: 'robots_unreachable', retryable: true, items: 0, dataset_id: null });
    expect(Object.keys(await paths(UNREACHABLE)).filter((p) => p !== '/robots.txt')).toEqual([]);
    expect(repair).not.toHaveBeenCalled();
  }, 120_000);

  test('cadre d’un autre site autorisé : sous-ressource redirigée vers un chemin interdit, 0 requête', async () => {
    const run = await runOf(await insertApi({ execution: 'playwright', spec: htmlDeclarative(ROBOTS, '/page-cadre', [OTHER]) }));
    expect((await paths(OTHER))['/depart']).toBe(1);
    expect(Object.keys(await paths(OTHER)).filter((p) => p.startsWith('/prive/'))).toEqual([]);
    expect(run).toMatchObject({ state: 'succeeded' });
  }, 120_000);

  test('WebSocket ouvert par la page vers un chemin interdit : poignée de main jamais envoyée, le run continue', async () => {
    const run = await runOf(await insertApi(script(ROBOTS, '/page-ws', `await ctx.page.waitForSelector('#ws'); ctx.emit({ id: 'x' });`)));
    expect(await forbiddenHits(ROBOTS)).toBe(0);
    expect(run).toMatchObject({ state: 'succeeded', items: 1 });
  }, 120_000);

  test('WebSocket ouvert par le code du script (evaluate) vers un chemin interdit : 0 requête, robots_disallowed', async () => {
    const source = `await ctx.page.evaluate("new Promise((r) => { const w = new WebSocket('ws://' + location.host + '/prive/ws'); w.onclose = (e) => r(e.code); w.onopen = () => r(-1); setTimeout(() => r(0), 3000); })"); ctx.emit({ id: 'apres' });`;
    const apiId = await insertApi(script(ROBOTS, '/', source));
    await expectBlocked(apiId, await runOf(apiId));
  }, 120_000);
});
