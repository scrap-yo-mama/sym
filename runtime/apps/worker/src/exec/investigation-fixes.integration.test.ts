// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.1, correctifs de vérification, de bout en bout sur base réelle (file → worker → exécuteur d'enquête), faux
// fournisseur LLM, sites de test locaux à hôtes virtuels (mini-site.testkit.ts) et extension simulée (TunnelPort), sans
// navigateur :
// - tunnel : session requise ou tunnel seul → étape 0 et reconnaissance PAR L'EXTENSION (04 §4), extension hors ligne
//   (à l'étape 0 ou pendant les essais) → `action_requise` (transition 3), phase close, aucun essai ;
// - fins de configuration (réseau, identifiants de proxy) : phase close, récit fermé, statut quitté ;
// - échéance `investigation_timeout_s` tenue dès l'étape 0 ;
// - sous-domaine du site (04b §2 : `api.exemple.test`) proposé et retenu ; état de l'API sans valeur du site, retrouvé
//   au run suivant ; jamais copié par un clone ;
// - INV2 strict sur base réelle : E1 échoue (extraction) puis E4 réussit, ordre du plan suivi, absents élagués ;
// - sujet effacé : jamais réécrit dans le récit par l'échantillon d'une nouvelle enquête (17 §6) ;
// - une seule enquête à la fois par API.
import { randomUUID } from 'node:crypto';
import { DomainPacer, DslError, generateMasterKey, MasterKey, PersonalValueRegistry, Secret, type RunExecutor } from '@runtime/core';
import { attemptsFollowPlan, firstCostInversion, type TrialPair } from '@runtime/core/investigation';
import * as net from '@runtime/core/net';
import {
  cloneApi,
  createRun,
  countSubjectOccurrences,
  eraseSubject,
  keyCheck,
  listInvestigationEvents,
  loadSubjectKey,
  migrateUp,
  readCatalogMemory,
  PgBossJobQueue,
  PgPacingStore,
  readRun,
  runQueueDefinition,
  startInvestigation,
  validateInvestigationSchema,
  withActor,
} from '@runtime/db';
import { createLlmClient, type LlmConfig } from '@runtime/llm';
import { createFakeProvider, scripted, type FakeProvider } from '@runtime/llm/testing';
import pg from 'pg';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { fixtureGuard } from '../../../../tests/helpers/fixture-net.ts';
import { createTestDatabase, type TestDatabase } from '../../../../tests/helpers/pg.js';
import { ChromiumLaunchError } from '../browser/agent-browser.js';
import { loadWorkerConfig } from '../config.js';
import { miniTunnel, startMiniSite, type MiniSite } from '../testing/mini-site.testkit.js';
import { startWorker, type Worker } from '../worker.js';
import { createInvestigationExecutor, dispatchByKind } from './investigation-executor.js';
import { createStrategyRuntime } from './strategy-executor.js';

const SIB = 'www.zz_test_sib.localhost';
const SIB_API = 'api.zz_test_sib.localhost';
const FLAKY = 'zz_test_flaky.localhost';
const PEOPLE = 'zz_test_people.localhost';
const SLOW = 'zz_test_slow.localhost';
// Site connecté dans l'extension : un nom public (le tunnel refuse `*.localhost`, 07 §2), jamais résolu hors du test.
const TUN = 'zz-test-tun.example';
const HOSTS = [SIB, SIB_API, FLAKY, PEOPLE, SLOW, TUN];
const MODEL = 'zz_investigate';
const EXTRACT_MODEL = 'zz_extract';
const ERASED_EMAIL = 'zz_test_person_02@example.invalid';
const A = randomUUID();
const actorA = { userId: A, role: 'member' as const };

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let site: MiniSite;
let tunnel: ReturnType<typeof miniTunnel>;
let worker: Worker;
let fake: FakeProvider;
let masterKey: string;
let withExtract = false;
let price: { in: number; out: number } | undefined = { in: 1, out: 1 };
let extractPrice: { in: number; out: number } | undefined = { in: 1, out: 1 };
/** Repli du rôle `investigate` : un modèle SANS prix (revue fix-ux-11, point 9). */
let unpricedFallback = false;
const FALLBACK_MODEL = 'zz_fallback_unpriced';
/** Contact d'instance lu par les exécuteurs ; `null` : aucun (UX-04). */
let instanceContact: string | null = 'mailto:ops@zz-test.example';
/** Panne inattendue au départ de l'enquête (UX-24) : exception hors des fins prévues par l'exécuteur. */
let crash: Error | null = null;
/** Exception d'un essai de stratégie (UX-24, journal de l'opérateur) et lignes écrites par le journal de l'exécuteur d'enquête. */
let trialCrash: Error | null = null;
const logLines: string[] = [];

const products = (n: number, withTitle = true) => ({
  items: Array.from({ length: n }, (_, i) => ({ id: `zz_test_p${String(i + 1).padStart(3, '0')}`, ...(withTitle ? { title: `Produit Zztest ${i + 1}` } : {}), price_cents: 100 * (i + 1) })),
  has_more: false,
});
const json = (value: unknown, headers: Record<string, string> = {}) => ({ headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });
const page = (script: string) => ({ body: `<html><body><h1>Catalogue</h1><ul><li>Produit Zztest 1</li></ul><script>${script}</script></body></html>` });

