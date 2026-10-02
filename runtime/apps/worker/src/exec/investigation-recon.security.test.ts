// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.1, correctifs de vérification, étage S (Chromium réel) : la passe E3 de reconnaissance
// - CLASSE chaque réponse `fetch` / XHR d'un domaine de l'API (INV6, comme la reconnaissance statique) : un 403 signé
//   par un éditeur de protection sur le point de données arrête l'enquête (`bloquee`), sans appel au LLM ni essai ;
// - capture le trafic vers un sous-domaine du site (04b §2 : page `www.…`, données sur `api.…`), proposé et retenu
//   (`allowed_hosts` = l'hôte des données), sans jamais contacter un tiers ;
// - identité (D-33) : la passe Chromium porte le User-Agent RÉEL du moteur (override CDP de `run-context`), sans jeton
//   d'instance ni `From` quand `identify_instance` est désactivé, comme l'étape 0 et les essais.
// Sites de test locaux (mini-site.testkit.ts), PostgreSQL : un conteneur propre à ce fichier.
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DomainPacer, generateMasterKey, MasterKey, Secret } from '@runtime/core';
import { buildUserAgent } from '@runtime/core/access';
import * as net from '@runtime/core/net';
import { keyCheck, listInvestigationEvents, migrateUp, PgBossJobQueue, PgPacingStore, readRun, runQueueDefinition, startInvestigation, withActor } from '@runtime/db';
import { createLlmClient, type LlmConfig } from '@runtime/llm';
import { createFakeProvider, scripted, type FakeProvider } from '@runtime/llm/testing';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { fixtureGuard } from '../../../../tests/helpers/fixture-net.ts';
import { installedEngineIdentity } from '../browser/engine-identity.js';
import { BrowserPool, playwrightLauncher } from '../browser/pool.js';
import { loadWorkerConfig } from '../config.js';
import { startMiniSite, type MiniResponse, type MiniSite } from '../testing/mini-site.testkit.js';
import { startWorker, type Worker } from '../worker.js';
import { createInvestigationExecutor, dispatchByKind } from './investigation-executor.js';
import { createStrategyRuntime } from './strategy-executor.js';

const SHIELD = 'zz_test_xhr_shield.localhost';
const SIB = 'www.zz_test_sib2.localhost';
const SIB_API = 'api.zz_test_sib2.localhost';
const EVIL = 'zz_test_evil2.localhost';
const MODEL = 'zz_investigate';
const A = randomUUID();
const actorA = { userId: A, role: 'member' as const };

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let site: MiniSite;
let worker: Worker;
let browsers: BrowserPool;
let launchProxy: net.EgressProxy;
let fake: FakeProvider;

const llmConfig = (): LlmConfig => ({
  providers: [{ id: 'fake', baseUrl: fake.baseUrl, apiKey: new Secret('zz-test-key-0000'), models: [{ id: MODEL, price: { in: 1, out: 1 } }] }],
  roles: { investigate: { provider: 'fake', model: MODEL } },
});

const PROPOSAL = {
  fields: [
    { name: 'sku', type: 'string', required: true, personal: false, description: 'Reference' },
    { name: 'title', type: 'string', required: true, personal: false, description: 'Title' },
  ],
  sources: [{ candidate: 'c1', paths: [{ field: 'sku', path: '$.id', ops: [] }, { field: 'title', path: '$.title', ops: [] }], pagination: { type: 'none', param: null, start: null, has_more_path: null, next_path: null } }],
};

