// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.1, correctifs de revue, de bout en bout sur base réelle (file → worker → exécuteur d'enquête), faux fournisseur
// LLM, sites de test locaux (mini-site.testkit.ts) et extension simulée, sans navigateur :
// - identité du robot (D-33, 17 §5) : User-Agent RÉEL du moteur par défaut, sans jeton ni `From`, de l'étape 0 aux
//   essais ; avec `identify_instance`, le jeton et `From` ; le contact reste exigé avant toute enquête ;
// - fins sans stratégie conforme quelle que soit la classe du dernier essai (5xx persistants, LLM sans repli) : statut
//   `erreur` (transition 2), phase close, récit fermé (04 §6, INV3) ;
// - enquête lancée seulement sur une API `enquete` : la ré-enquête (16-20) n'est pas exposée par 2.1 ;
// - URL de demande sans secret : jamais gardée dans l'état de l'API (hors rétention) ;
// - reconnaissance en tunnel : une URL d'action d'un script en ligne (`fetch("/logout")`) n'est jamais rejouée avec la
//   session de l'utilisateur.
import { randomUUID } from 'node:crypto';
import { DomainPacer, generateMasterKey, MasterKey, Secret, type RunExecutor } from '@runtime/core';
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
import { createTestDatabase, type TestDatabase } from '../../../../tests/helpers/pg.js';
import { loadWorkerConfig } from '../config.js';
import { miniTunnel, startMiniSite, type MiniSite } from '../testing/mini-site.testkit.js';
import { startWorker, type Worker } from '../worker.js';
import { createInvestigationExecutor, dispatchByKind } from './investigation-executor.js';
import { createStrategyRuntime } from './strategy-executor.js';

const SHOP = 'zz_test_rv_shop.localhost';
const DOWN = 'zz_test_rv_down.localhost';
// Site connecté dans l'extension : un nom public (le tunnel refuse `*.localhost`, 07 §2), jamais résolu hors du test.
const TUN = 'zz-test-rv-tun.example';
const HOSTS = [SHOP, DOWN, TUN];
const MODEL = 'zz_investigate';
const CONTACT = 'mailto:ops@zz-test.example';
const A = randomUUID();
const actorA = { userId: A, role: 'member' as const };

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let site: MiniSite;
let tunnel: ReturnType<typeof miniTunnel>;
let worker: Worker;
let fake: FakeProvider;
let identify = false;