function llmConfig(): LlmConfig {
  return {
    providers: [
      { id: 'fake', baseUrl: fake.baseUrl, apiKey: new Secret('zz-test-key-0000'), models: [{ id: MODEL, ...(price === undefined ? {} : { price: { ...price } }) }, { id: EXTRACT_MODEL, ...(extractPrice === undefined ? {} : { price: { ...extractPrice } }) }, { id: FALLBACK_MODEL }] },
    ],
    roles: { investigate: { provider: 'fake', model: MODEL, ...(unpricedFallback ? { fallback: { provider: 'fake', model: FALLBACK_MODEL } } : {}) }, ...(withExtract ? { extract: { provider: 'fake', model: EXTRACT_MODEL } } : {}) },
  };
}

async function insertApi(slug: string, options: { networkPolicy?: unknown; requiresSession?: boolean } = {}): Promise<string> {
  return (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, network_policy, requires_session, domain_pacing) VALUES ($1, $2, $3, $4, '{"min_delay_ms": 5, "max_requests_per_run": 200, "max_wait_ms": 60000}') RETURNING id`,
      [slug, A, JSON.stringify(options.networkPolicy ?? { allow: ['direct'] }), options.requiresSession ?? false],
    )
  ).rows[0]!.id;
}

const waitRun = async (runId: string) => {
  await vi.waitFor(async () => expect(['succeeded', 'failed', 'skipped_tunnel_offline']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), {
    timeout: 45_000,
    interval: 100,
  });
  return (await withActor(pool, actorA, (tx) => readRun(tx, runId)))!;
};

async function investigate(apiId: string, request: { url: string; description: string; auto_validate?: boolean; budget_usd?: number; timeout_s?: number }) {
  const { runId } = await withActor(pool, actorA, (tx) => startInvestigation(tx, queue, { apiId, ownerId: A, trigger: 'rest', request }));
  return waitRun(runId);
}

const apiRow = async (apiId: string) =>
  (
    await pool.query<{ status: string; status_reason: string | null; investigation_phase: string | null; current_strategy_version: number | null; investigation: unknown }>(
      'SELECT status, status_reason, investigation_phase, current_strategy_version, investigation FROM apis WHERE id = $1',
      [apiId],
    )
  ).rows[0]!;
/** Le worker ferme le run puis applique `run_stopped` (transition 3) : le statut de l'API suit la fin du run, il ne la précède pas. */
const apiStatusSettled = (apiId: string, expected: Record<string, unknown>) =>
  vi.waitFor(async () => expect(await apiRow(apiId)).toMatchObject(expected), { timeout: 10_000, interval: 50 });
const runRow = async (runId: string) =>
  (await pool.query<{ state: string; failure_class: string | null; error_detail: string | null }>('SELECT state, failure_class, error_detail FROM runs WHERE id = $1', [runId])).rows[0]!;
const eventsOf = (runId: string) => listInvestigationEvents(pool, { runId, ownerId: A });
const attemptsOf = async (runId: string) =>
  (await pool.query<{ execution: TrialPair['execution']; network: TrialPair['network']; est_cost_usd: string | null; result_class: string }>('SELECT execution, network, est_cost_usd, result_class FROM run_attempts WHERE run_id = $1 ORDER BY seq', [runId])).rows;

const PRODUCTS_PROPOSAL = {
  fields: [
    { name: 'sku', type: 'string', required: true, personal: false, description: 'Reference' },
    { name: 'title', type: 'string', required: true, personal: false, description: 'Title' },
    { name: 'price_cents', type: 'integer', required: true, personal: false, description: 'Prix en centimes' },
  ],
  sources: [
    {
      candidate: 'c1',
      paths: [
        { field: 'sku', path: '$.id', ops: [] },
        { field: 'title', path: '$.title', ops: [] },
        { field: 'price_cents', path: '$.price_cents', ops: [] },
      ],
      pagination: { type: 'none', param: null, start: null, has_more_path: null, next_path: null },
    },
  ],
};

const PEOPLE_PROPOSAL = {
  fields: [
    { name: 'id', type: 'string', required: true, personal: false, description: 'Identifier' },
    { name: 'name', type: 'string', required: true, personal: true, description: 'Name' },
    { name: 'email', type: 'string', required: true, personal: true, description: 'E-mail' },
  ],
  sources: [
    {
      candidate: 'c1',
      paths: [
        { field: 'id', path: '$.id', ops: [] },
        { field: 'name', path: '$.name', ops: [] },
        { field: 'email', path: '$.email', ops: [] },
      ],
      pagination: { type: 'none', param: null, start: null, has_more_path: null, next_path: null },
    },
  ],
};

beforeAll(async () => {
  site = await startMiniSite(async (req) => {
    if (req.path === '/robots.txt') return undefined;
    switch (req.host) {
      case SIB:
        // Page de www, données sur le sous-domaine api (04b §2), requête porteuse d'une valeur qui ne doit jamais être gardée.
        return req.path === '/' ? page(`fetch("${site.url(SIB_API, '/v1/items?page=1&q=zz_secret_query_value')}")`) : undefined;
      case SIB_API:
        return req.path === '/v1/items' ? json(products(8), { 'access-control-allow-origin': '*' }) : undefined;
      case FLAKY:
        if (req.path === '/') return page('fetch("/api/items")');
        // Bon à la reconnaissance, puis le champ requis `title` disparaît : E1 échoue en extraction (schema_mismatch).
        return req.path === '/api/items' ? json(products(6, req.n === 1)) : undefined;
      case PEOPLE:
        if (req.path === '/') return page('fetch("/api/people")');
        return req.path === '/api/people'
          ? json({ people: [1, 2, 3].map((i) => ({ id: `zz_test_person_0${i}`, name: `Zztest Personne ${i}`, email: `zz_test_person_0${i}@example.invalid` })) })
          : undefined;
      case SLOW:
        return req.path === '/' ? { ...page(''), delayMs: 4_000 } : undefined;
      case TUN:
        if (req.path === '/') return page('fetch("/api/items")');
        return req.path === '/api/items' ? json(products(5)) : undefined;
      default:
        return undefined;
    }
  });
  tunnel = miniTunnel(site);
  fake = await createFakeProvider();
  tdb = await createTestDatabase('investigation_fixes');
  await migrateUp({ connectionString: tdb.url });
  masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: tdb.url, max: 8 });
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_investigation_fixes@example.test', 'active')", [A]);
  // Proxys de l'admin : l'un pour chiffrer fetch/dc_proxy (jamais atteint), l'autre exige des identifiants (dépôt de secrets).
  await pool.query("INSERT INTO settings (key, value) VALUES ('proxies', $1)", [
    JSON.stringify([
      { id: 'zz_test_dc', type: 'dc', url: 'http://127.0.0.1:9', price: { per_gb_usd: 10 } },
      { id: 'zz_test_dc_auth', type: 'dc', url: 'http://127.0.0.1:9', credentials_secret_id: 'zz-test-proxy-secret', price: { per_gb_usd: 10 } },
    ]),
  ]);
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  const guard = fixtureGuard(site.port, HOSTS, net);
  const pacer = new DomainPacer(new PgPacingStore(pool));
  const agent = {
    llmConfig: async () => llmConfig(),
    client: (config: LlmConfig) => createLlmClient(config),
    engineFor: () => () => null,
    agentBrowser: async (): Promise<never> => {
      throw new Error('zz_test : aucun navigateur');
    },
  };
  const strategy = createStrategyRuntime({ pool, guard, pacer, browsers: null, agent, tunnel, instanceContact: async () => instanceContact, version: '9.9.9' });
  const investigation = createInvestigationExecutor({
    pool,
    guard,
    pacer,
    browsers: null,
    strategy: {
      ...strategy,
      trial: async (...args: Parameters<typeof strategy.trial>) => {
        if (trialCrash !== null) throw trialCrash;
        return strategy.trial(...args);
      },
    },
    logger: pino({ level: 'info' }, new Writable({ write: (chunk, _enc, done) => (logLines.push(String(chunk)), done()) })),
    tunnel,
    llm: { config: async () => llmConfig(), client: (config) => createLlmClient(config) },
    agentic: true,
    instanceContact: async () => instanceContact,
    version: '9.9.9',
    memory: {
      read: async (args) => {
        if (crash !== null) throw crash;
        return readCatalogMemory(pool, args);
      },
    },
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
  withExtract = false;
  price = { in: 1, out: 1 };
  extractPrice = { in: 1, out: 1 };
  unpricedFallback = false;
  crash = null;
  trialCrash = null;
  logLines.length = 0;
});

describe('enquête en tunnel (04 §4 : reconnaissance « en tunnel si la session est requise »)', () => {
  test('assert_investigation_tunnel_reconnaissance — politique « tunnel » seule : étape 0, reconnaissance et essais par l’extension, aucune requête du serveur, fetch/tunnel retenu', async () => {
    fake.setScenario(MODEL, [scripted.json(PRODUCTS_PROPOSAL)]);
    const apiId = await insertApi('zz_test_fix_tunnel_only', { networkPolicy: { allow: ['tunnel'] } });
    const run = await investigate(apiId, { url: site.url(TUN, '/'), description: 'liste des produits', auto_validate: true });
    expect(run).toMatchObject({ state: 'succeeded', strategy_version: 1, items: 5 });
    expect(run.attempts[0]).toMatchObject({ execution: 'fetch', network: 'tunnel', result: 'ok' });
    expect(await apiRow(apiId)).toMatchObject({ status: 'sain', investigation_phase: 'done' });
    const events = await eventsOf(run.id);
    const kinds = events.map((e) => e.kind);
    expect(kinds.indexOf('access_report')).toBeGreaterThan(-1);
    expect(kinds.indexOf('access_report')).toBeLessThan(kinds.indexOf('reconnaissance.finished'));
    expect((events.find((e) => e.kind === 'reconnaissance.finished')!.payload as { mode: string }).mode).toBe('tunnel');
    // Tout est passé par l'extension : le serveur n'a jamais contacté le site ; robots.txt jamais demandé (D-91).
    expect(site.hits.filter((h) => h.via === 'http')).toEqual([]);
    expect(site.hits.some((h) => h.path === '/robots.txt')).toBe(false);
    expect(site.hits.some((h) => h.path === '/api/items' && h.via === 'tunnel')).toBe(true);
  });

  test('assert_investigation_session_tunnel_only — session requise (politique « direct ») : étape 0, reconnaissance ET essais par l’extension, jamais par N1/N2 sans la session (04 §3.2)', async () => {
    fake.setScenario(MODEL, [scripted.json(PRODUCTS_PROPOSAL)]);
    const apiId = await insertApi('zz_test_fix_session', { requiresSession: true });
    const { runId } = await withActor(pool, actorA, (tx) => startInvestigation(tx, queue, { apiId, ownerId: A, trigger: 'rest', request: { url: site.url(TUN, '/'), description: 'liste', auto_validate: true } }));
    const run = await waitRun(runId);
    const events = await eventsOf(runId);
    expect((events.find((e) => e.kind === 'reconnaissance.finished')!.payload as { mode: string }).mode).toBe('tunnel');
    // Le plan des essais ne contient que le tunnel : un réseau serveur n'a pas la session de l'utilisateur.
    const testing = events.find((e) => e.kind === 'phase.started' && (e.payload as { phase?: string }).phase === 'testing');
    const plan = (testing!.payload as { plan: { network: string }[] }).plan;
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.every((p) => p.network === 'tunnel')).toBe(true);
    const attempts = await attemptsOf(runId);
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((a) => a.network === 'tunnel')).toBe(true);
    expect(run).toMatchObject({ state: 'succeeded' });
    expect(run.attempts[0]).toMatchObject({ execution: 'fetch', network: 'tunnel', result: 'ok' });
    // Aucune requête du serveur, de l'étape 0 au dernier essai : tout passe par l'extension.
    expect(site.hits.length).toBeGreaterThan(0);
    expect(site.hits.filter((h) => h.via === 'http')).toEqual([]);
  });

  test('extension hors ligne dès l’étape 0 → action_requise (transition 3, tunnel_offline), phase close, aucun essai ni appel LLM', async () => {
    fake.setScenario(MODEL, [scripted.json(PRODUCTS_PROPOSAL)]);
    tunnel.offlineWhen(() => true);
    const apiId = await insertApi('zz_test_fix_tunnel_offline', { networkPolicy: { allow: ['tunnel'] } });
    const run = await investigate(apiId, { url: site.url(TUN, '/'), description: 'liste', auto_validate: true });
    expect(await runRow(run.id)).toMatchObject({ state: 'failed', failure_class: null, error_detail: 'tunnel_offline' });
    await apiStatusSettled(apiId, { status: 'action_requise', status_reason: 'tunnel_offline', investigation_phase: 'done' });
    expect(run.attempts).toEqual([]);
    expect(fake.requests).toBe(0);
    const kinds = (await eventsOf(run.id)).map((e) => e.kind);
    expect(kinds).toContain('action.required');
    expect(kinds.at(-1)).toBe('investigation.finished');
    expect(site.hits).toEqual([]);
  });

  test('extension hors ligne pendant les essais → arrêt sans classe d’échec, action_requise (pas erreur), aucun essai journalisé', async () => {
    fake.setScenario(MODEL, [scripted.json(PRODUCTS_PROPOSAL)]);
    let itemsCalls = 0;
    // La reconnaissance lit /api/items une fois ; l'essai suivant trouve l'extension déconnectée.
    tunnel.offlineWhen((_cmd, url) => url.includes('/api/items') && ++itemsCalls > 1);
    const apiId = await insertApi('zz_test_fix_tunnel_offline_trial', { networkPolicy: { allow: ['tunnel'] } });
    const run = await investigate(apiId, { url: site.url(TUN, '/'), description: 'liste', auto_validate: true });
    expect(await runRow(run.id)).toMatchObject({ state: 'failed', failure_class: null, error_detail: 'tunnel_offline' });
    await apiStatusSettled(apiId, { status: 'action_requise', status_reason: 'tunnel_offline', investigation_phase: 'done' });
    expect(run.attempts).toEqual([]);
    const finished = (await eventsOf(run.id)).find((e) => e.kind === 'investigation.finished')!.payload as { outcome: string; at: string };
    expect(finished).toMatchObject({ outcome: 'stopped', at: 'testing' });
  });

  test('aucun client du tunnel dans ce worker → action_requise (tunnel manquant), phase close', async () => {
    const apiId = await insertApi('zz_test_fix_no_tunnel', { networkPolicy: { allow: ['tunnel'] } });
    await pool.query('UPDATE apis SET investigation = $2 WHERE id = $1', [apiId, JSON.stringify({ request: { url: site.url(TUN, '/'), description: 'x', auto_validate: true, budget_usd: 1, timeout_s: 60 }, spent_usd: 0, elapsed_ms: 0 })]);
    const executor = createInvestigationExecutor({ pool, guard: fixtureGuard(site.port, HOSTS, net), browsers: null, strategy: createStrategyRuntime({ pool, guard: fixtureGuard(site.port, HOSTS, net), browsers: null }), instanceContact: async () => instanceContact });
    const runId = (await pool.query<{ id: string }>("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, kind, state) VALUES ($1, $2, $2, 'rest', 'investigation', 'running') RETURNING id", [apiId, A])).rows[0]!.id;
    const result = await executor(directCtx(apiId, runId));
    expect((await eventsOf(runId)).map((e) => e.kind)).toEqual(['action.required', 'investigation.finished']);
    expect(result).toMatchObject({ state: 'failed', failure_class: null, stop_reason: 'tunnel_offline', error_detail: 'tunnel_unavailable' });
    expect((await apiRow(apiId)).investigation_phase).toBe('done');
    expect(site.hits).toEqual([]);
  });
});

describe('fins d’enquête : phase close et récit fermé', () => {
  test('politique réseau illisible → erreur (transition 2), phase done, investigation.finished', async () => {
    const apiId = await insertApi('zz_test_fix_bad_policy', { networkPolicy: { allow: 'direct' } });
    const run = await investigate(apiId, { url: site.url(TUN, '/'), description: 'liste', auto_validate: true });
    expect(run).toMatchObject({ state: 'failed', failure_class: 'code_error' });
    expect((await runRow(run.id)).error_detail).toBe('network_config');
    expect(await apiRow(apiId)).toMatchObject({ status: 'erreur', investigation_phase: 'done' });
    expect((await eventsOf(run.id)).map((e) => e.kind).at(-1)).toBe('investigation.finished');
  });

  test('identifiants du proxy requis illisibles → action_requise (proxy_not_configured), phase done, aucune requête', async () => {
    const apiId = await insertApi('zz_test_fix_proxy_secret', { networkPolicy: { allow: ['dc_proxy'], proxy_ids: { dc_proxy: 'zz_test_dc_auth' } } });
    const run = await investigate(apiId, { url: site.url(TUN, '/'), description: 'liste', auto_validate: true });
    expect(await runRow(run.id)).toMatchObject({ state: 'failed', failure_class: null, error_detail: 'proxy_credentials_unavailable' });
    await apiStatusSettled(apiId, { status: 'action_requise', status_reason: 'proxy_not_configured', investigation_phase: 'done' });
    expect((await eventsOf(run.id)).map((e) => e.kind).at(-1)).toBe('investigation.finished');
    expect(site.hits).toEqual([]);
  });

  test('UX-04/UX-05 — contact d’instance absent → action_requise (instance_contact_missing), jamais « budget épuisé » : 0 requête, 0 €, phase done', async () => {
    instanceContact = null;
    try {
      const apiId = await insertApi('zz_test_fix_no_contact');
      const run = await investigate(apiId, { url: site.url(TUN, '/'), description: 'liste', auto_validate: true });
      expect(await runRow(run.id)).toMatchObject({ state: 'failed', failure_class: null, error_detail: 'instance_contact_missing' });
      await apiStatusSettled(apiId, { status: 'action_requise', status_reason: 'instance_contact_missing', investigation_phase: 'done' });
      expect((await eventsOf(run.id)).map((e) => e.kind).at(-1)).toBe('investigation.finished');
      expect(site.hits).toEqual([]);
      expect(fake.requests).toBe(0);
    } finally {
      instanceContact = 'mailto:ops@zz-test.example';
    }
  });

  test('UX-11 — prix du modèle d’enquête absent → action_requise (llm_price_missing), jamais « budget épuisé » : le modèle est nommé, aucun appel LLM, 0 €', async () => {
    price = undefined;
    fake.setScenario(MODEL, [scripted.json(PRODUCTS_PROPOSAL)]);
    const apiId = await insertApi('zz_test_fix_no_price');
    const run = await investigate(apiId, { url: site.url(TUN, '/'), description: 'liste', auto_validate: true });
    expect(await runRow(run.id)).toMatchObject({ state: 'failed', failure_class: null, error_detail: `llm_price_missing:${MODEL}` });
    await apiStatusSettled(apiId, { status: 'action_requise', status_reason: 'llm_price_missing', investigation_phase: 'done' });
    const events = await eventsOf(run.id);
    expect(events.map((e) => e.kind).at(-1)).toBe('investigation.finished');
    expect(events.find((e) => e.kind === 'action.required')!.payload).toMatchObject({ cause: 'llm_price_missing', model: MODEL });
    expect(fake.requests).toBe(0);
  });

  test('revue fix-ux-11 (9) — repli du rôle investigate sans prix : arrêt AVANT l’appel, le repli est nommé, aucun appel LLM', async () => {
    unpricedFallback = true;
    fake.setScenario(MODEL, [scripted.json(PRODUCTS_PROPOSAL)]);
    const apiId = await insertApi('zz_test_fix_fallback_price');
    const run = await investigate(apiId, { url: site.url(TUN, '/'), description: 'liste', auto_validate: true });
    expect(await runRow(run.id)).toMatchObject({ state: 'failed', failure_class: null, error_detail: `llm_price_missing:${FALLBACK_MODEL}` });
    await apiStatusSettled(apiId, { status: 'action_requise', status_reason: 'llm_price_missing', investigation_phase: 'done' });
    expect((await eventsOf(run.id)).find((e) => e.kind === 'action.required')!.payload).toMatchObject({ cause: 'llm_price_missing', model: FALLBACK_MODEL });
    expect(fake.requests).toBe(0);
  });

  test('revue fix-ux-11 (3) — prix du rôle extract absent : l’essai E4 n’a pas lieu, action_requise llm_price_missing nomme le modèle extract (pas « budget »)', async () => {
    withExtract = true;
    extractPrice = undefined;
    fake.setScenario(MODEL, [scripted.json(PRODUCTS_PROPOSAL)]);
    fake.setScenario(EXTRACT_MODEL, [scripted.json({ items: [] })]);
    const apiId = await insertApi('zz_test_fix_extract_price', { networkPolicy: { allow: ['direct', 'dc_proxy'], proxy_ids: { dc_proxy: 'zz_test_dc' } } });
    const run = await investigate(apiId, { url: site.url(FLAKY, '/'), description: 'liste des produits', auto_validate: true });
    expect(await runRow(run.id)).toMatchObject({ state: 'failed', failure_class: null, error_detail: `llm_price_missing:${EXTRACT_MODEL}` });
    await apiStatusSettled(apiId, { status: 'action_requise', status_reason: 'llm_price_missing', investigation_phase: 'done' });
    const events = await eventsOf(run.id);
    expect(events.find((e) => e.kind === 'action.required')!.payload).toMatchObject({ cause: 'llm_price_missing', model: EXTRACT_MODEL });
    expect(events.map((e) => e.kind).at(-1)).toBe('investigation.finished');
    // Un seul appel LLM : la proposition du rôle investigate ; aucun appel du modèle extract.
    expect(fake.requests).toBe(1);
  });

  test('enquête toujours close (INV3, UX-24) — exception inattendue : statut quitté (erreur), phase done, investigation.finished avec la cause, error_detail lisible', async () => {
    crash = new DslError('value_too_large', 'texte extrait trop long');
    const apiId = await insertApi('zz_test_fix_crash');
    const run = await investigate(apiId, { url: site.url(SIB, '/'), description: 'liste', auto_validate: true });
    expect(run).toMatchObject({ state: 'failed', failure_class: 'code_error' });
    expect((await runRow(run.id)).error_detail).toBe('internal_error:DslError:value_too_large');
    await apiStatusSettled(apiId, { status: 'erreur', investigation_phase: 'done' });
    const events = await eventsOf(run.id);
    expect(events.map((e) => e.kind).at(-1)).toBe('investigation.finished');
    expect(events.at(-1)!.payload).toMatchObject({ outcome: 'failed', failure_class: 'code_error', detail: 'internal_error:DslError:value_too_large' });
    expect(events.map((e) => e.kind)).toContain('status.changed');
    expect(fake.requests).toBe(0);
  });

  test('API en enquête sans état d’enquête (investigation_not_started, UX-24) : run code_error, statut erreur, investigation.finished présent', async () => {
    const apiId = await insertApi('zz_test_fix_not_started');
    const { runId } = await withActor(pool, actorA, (tx) => createRun(tx, queue, { apiId, ownerId: A, trigger: 'rest', kind: 'investigation' }));
    const run = await waitRun(runId);
    expect(run).toMatchObject({ state: 'failed', failure_class: 'code_error' });
    expect((await runRow(runId)).error_detail).toBe('investigation_not_started');
    await apiStatusSettled(apiId, { status: 'erreur' });
    const events = await eventsOf(runId);
    expect(events.map((e) => e.kind).at(-1)).toBe('investigation.finished');
    expect(events.at(-1)!.payload).toMatchObject({ outcome: 'failed', failure_class: 'code_error', detail: 'investigation_not_started' });
  });

  test('journal de l’opérateur : un essai en erreur n’écrit jamais le message (valeur du site ou personnelle), seulement la classe et le code', async () => {
    fake.setScenario(MODEL, [scripted.json(PRODUCTS_PROPOSAL)]);
    trialCrash = new Error('navigation vers https://zz-test.example/?q=zz_test_valeur_personnelle_7');
    const apiId = await insertApi('zz_test_fix_trial_log');
    await investigate(apiId, { url: site.url(SIB, '/'), description: 'liste', auto_validate: true });
    const joined = logLines.join('');
    expect(joined).toContain('enquête : essai en erreur');
    expect(joined).not.toContain('zz_test_valeur_personnelle_7');
  });

  test('journal de l’opérateur : un lancement Chromium raté y garde le code et la fin de stderr ; l’événement et error_detail restent sans stderr', async () => {
    fake.setScenario(MODEL, [scripted.json(PRODUCTS_PROPOSAL)]);
    trialCrash = new ChromiumLaunchError('chromium_launch_signal:SIGTRAP', 'zz_stderr_marker : /home/pwuser/.config');
    const apiId = await insertApi('zz_test_fix_launch_log');
    const run = await investigate(apiId, { url: site.url(SIB, '/'), description: 'liste', auto_validate: true });
    const joined = logLines.join('');
    expect(joined).toContain('chromium_launch_signal:SIGTRAP');
    expect(joined).toContain('zz_stderr_marker');
    expect(JSON.stringify(await eventsOf(run.id))).not.toContain('zz_stderr_marker');
    expect((await runRow(run.id)).error_detail ?? '').not.toContain('zz_stderr_marker');
  });

  test('investigation_timeout_s tenu dès l’étape 0 (page lente) : erreur, investigation_timeout_s, sans attendre la page ni appeler le LLM', async () => {
    fake.setScenario(MODEL, [scripted.json(PRODUCTS_PROPOSAL)]);
    const apiId = await insertApi('zz_test_fix_timeout');
    const t0 = Date.now();
    const run = await investigate(apiId, { url: site.url(SLOW, '/'), description: 'liste', auto_validate: true, timeout_s: 1 });
    expect(run).toMatchObject({ state: 'failed', failure_class: 'run_budget_exceeded' });
    expect((await runRow(run.id)).error_detail).toBe('investigation_timeout_s');
    expect(await apiRow(apiId)).toMatchObject({ status: 'erreur', investigation_phase: 'done' });
    expect(fake.requests).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3_900);
  });
});

describe('domaines et état de l’enquête', () => {
  test('assert_investigation_state_no_site_values — sous-domaine api du site retenu (04b §2) ; état de l’API sans valeur de requête, gisement retrouvé au run suivant ; clone sans état d’enquête', async () => {
    fake.setScenario(MODEL, [scripted.json(PRODUCTS_PROPOSAL)]);
    const apiId = await insertApi('zz_test_fix_sibling');
    const first = await investigate(apiId, { url: site.url(SIB, '/'), description: 'liste des produits' });
    expect(first).toMatchObject({ state: 'succeeded', items: 0 });
    const recon = (await eventsOf(first.id)).find((e) => e.kind === 'reconnaissance.finished')!.payload as { candidates: { id: string; request: { url: string } }[] };
    expect(recon.candidates[0]).toMatchObject({ id: 'c1', request: { url: site.url(SIB_API, '/v1/items') } });
    // L'état gardé sur l'API (hors rétention, lisible des membres en visibilité instance) : aucune valeur du site.
    const stored = JSON.stringify((await apiRow(apiId)).investigation);
    expect(stored).toContain('/v1/items');
    expect(stored).not.toContain('zz_secret_query_value');
    expect(stored).not.toContain('Produit Zztest');

    // Run des essais : la reconnaissance relit les valeurs ; c1 retrouvé, fetch/direct sur le sous-domaine retenu.
    const { runId } = await withActor(pool, actorA, (tx) => validateInvestigationSchema(tx, queue, { apiId, ownerId: A, trigger: 'rest' }));
    const second = await waitRun(runId);
    expect(second).toMatchObject({ state: 'succeeded', strategy_version: 1, items: 8 });
    expect(second.attempts[0]).toMatchObject({ execution: 'fetch', network: 'direct', result: 'ok' });
    const sv = (await pool.query<{ spec: { request: { url: string; allowed_hosts: string[] } } }>('SELECT spec FROM strategy_versions WHERE api_id = $1', [apiId])).rows[0]!;
    expect(sv.spec.request.allowed_hosts).toEqual([SIB_API]);
    expect(sv.spec.request.url).toContain('zz_secret_query_value');
    expect(JSON.stringify((await apiRow(apiId)).investigation)).not.toContain('zz_secret_query_value');
    expect(fake.requests).toBe(1);

    // Clone pour un autre propriétaire : l'état d'enquête (demande, gisements) ne suit jamais.
    const B = randomUUID();
    await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_investigation_fixes_b@example.test', 'active')", [B]);
    const clone = await cloneApi(pool, { apiId, fromOwnerId: A, toOwnerId: B });
    expect((await pool.query<{ investigation: unknown }>('SELECT investigation FROM apis WHERE id = $1', [clone.id])).rows[0]!.investigation).toBeNull();
  });

  test('assert_cheapest_first_logged (base réelle, ordre strict) — E1 échoue en extraction, E1/N2 et E4/N2 élagués, E4/N1 retenu ; run_attempts suit l’ordre du plan', async () => {
    withExtract = true;
    fake.setScenario(MODEL, [scripted.json(PRODUCTS_PROPOSAL)]);
    const items = { items: [1, 2, 3].map((i) => ({ sku: `zz_test_p00${i}`, title: `Produit Zztest ${i}`, price_cents: 100 * i })) };
    fake.setScenario(EXTRACT_MODEL, [scripted.json(items), scripted.json(items), scripted.json(items)]);
    const apiId = await insertApi('zz_test_fix_order', { networkPolicy: { allow: ['direct', 'dc_proxy'], proxy_ids: { dc_proxy: 'zz_test_dc' } } });
    const run = await investigate(apiId, { url: site.url(FLAKY, '/'), description: 'liste des produits', auto_validate: true });
    expect(run).toMatchObject({ state: 'succeeded', strategy_version: 1, items: 3 });
    const attempts = await attemptsOf(run.id);
    expect(attempts.map((a) => `${a.execution}/${a.network}/${a.result_class}`)).toEqual(['fetch/direct/extraction', 'agent_fetch/direct/ok']);
    expect(firstCostInversion(attempts.map((a) => (a.est_cost_usd === null ? null : Number(a.est_cost_usd))))).toBe(-1);
    const events = await eventsOf(run.id);
    const plan = (events.find((e) => e.kind === 'phase.started' && (e.payload as { phase: string }).phase === 'testing')!.payload as { plan: TrialPair[] }).plan;
    const pruned = events.filter((e) => e.kind === 'attempt.pruned').flatMap((e) => (e.payload as { pruned: TrialPair[] }).pruned);
    expect(pruned.map((p) => `${p.execution}/${p.network}`).sort()).toEqual(['agent_fetch/dc_proxy', 'fetch/dc_proxy']);
    const sources = events.filter((e) => e.kind === 'attempt.finished').map((e) => (e.payload as { source: string }).source);
    const tried = attempts.map((a, i) => ({ execution: a.execution, network: a.network, source: sources[i]!, est_cost_usd: Number(a.est_cost_usd) }));
    // 04 §3.3 : la suite est STRICTEMENT celle du plan (coût, puis E, puis N), chaque couple absent élagué et journalisé.
    expect(attemptsFollowPlan(plan, tried, pruned)).toBe(-1);
    expect((await pool.query<{ execution: string }>('SELECT execution FROM strategy_versions WHERE api_id = $1', [apiId])).rows).toEqual([{ execution: 'agent_fetch' }]);
  });

  test('assert_investigation_sample_excludes_erased — sujet effacé : la nouvelle enquête ne le réécrit pas dans le récit (échantillon filtré par la liste d’exclusion)', async () => {
    const keyring = { current: MasterKey.parse(masterKey) };
    const key = await loadSubjectKey(pool, keyring, await keyCheck(pool, keyring));
    const req = { values: [ERASED_EMAIL], key, actor: { userId: A, via: 'ui' as const }, scope: { ownerId: A } };
    const dry = await eraseSubject(pool, req, { dryRun: true });
    await eraseSubject(pool, req, { confirm: dry.plan.confirmation });

    fake.setScenario(MODEL, [scripted.json(PEOPLE_PROPOSAL)]);
    const apiId = await insertApi('zz_test_fix_erased');
    const run = await investigate(apiId, { url: site.url(PEOPLE, '/'), description: 'liste des personnes' });
    expect(run).toMatchObject({ state: 'succeeded' });
    const proposed = (await eventsOf(run.id)).find((e) => e.kind === 'schema.proposed')!.payload as { sample: { email: string }[] };
    expect(proposed.sample.map((s) => s.email)).toEqual(['zz_test_person_01@example.invalid', 'zz_test_person_03@example.invalid']);
    // « Un run suivant ne la réécrit pas » (assert_erasure_complete) : 0 occurrence, récit compris.
    expect(await countSubjectOccurrences(pool, [ERASED_EMAIL], { ownerId: A })).toEqual({});
    expect((await pool.query("SELECT 1 FROM run_logs WHERE run_id = $1 AND event = 'subjects_excluded'", [run.id])).rowCount).toBe(1);
  });

  test('une seule enquête à la fois par API : relance refusée tant qu’un run d’enquête est en file (investigation_in_progress)', async () => {
    fake.setScenario(MODEL, [scripted.json(PRODUCTS_PROPOSAL), scripted.json(PRODUCTS_PROPOSAL)]);
    const apiId = await insertApi('zz_test_fix_concurrent');
    const request = { url: site.url(TUN, '/'), description: 'liste' };
    const runId = await withActor(pool, actorA, async (tx) => {
      const started = await startInvestigation(tx, queue, { apiId, ownerId: A, trigger: 'rest', request });
      await expect(startInvestigation(tx, queue, { apiId, ownerId: A, trigger: 'rest', request })).rejects.toMatchObject({ code: 'investigation_in_progress' });
      return started.runId;
    });
    await waitRun(runId);
    expect((await pool.query("SELECT count(*)::int AS n FROM runs WHERE api_id = $1 AND kind = 'investigation'", [apiId])).rows[0]).toEqual({ n: 1 });
    // Run fini : une nouvelle enquête est admise.
    const again = await withActor(pool, actorA, (tx) => startInvestigation(tx, queue, { apiId, ownerId: A, trigger: 'rest', request }));
    await waitRun(again.runId);
  });
});

/** Contexte de run minimal pour un appel direct de l'exécuteur (hors worker). */
function directCtx(apiId: string, runId: string) {
  return {
    runId,
    apiId,
    ownerId: A,
    strategyVersion: null,
    input: null,
    kind: 'investigation' as const,
    signal: new AbortController().signal,
    recordAttempt: async () => undefined,
    log: async () => undefined,
    personal: new PersonalValueRegistry(),
    excludeSubjects: <T>(_s: unknown, items: readonly T[]) => ({ kept: [...items], dropped: 0 }),
    writeItems: async () => ({ dataset_id: '', written: 0, new_items: null, dropped: 0, skipped: 0 }),
  };
}