async function investigate(slug: string, url: string) {
  const apiId = (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, domain_pacing) VALUES ($1, $2, '{"min_delay_ms": 5, "max_requests_per_run": 200, "max_wait_ms": 60000}') RETURNING id`,
      [slug, A],
    )
  ).rows[0]!.id;
  const { runId } = await withActor(pool, actorA, (tx) => startInvestigation(tx, queue, { apiId, ownerId: A, trigger: 'rest', request: { url, description: 'liste des articles', auto_validate: true } }));
  await vi.waitFor(async () => expect(['succeeded', 'failed']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), {
    timeout: 90_000,
    interval: 200,
  });
  return { apiId, run: (await withActor(pool, actorA, (tx) => readRun(tx, runId)))! };
}

beforeAll(async () => {
  site = await startMiniSite((req): MiniResponse | undefined => {
    if (req.path === '/robots.txt') return undefined;
    const items = { items: Array.from({ length: 6 }, (_, i) => ({ id: `zz_test_a${i + 1}`, title: `Article Zztest ${i + 1}` })) };
    switch (req.host) {
      case SHIELD:
        if (req.path === '/') return { body: '<html><body><h1>Articles</h1><script>fetch("/api/data").then((r) => r.text())</script></body></html>' };
        // Point de données protégé : 403 signé par un éditeur (DataDome), corps JSON.
        return req.path === '/api/data' ? { status: 403, headers: { 'content-type': 'application/json', 'x-datadome': 'protected' }, body: '{"url":"https://geo.captcha-delivery.com/captcha/?initialCid=zz_test"}' } : undefined;
      case SIB:
        return req.path === '/'
          ? { body: `<html><body><h1>Articles</h1><script src="/app.js"></script><script>fetch("${site.url(EVIL, '/collect.json')}")</script></body></html>` }
          : req.path === '/app.js'
            ? { headers: { 'content-type': 'text/javascript' }, body: `fetch(${JSON.stringify(site.url(SIB_API, '/v1/items?page=1'))}).then((r) => r.json());` }
            : undefined;
      case SIB_API:
        return req.path === '/v1/items' ? { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(items) } : undefined;
      case EVIL:
        return { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(items) };
      default:
        return undefined;
    }
  });
  container = await new PostgreSqlContainer(`postgres:${process.env.PG_VERSION ?? '16'}`).start();
  const url = container.getConnectionUri();
  await migrateUp({ connectionString: url });
  const masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: url, max: 8 });
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_inv_recon_s@example.test', 'active')", [A]);
  queue = new PgBossJobQueue({ connectionString: url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  fake = await createFakeProvider();
  const guard = fixtureGuard(site.port, [SHIELD, SIB, SIB_API, EVIL], net);
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
  await site?.close();
  await container?.stop();
}, 120_000);

beforeEach(() => {
  fake.reset();
  site.reset();
});

describe('reconnaissance E3 (Chromium) : réponses de données classées, sous-domaine du site', () => {
  test('XHR de la page refusé (403 signé, DataDome) → arrêt de la passe, bloquee, aucun gisement, aucun appel au LLM ni essai (INV6)', async () => {
    fake.setScenario(MODEL, [scripted.json(PROPOSAL)]);
    const { apiId, run } = await investigate('zz_test_inv_xhr_shield', site.url(SHIELD, '/'));
    expect(run).toMatchObject({ state: 'failed', failure_class: 'blocked_by_protection', retryable: false });
    expect((await pool.query<{ status: string }>('SELECT status FROM apis WHERE id = $1', [apiId])).rows[0]!.status).toBe('bloquee');
    expect(run.attempts).toEqual([]);
    expect(fake.requests).toBe(0);
    const recon = (await listInvestigationEvents(pool, { runId: run.id, ownerId: A })).find((e) => e.kind === 'reconnaissance.finished')!.payload as { mode: string; failure_class: string; candidates: unknown[] };
    expect(recon).toMatchObject({ mode: 'browser', failure_class: 'blocked_by_protection', candidates: [] });
    // Rien n'a insisté : le point protégé n'a été demandé qu'une fois (par la page).
    expect(site.hits.filter((h) => h.host === SHIELD && h.path === '/api/data')).toHaveLength(1);
  }, 120_000);

  test('XHR vers api.<site> (script externe de www.<site>) capturé et retenu, allowed_hosts = hôte des données ; un tiers jamais contacté', async () => {
    fake.setScenario(MODEL, [scripted.json(PROPOSAL)]);
    const { apiId, run } = await investigate('zz_test_inv_sibling_s', site.url(SIB, '/'));
    expect(run).toMatchObject({ state: 'succeeded', strategy_version: 1, items: 6 });
    const recon = (await listInvestigationEvents(pool, { runId: run.id, ownerId: A })).find((e) => e.kind === 'reconnaissance.finished')!.payload as { candidates: { request: { url: string } }[] };
    expect(recon.candidates.map((c) => c.request.url)).toEqual([site.url(SIB_API, '/v1/items')]);
    expect(run.attempts[0]).toMatchObject({ execution: 'fetch', network: 'direct', result: 'ok' });
    const sv = (await pool.query<{ spec: { request: { allowed_hosts: string[] } } }>('SELECT spec FROM strategy_versions WHERE api_id = $1', [apiId])).rows[0]!;
    expect(sv.spec.request.allowed_hosts).toEqual([SIB_API]);
    expect(site.hits.filter((h) => h.host === EVIL)).toEqual([]);
    // Toutes les requêtes reçues (robots.txt, étape 0, passe Chromium : page, script, XHR ; essais) : UA du moteur, sans From.
    const engineUa = buildUserAgent({ engine: installedEngineIdentity() });
    expect(engineUa).not.toMatch(/Scrapyomama|HeadlessChrome/);
    expect(site.hits.some((h) => h.path === '/app.js')).toBe(true);
    for (const h of site.hits) {
      expect(h.userAgent, `${h.host}${h.path}`).toBe(engineUa);
      expect(h.from, `${h.host}${h.path}`).toBeUndefined();
    }
  }, 120_000);
});