const products = (n: number) => ({ items: Array.from({ length: n }, (_, i) => ({ id: `zz_test_p${String(i + 1).padStart(3, '0')}`, title: `Produit Zztest ${i + 1}`, price_cents: 100 * (i + 1) })), has_more: false });
const json = (value: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
const page = (script: string) => ({ body: `<html><body><h1>Catalogue</h1><ul><li>Produit Zztest 1</li></ul><script>${script}</script></body></html>` });

const llmConfig = (): LlmConfig => ({
  providers: [{ id: 'fake', baseUrl: fake.baseUrl, apiKey: new Secret('zz-test-key-0000'), models: [{ id: MODEL, price: { in: 1, out: 1 } }] }],
  roles: { investigate: { provider: 'fake', model: MODEL } },
});

const PROPOSAL = {
  fields: [
    { name: 'sku', type: 'string', required: true, personal: false, description: 'Reference' },
    { name: 'title', type: 'string', required: true, personal: false, description: 'Title' },
  ],
  sources: [
    {
      candidate: 'c1',
      paths: [
        { field: 'sku', path: '$.id', ops: [] },
        { field: 'title', path: '$.title', ops: [] },
      ],
      pagination: { type: 'none', param: null, start: null, has_more_path: null, next_path: null },
    },
  ],
};

async function insertApi(slug: string, options: { networkPolicy?: unknown; status?: string } = {}): Promise<string> {
  return (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, network_policy, status, domain_pacing) VALUES ($1, $2, $3, $4, '{"min_delay_ms": 5, "max_requests_per_run": 200, "max_wait_ms": 60000}') RETURNING id`,
      [slug, A, JSON.stringify(options.networkPolicy ?? { allow: ['direct'] }), options.status ?? 'enquete'],
    )
  ).rows[0]!.id;
}

const waitRun = async (runId: string) => {
  await vi.waitFor(async () => expect(['succeeded', 'failed', 'skipped_tunnel_offline']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), {
    timeout: 60_000,
    interval: 100,
  });
  return (await withActor(pool, actorA, (tx) => readRun(tx, runId)))!;
};

async function investigate(apiId: string, request: { url: string; description: string; auto_validate?: boolean }) {
  const { runId } = await withActor(pool, actorA, (tx) => startInvestigation(tx, queue, { apiId, ownerId: A, trigger: 'rest', request }));
  return waitRun(runId);
}

const apiRow = async (apiId: string) =>
  (await pool.query<{ status: string; status_reason: string | null; investigation_phase: string | null; investigation: unknown }>('SELECT status, status_reason, investigation_phase, investigation FROM apis WHERE id = $1', [apiId])).rows[0]!;
const kindsOf = async (runId: string) => (await listInvestigationEvents(pool, { runId, ownerId: A })).map((e) => e.kind);

beforeAll(async () => {
  site = await startMiniSite(async (req) => {
    if (req.path === '/robots.txt') return undefined;
    switch (req.host) {
      case SHOP:
        if (req.path === '/') return page('fetch("/api/items")');
        return req.path === '/api/items' ? json(products(5)) : undefined;
      case DOWN:
        if (req.path === '/') return page('fetch("/api/items")');
        // Bon à la reconnaissance, puis 503 persistants : chaque voie essayée échoue en `transient`.
        return req.path === '/api/items' ? (req.n === 1 ? json(products(5)) : { status: 503, body: 'service unavailable' }) : undefined;
      case TUN:
        // Gestionnaire de clic : `/logout` n'est jamais appelé au chargement ; la reconnaissance ne doit pas le rejouer.
        if (req.path === '/') return page('document.body.onclick = () => fetch("/logout"); fetch("/api/items")');
        if (req.path === '/logout') return { body: 'logged out' };
        return req.path === '/api/items' ? json(products(4)) : undefined;
      default:
        return undefined;
    }
  });
  tunnel = miniTunnel(site);
  fake = await createFakeProvider();
  tdb = await createTestDatabase('investigation_review');
  await migrateUp({ connectionString: tdb.url });
  const masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: tdb.url, max: 8 });
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_investigation_review@example.test', 'active')", [A]);
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  const guard = fixtureGuard(site.port, HOSTS, net);
  const pacer = new DomainPacer(new PgPacingStore(pool));
  const identity = { instanceContact: async () => CONTACT, identifyInstance: async () => identify, version: '9.9.9' };
  const strategy = createStrategyRuntime({ pool, guard, pacer, browsers: null, tunnel, ...identity });
  const investigation = createInvestigationExecutor({
    pool,
    guard,
    pacer,
    browsers: null,
    strategy,
    tunnel,
    llm: { config: async () => llmConfig(), client: (config) => createLlmClient(config) },
    ...identity,
  });
  const executor: RunExecutor = dispatchByKind({ run: strategy.executor, investigation });
  worker = await startWorker({
    config: loadWorkerConfig({ DATABASE_URL: tdb.url, MASTER_KEY: masterKey, QUEUE_POLLING_SECONDS: '0.5', RUN_HEARTBEAT_SECONDS: '0.5', RUN_STALE_SECONDS: '10', BROWSER_CONCURRENCY: '1' }),
    executor,
    logger: pino({ level: 'silent' }),
  });
}, 180_000);

afterAll(async () => {
  await worker?.stop();
  await queue?.stop({ timeoutMs: 1000 });
  await pool?.end();
  await tdb?.drop();
  await fake?.close();
  await site?.close();
});

beforeEach(() => {
  fake.reset();
  site.reset();
  tunnel.offlineWhen(null);
  tunnel.sent.length = 0;
  identify = false;
});

describe('identité du robot pendant l’enquête (D-33, 17 §5)', () => {
  test('assert_user_agent_engine_real — identify_instance désactivé (défaut) : User-Agent du moteur, sans jeton ni From, de l’étape 0 aux essais', async () => {
    fake.setScenario(MODEL, [scripted.json(PROPOSAL)]);
    const apiId = await insertApi('zz_test_rv_ua_engine');
    const run = await investigate(apiId, { url: site.url(SHOP, '/'), description: 'liste des produits', auto_validate: true });
    expect(run).toMatchObject({ state: 'succeeded', strategy_version: 1 });
    const engineUa = buildUserAgent({ engine: installedEngineIdentity() });
    const hits = site.hits.filter((h) => h.via === 'http');
    // Page (étape 0 et reconnaissance), point de données (reconnaissance et essais) ; robots.txt jamais demandé (D-91).
    expect(hits.map((h) => h.path)).toEqual(expect.arrayContaining(['/', '/api/items']));
    expect(hits.map((h) => h.path)).not.toContain('/robots.txt');
    for (const h of hits) {
      expect(h.userAgent, h.path).toBe(engineUa);
      expect(h.from, h.path).toBeUndefined();
    }
    expect(engineUa).not.toContain('Scrapyomama');
  });

  test('identify_instance activé : jeton `Scrapyomama/<version>` et en-tête From à chaque requête de l’enquête', async () => {
    identify = true;
    fake.setScenario(MODEL, [scripted.json(PROPOSAL)]);
    const apiId = await insertApi('zz_test_rv_ua_identify');
    const run = await investigate(apiId, { url: site.url(SHOP, '/'), description: 'liste des produits', auto_validate: true });
    expect(run).toMatchObject({ state: 'succeeded' });
    const hits = site.hits.filter((h) => h.via === 'http');
    expect(hits.length).toBeGreaterThan(2);
    for (const h of hits) {
      expect(h.userAgent, h.path).toContain('Scrapyomama/9.9.9');
      expect(h.userAgent, h.path).toContain(buildUserAgent({ engine: installedEngineIdentity() }));
      expect(h.from, h.path).toBe('ops@zz-test.example');
    }
  });
});

describe('fin sans stratégie conforme : erreur quelle que soit la classe du dernier essai (04 §6, transition 2)', () => {
  test('toutes les voies en 503 persistants → erreur (investigation_budget_exhausted), phase done, récit fermé', async () => {
    fake.setScenario(MODEL, [scripted.json(PROPOSAL)]);
    const apiId = await insertApi('zz_test_rv_all_503');
    const run = await investigate(apiId, { url: site.url(DOWN, '/'), description: 'liste des produits', auto_validate: true });
    expect(run).toMatchObject({ state: 'failed', failure_class: 'transient' });
    expect(run.attempts.length).toBeGreaterThan(0);
    expect(run.attempts.every((a) => a.result === 'transient')).toBe(true);
    expect(await apiRow(apiId)).toMatchObject({ status: 'erreur', status_reason: 'investigation_budget_exhausted', investigation_phase: 'done' });
    expect((await kindsOf(run.id)).at(-1)).toBe('investigation.finished');
  });

  test('LLM sans repli à l’appel `investigate` (401 → llm_auth) → erreur, phase done, récit fermé', async () => {
    fake.setScenario(MODEL, [scripted.error(401, { error: { message: 'invalid key' } })]);
    const apiId = await insertApi('zz_test_rv_llm_auth');
    const run = await investigate(apiId, { url: site.url(SHOP, '/'), description: 'liste des produits', auto_validate: true });
    expect(run).toMatchObject({ state: 'failed', failure_class: 'llm_auth' });
    expect(await apiRow(apiId)).toMatchObject({ status: 'erreur', investigation_phase: 'done' });
    expect((await kindsOf(run.id)).at(-1)).toBe('investigation.finished');
  });
});

describe('démarrage d’une enquête', () => {
  test.each(['erreur', 'bloquee', 'sain', 'action_requise'])('API en `%s` : refus (reinvestigation_required), aucun run, état inchangé', async (status) => {
    const apiId = await insertApi(`zz_test_rv_status_${status}`, { status });
    await expect(withActor(pool, actorA, (tx) => startInvestigation(tx, queue, { apiId, ownerId: A, trigger: 'rest', request: { url: site.url(SHOP, '/'), description: 'x' } }))).rejects.toMatchObject({
      code: 'reinvestigation_required',
    });
    expect((await pool.query('SELECT 1 FROM runs WHERE api_id = $1', [apiId])).rowCount).toBe(0);
    expect(await apiRow(apiId)).toMatchObject({ status, investigation_phase: null, investigation: null });
  });

  test('assert_investigation_state_no_site_values (request.url, page.url) — URL avec un jeton en paramètre : refusée, rien n’est gardé', async () => {
    const apiId = await insertApi('zz_test_rv_secret_url');
    for (const query of ['token=zz_secret_token_value', 'api_key=zz_secret_token_value', 'session=zz_secret_token_value']) {
      await expect(
        withActor(pool, actorA, (tx) => startInvestigation(tx, queue, { apiId, ownerId: A, trigger: 'rest', request: { url: site.url(SHOP, `/?${query}`), description: 'x' } })),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(await apiRow(apiId)).toMatchObject({ investigation: null });
    expect(JSON.stringify((await pool.query('SELECT investigation FROM apis WHERE id = $1', [apiId])).rows)).not.toContain('zz_secret_token_value');
  });
});

describe('reconnaissance en tunnel : aucune URL d’action rejouée avec la session de l’utilisateur', () => {
  test('`fetch("/logout")` dans un gestionnaire de clic : 0 requête vers /logout, le point de données est lu', async () => {
    fake.setScenario(MODEL, [scripted.json(PROPOSAL)]);
    const apiId = await insertApi('zz_test_rv_tunnel_logout', { networkPolicy: { allow: ['tunnel'] } });
    const run = await investigate(apiId, { url: site.url(TUN, '/'), description: 'liste des produits', auto_validate: true });
    expect(run).toMatchObject({ state: 'succeeded' });
    expect(site.hits.filter((h) => h.path === '/logout')).toEqual([]);
    expect(tunnel.sent.filter((s) => s.url.includes('/logout'))).toEqual([]);
    expect(site.hits.some((h) => h.path === '/api/items' && h.via === 'tunnel')).toBe(true);
    // assert_accept_language_engine_real (21 § 6.4, § 6.6) : en tunnel, la langue envoyée est celle du navigateur de
    // l'utilisateur ; le rapport d'accès le dit (source user_browser), sans valeur inventée ni « aucune » (null).
    const access = (await listInvestigationEvents(pool, { runId: run.id, ownerId: A })).find((e) => e.kind === 'access_report');
    const view = (access?.payload as { view?: Record<string, unknown> } | undefined)?.view;
    expect(view).toMatchObject({ accept_language_source: 'user_browser' });
    expect(view).not.toHaveProperty('accept_language');
  });
});
