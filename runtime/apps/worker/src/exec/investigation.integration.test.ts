// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.1 de bout en bout sur base réelle, faux fournisseur LLM (15 §4), fixtures locales (0.5), sans navigateur
// (DISABLE_BROWSER : reconnaissance statique) : enquête mise en file côté web (`startInvestigation`) → worker (1.3) →
// exécuteur choisi par `runs.kind` → étape 0 (rapport d'accès, 1.11) → reconnaissance → schéma de sortie proposé par le
// rôle `investigate` (squelettes seulement) → essais du moins cher au plus cher par l'exécuteur de stratégie (1.6, 1.7,
// 1.9) → stratégie v1, résultat livré, statut (1.2).
// Critères : `assert_cheapest_first_logged` (fixture API JSON : `fetch/direct` retenu), fixture Next : E1 `embedded`,
// budget dépassé → `erreur`, validation du schéma en deux temps (`validate_schema`), étape 0 d'abord
// (`assert_access_report_first`), robots.txt interdit → `bloquee` sans LLM ni requête.
import { randomUUID } from 'node:crypto';
import { DomainPacer, generateMasterKey, MasterKey, Secret, validateOutput, type RunExecutor } from '@runtime/core';
import { firstCostInversion } from '@runtime/core/investigation';
import * as net from '@runtime/core/net';
import {
  keyCheck,
  listInvestigationEvents,
  migrateUp,
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
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { startClient, type Client } from '../../../../fixtures/src/test-helpers.ts';
import { fixtureGuard } from '../../../../tests/helpers/fixture-net.ts';
import { createTestDatabase, type TestDatabase } from '../../../../tests/helpers/pg.js';
import { loadWorkerConfig } from '../config.js';
import { startWorker, type Worker } from '../worker.js';
import { createInvestigationExecutor, dispatchByKind } from './investigation-executor.js';
import { createStrategyRuntime } from './strategy-executor.js';

const API_HOST = 'zz_test_api_json.localhost';
const NEXT_HOST = 'zz_test_next.localhost';
const ROBOTS_HOST = 'zz_test_robots.localhost';
const CHALLENGE_HOST = 'zz_test_challenge_200.localhost';
const SSR_HOST = 'zz_test_ssr.localhost';
const EXTRACT_MODEL = 'zz_extract';
const MODEL = 'zz_investigate';
const A = randomUUID();
const actorA = { userId: A, role: 'member' as const };

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let client: Client;
let worker: Worker;
let fake: FakeProvider;
/** Prix du modèle d'enquête (USD par million de jetons) : relevé pour le test du budget. */
let price = { in: 1, out: 1 };
/** Rôle `extract` configuré (voie E4) : seulement pour le test de la page sans gisement. */
let withExtract = false;

const base = (host: string) => `http://${host}:${client.server.port}`;

function llmConfig(): LlmConfig {
  return {
    providers: [
      { id: 'fake', baseUrl: fake.baseUrl, apiKey: new Secret('zz-test-key-0000'), models: [{ id: MODEL, price: { ...price } }, { id: EXTRACT_MODEL, price: { in: 1, out: 1 } }] },
    ],
    roles: { investigate: { provider: 'fake', model: MODEL }, ...(withExtract ? { extract: { provider: 'fake', model: EXTRACT_MODEL } } : {}) },
  };
}

async function insertApi(slug: string, networkPolicy: unknown = { allow: ['direct'] }): Promise<string> {
  return (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, network_policy, domain_pacing) VALUES ($1, $2, $3, '{"min_delay_ms": 5, "max_requests_per_run": 200, "max_wait_ms": 60000}') RETURNING id`,
      [slug, A, JSON.stringify(networkPolicy)],
    )
  ).rows[0]!.id;
}

const waitRun = async (runId: string) => {
  await vi.waitFor(async () => expect(['succeeded', 'failed']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), {
    timeout: 45_000,
    interval: 100,
  });
  return (await withActor(pool, actorA, (tx) => readRun(tx, runId)))!;
};

async function investigate(apiId: string, request: { url: string; description: string; auto_validate?: boolean; budget_usd?: number }) {
  const { runId } = await withActor(pool, actorA, (tx) => startInvestigation(tx, queue, { apiId, ownerId: A, trigger: 'rest', request }));
  return waitRun(runId);
}

const apiRow = async (apiId: string) =>
  (
    await pool.query<{ status: string; status_reason: string | null; investigation_phase: string | null; current_strategy_version: number | null; output_schema: unknown; input_schema: unknown }>(
      'SELECT status, status_reason, investigation_phase, current_strategy_version, output_schema, input_schema FROM apis WHERE id = $1',
      [apiId],
    )
  ).rows[0]!;
const attemptsOf = async (runId: string) =>
  (await pool.query<{ execution: string; network: string; est_cost_usd: string | null; result_class: string }>('SELECT execution, network, est_cost_usd, result_class FROM run_attempts WHERE run_id = $1 ORDER BY seq', [runId])).rows;
const eventsOf = (runId: string) => listInvestigationEvents(pool, { runId, ownerId: A });
const detailOf = async (runId: string) => (await pool.query<{ error_detail: string | null }>('SELECT error_detail FROM runs WHERE id = $1', [runId])).rows[0]!.error_detail;

/** Proposition scriptée du rôle `investigate` pour l'API JSON de contacts (gisement c1, pagination par page). */
const CONTACTS_PROPOSAL = {
  fields: [
    { name: 'id', type: 'string', required: true, personal: false, description: 'Identifiant du contact' },
    { name: 'name', type: 'string', required: true, personal: true, description: 'Nom' },
    { name: 'email', type: 'string', required: true, personal: true, description: 'Adresse électronique' },
    { name: 'city', type: 'string', required: false, personal: false, description: 'Ville' },
    { name: 'score', type: 'integer', required: true, personal: false, description: 'Score' },
  ],
  sources: [
    {
      candidate: 'c1',
      paths: [
        { field: 'id', path: '$.id', ops: [] },
        { field: 'name', path: '$.name', ops: ['trim'] },
        { field: 'email', path: '$.email', ops: ['lower'] },
        { field: 'city', path: '$.city', ops: [] },
        { field: 'score', path: '$.score', ops: [] },
      ],
      pagination: { type: 'page_param', param: 'url.query.page', start: 1, has_more_path: '$.has_more', next_path: null },
    },
  ],
};

const NEXT_PROPOSAL = {
  fields: [
    { name: 'sku', type: 'string', required: true, personal: false, description: 'Référence' },
    { name: 'title', type: 'string', required: true, personal: false, description: 'Titre' },
    { name: 'price_cents', type: 'integer', required: true, personal: false, description: 'Prix en centimes' },
  ],
  sources: [
    {
      candidate: 'c1',
      paths: [
        { field: 'sku', path: '$.id', ops: [] },
        { field: 'title', path: '$.title', ops: ['collapse_spaces'] },
        { field: 'price_cents', path: '$.price_cents', ops: [] },
      ],
      pagination: { type: 'none', param: null, start: null, has_more_path: null, next_path: null },
    },
  ],
};

beforeAll(async () => {
  client = await startClient();
  fake = await createFakeProvider();
  tdb = await createTestDatabase('investigation');
  await migrateUp({ connectionString: tdb.url });
  const masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: tdb.url, max: 8 });
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_investigation@example.test', 'active')", [A]);
  // Proxy de centre de données défini par l'admin (jamais atteint : il ne sert qu'à chiffrer le couple fetch/dc_proxy).
  await pool.query("INSERT INTO settings (key, value) VALUES ('proxies', $1)", [JSON.stringify([{ id: 'zz_test_dc', type: 'dc', url: 'http://127.0.0.1:9', price: { per_gb_usd: 10 } }])]);
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  const guard = fixtureGuard(client.server.port, [API_HOST, NEXT_HOST, ROBOTS_HOST, CHALLENGE_HOST, SSR_HOST], net);
  const pacer = new DomainPacer(new PgPacingStore(pool));
  // E4 (`agent_fetch` par le réseau) seulement : ni moteur agentique ni Chromium dans ce fichier.
  const agent = {
    llmConfig: async () => llmConfig(),
    client: (config: LlmConfig) => createLlmClient(config),
    engineFor: () => () => null,
    agentBrowser: async (): Promise<never> => {
      throw new Error('zz_test : aucun navigateur');
    },
  };
  const strategy = createStrategyRuntime({ pool, guard, pacer, browsers: null, agent, instanceContact: async () => 'mailto:ops@zz-test.example', version: '9.9.9' });
  const investigation = createInvestigationExecutor({
    pool,
    guard,
    pacer,
    browsers: null,
    strategy,
    llm: { config: async () => llmConfig(), client: (config) => createLlmClient(config) },
    agentic: true,
    instanceContact: async () => 'mailto:ops@zz-test.example',
    version: '9.9.9',
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
  await client?.close();
});

beforeEach(async () => {
  fake.reset();
  price = { in: 1, out: 1 };
  withExtract = false;
  await client.reset();
});

describe('enquête (tâche 2.1)', () => {
  test('assert_cheapest_first_logged — fixture API JSON : plan par coût croissant, premier essai fetch/direct, retenu (N = 3, page 2), stratégie v1, statut sain', async () => {
    fake.setScenario(MODEL, [scripted.json(CONTACTS_PROPOSAL)]);
    const apiId = await insertApi('zz_test_inv_json', { allow: ['direct', 'dc_proxy'] });
    const run = await investigate(apiId, { url: `${base(API_HOST)}/`, description: 'liste des contacts', auto_validate: true });
    expect(run).toMatchObject({ state: 'succeeded', outcome: 'clean', strategy_version: 1 });
    expect(run.items).toBeGreaterThan(0);

    // INV2 : run_attempts commence par fetch/direct, coûts estimés croissants, et c'est lui qui est retenu.
    const attempts = await attemptsOf(run.id);
    expect(attempts[0]).toMatchObject({ execution: 'fetch', network: 'direct', result_class: 'ok' });
    expect(firstCostInversion(attempts.map((a) => (a.est_cost_usd === null ? null : Number(a.est_cost_usd))))).toBe(-1);
    const api = await apiRow(apiId);
    expect(api).toMatchObject({ status: 'sain', status_reason: 'strategy_conform', investigation_phase: 'done', current_strategy_version: 1 });
    const sv = (await pool.query<{ execution: string; network: string; created_by: string; spec: { sources: { from: string }[] }; est_cost_usd: string }>('SELECT execution, network, created_by, spec, est_cost_usd FROM strategy_versions WHERE api_id = $1', [apiId])).rows;
    expect(sv).toHaveLength(1);
    expect(sv[0]).toMatchObject({ execution: 'fetch', network: 'direct', created_by: 'investigation' });
    expect(sv[0]!.spec.sources[0]!.from).toBe('response');
    expect(Number(sv[0]!.est_cost_usd)).toBe(Number(attempts[0]!.est_cost_usd));

    // Récit : étape 0 avant tout essai ; plan trié (fetch/direct d'abord, fetch/dc_proxy plus cher, jamais essayé).
    const events = await eventsOf(run.id);
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe('investigation.started');
    expect(kinds.indexOf('access_report')).toBeLessThan(kinds.indexOf('reconnaissance.finished'));
    expect(kinds.indexOf('schema.proposed')).toBeLessThan(kinds.indexOf('attempt.finished'));
    const testing = events.find((e) => e.kind === 'phase.started' && (e.payload as { phase: string }).phase === 'testing')!.payload as { plan: { execution: string; network: string; est_cost_usd: number }[] };
    expect(testing.plan.map((p) => `${p.execution}/${p.network}`)).toEqual(['fetch/direct', 'fetch/dc_proxy']);
    expect(firstCostInversion(testing.plan.map((p) => p.est_cost_usd))).toBe(-1);
    expect(testing.plan[0]!.est_cost_usd).toBeLessThan(testing.plan[1]!.est_cost_usd);
    const finished = events.filter((e) => e.kind === 'attempt.finished').map((e) => e.payload as { executions: { ok: boolean; pages: number }[] });
    expect(finished).toHaveLength(1);
    // N = 3 exécutions conformes, dont au moins une en page 2.
    expect(finished[0]!.executions).toHaveLength(3);
    expect(finished[0]!.executions.every((x) => x.ok)).toBe(true);
    expect(finished[0]!.executions.some((x) => x.pages >= 2)).toBe(true);

    // Résultat livré conforme au schéma validé ; schéma d'entrée proposé (plafond de pages).
    const items = await withActor(pool, actorA, (tx) => tx.query<{ item: unknown }>('SELECT item FROM dataset_items WHERE dataset_id = $1', [run.dataset_id]));
    expect(items.rows.length).toBe(run.items);
    for (const r of items.rows) expect(validateOutput(api.output_schema, r.item)).toEqual({ ok: true });
    expect(api.input_schema).toMatchObject({ properties: { max_pages: { type: 'integer' } } });

    // Le rôle investigate n'a vu que des squelettes : aucune valeur de la page dans le prompt (une seule requête).
    expect(fake.requests).toBe(1);
    const prompt = JSON.stringify(fake.calls[0]!.body);
    expect(prompt).toContain('$.email');
    expect(prompt).not.toMatch(/Zztest\d|example\.invalid|zz_test_contact_0001/);
    // Le proxy (fetch/dc_proxy) n'a jamais servi : aucun coût proxy.
    expect(run.cost.proxy_usd).toBe(0);
  });

  test('fixture Next (__NEXT_DATA__, aucune API XHR) : stratégie retenue E1 avec une source `embedded`', async () => {
    fake.setScenario(MODEL, [scripted.json(NEXT_PROPOSAL)]);
    const apiId = await insertApi('zz_test_inv_next');
    const run = await investigate(apiId, { url: `${base(NEXT_HOST)}/`, description: 'liste des produits', auto_validate: true });
    expect(run).toMatchObject({ state: 'succeeded', items: 10, strategy_version: 1 });
    const sv = (await pool.query<{ execution: string; network: string; spec: { sources: { from: string; locator?: { kind: string } }[] } }>('SELECT execution, network, spec FROM strategy_versions WHERE api_id = $1', [apiId])).rows[0]!;
    expect(sv).toMatchObject({ execution: 'fetch', network: 'direct' });
    expect(sv.spec.sources[0]).toMatchObject({ from: 'embedded', locator: { kind: 'next_data' } });
    expect((await apiRow(apiId)).status).toBe('sain');
    const recon = (await eventsOf(run.id)).find((e) => e.kind === 'reconnaissance.finished')!.payload as { candidates: { from: string }[] };
    expect(recon.candidates.map((c) => c.from)).toEqual(['embedded']);
  });

  test('budget d’enquête dépassé → erreur (transition 2), aucun essai payé au-delà', async () => {
    // 1 M$ par million de jetons : l'appel d'enquête coûte bien plus que le budget de 0,001 $.
    price = { in: 1_000_000, out: 1_000_000 };
    fake.setScenario(MODEL, [scripted.json(CONTACTS_PROPOSAL)]);
    const apiId = await insertApi('zz_test_inv_budget');
    const run = await investigate(apiId, { url: `${base(API_HOST)}/`, description: 'liste des contacts', auto_validate: true, budget_usd: 0.001 });
    expect(run).toMatchObject({ state: 'failed', failure_class: 'run_budget_exceeded', retryable: false });
    expect(await detailOf(run.id)).toBe('investigation_budget_usd');
    expect(await apiRow(apiId)).toMatchObject({ status: 'erreur', status_reason: 'investigation_budget_exhausted', current_strategy_version: null });
    expect(await attemptsOf(run.id)).toEqual([]);
    expect(run.cost.llm_usd).toBeGreaterThan(0.001);
    const kinds = (await eventsOf(run.id)).map((e) => e.kind);
    expect(kinds).toContain('status.changed');
    expect(kinds.at(-1)).toBe('investigation.finished');
  });

  test('validate_schema en deux temps : schéma proposé + échantillon d’abord, aucun essai ; après validation, essais et sain', async () => {
    fake.setScenario(MODEL, [scripted.json(CONTACTS_PROPOSAL)]);
    const apiId = await insertApi('zz_test_inv_validate');
    const first = await investigate(apiId, { url: `${base(API_HOST)}/`, description: 'liste des contacts' });
    expect(first).toMatchObject({ state: 'succeeded', items: 0 });
    expect(await attemptsOf(first.id)).toEqual([]);
    expect(await apiRow(apiId)).toMatchObject({ status: 'enquete', investigation_phase: 'awaiting_schema_validation', current_strategy_version: null });
    const proposed = (await eventsOf(first.id)).find((e) => e.kind === 'schema.proposed')!.payload as { output_schema: unknown; sample: unknown[] };
    expect(proposed.sample.length).toBeGreaterThan(0);
    for (const s of proposed.sample) expect(validateOutput(proposed.output_schema, s)).toEqual({ ok: true });

    const { runId } = await withActor(pool, actorA, (tx) => validateInvestigationSchema(tx, queue, { apiId, ownerId: A, trigger: 'rest' }));
    const second = await waitRun(runId);
    expect(second).toMatchObject({ state: 'succeeded', strategy_version: 1 });
    expect((await attemptsOf(runId))[0]).toMatchObject({ execution: 'fetch', network: 'direct', result_class: 'ok' });
    expect(await apiRow(apiId)).toMatchObject({ status: 'sain', investigation_phase: 'done' });
    // Schéma inchangé : pas de second appel au LLM.
    expect(fake.requests).toBe(1);
    // Deuxième run : le rapport d'accès est refait avant tout essai (contrainte 0015).
    const kinds = (await eventsOf(runId)).map((e) => e.kind);
    expect(kinds.indexOf('access_report')).toBeGreaterThan(-1);
    expect(kinds.indexOf('access_report')).toBeLessThan(kinds.indexOf('attempt.finished'));
    await expect(withActor(pool, actorA, (tx) => validateInvestigationSchema(tx, queue, { apiId, ownerId: A, trigger: 'rest' }))).rejects.toMatchObject({ code: 'not_awaiting_validation' });
  });

  test('assert_access_report_first — robots.txt interdit le chemin : rapport d’accès seul, bloquee, 0 requête sur /prive/, aucun appel au LLM', async () => {
    fake.setScenario(MODEL, [scripted.json(CONTACTS_PROPOSAL)]);
    const apiId = await insertApi('zz_test_inv_robots');
    const run = await investigate(apiId, { url: `${base(ROBOTS_HOST)}/prive/liste`, description: 'liste', auto_validate: true });
    expect(run).toMatchObject({ state: 'failed', failure_class: 'robots_disallowed', retryable: false });
    expect(await apiRow(apiId)).toMatchObject({ status: 'bloquee', status_reason: 'robots_disallowed' });
    const kinds = (await eventsOf(run.id)).map((e) => e.kind);
    expect(kinds).toContain('access_report');
    expect(kinds.filter((k) => k.startsWith('attempt') || k.startsWith('reconnaissance'))).toEqual([]);
    const paths = (await client.stats()).hosts[ROBOTS_HOST]?.paths ?? {};
    expect(Object.entries(paths).filter(([p]) => p.startsWith('/prive/')).reduce((n, [, c]) => n + c, 0)).toBe(0);
    expect(fake.requests).toBe(0);
  });

  test('page sans API ni blob (rendu serveur) : schéma proposé sans gisement, seule la voie E4 (agent_fetch) est essayable sans navigateur, et retenue', async () => {
    withExtract = true;
    fake.setScenario(MODEL, [
      scripted.json({
        fields: [
          { name: 'title', type: 'string', required: true, personal: false, description: 'Titre' },
          { name: 'price', type: 'number', required: true, personal: false, description: 'Prix en euros' },
        ],
        sources: [],
      }),
    ]);
    const items = { items: [{ title: 'Lampe Zztest 0001', price: 12.5 }, { title: 'Table Zztest 0002', price: 40 }] };
    fake.setScenario(EXTRACT_MODEL, [scripted.json(items), scripted.json(items), scripted.json(items)]);
    const apiId = await insertApi('zz_test_inv_ssr');
    const run = await investigate(apiId, { url: `${base(SSR_HOST)}/`, description: 'liste des produits du catalogue', auto_validate: true });
    expect(run).toMatchObject({ state: 'succeeded', items: 2, strategy_version: 1 });
    const events = await eventsOf(run.id);
    const testing = events.find((e) => e.kind === 'phase.started' && (e.payload as { phase: string }).phase === 'testing')!.payload as { plan: { execution: string; source: string }[] };
    expect(testing.plan.map((p) => `${p.execution}/${p.source}`)).toEqual(['agent_fetch/page']);
    const attempts = await attemptsOf(run.id);
    expect(attempts).toEqual([expect.objectContaining({ execution: 'agent_fetch', network: 'direct', result_class: 'ok' })]);
    expect((await pool.query<{ execution: string }>('SELECT execution FROM strategy_versions WHERE api_id = $1', [apiId])).rows).toEqual([{ execution: 'agent_fetch' }]);
    // N = 3 : trois mises en forme par le rôle extract ; le coût LLM des essais est imputé à l'essai.
    expect(fake.byRole[EXTRACT_MODEL]).toBe(3);
    expect(run.attempts[0]!.cost_usd).toBeGreaterThan(0);
  });

  test('défi servi en HTTP 200 : arrêt à l’étape 0 (INV6), bloquee, aucun essai, aucun appel au LLM', async () => {
    fake.setScenario(MODEL, [scripted.json(CONTACTS_PROPOSAL)]);
    const apiId = await insertApi('zz_test_inv_challenge');
    const run = await investigate(apiId, { url: `${base(CHALLENGE_HOST)}/`, description: 'catalogue', auto_validate: true });
    expect(run).toMatchObject({ state: 'failed', failure_class: 'blocked_by_protection', retryable: false });
    expect(await apiRow(apiId)).toMatchObject({ status: 'bloquee', status_reason: 'blocked_by_protection' });
    expect(await attemptsOf(run.id)).toEqual([]);
    expect(fake.requests).toBe(0);
    // Une seule requête de contenu (la sonde du rapport d'accès) : rien n'a insisté.
    const paths = (await client.stats()).hosts[CHALLENGE_HOST]?.paths ?? {};
    expect(paths['/']).toBe(1);
  });

  test('contact d’instance absent (17 §5) : enquête refusée avant toute requête', async () => {
    const apiId = await insertApi('zz_test_inv_contact');
    const runId = randomUUID();
    await pool.query("UPDATE apis SET investigation = $2 WHERE id = $1", [apiId, JSON.stringify({ request: { url: `${base(API_HOST)}/`, description: 'x', auto_validate: true, budget_usd: 1, timeout_s: 60 }, spent_usd: 0, elapsed_ms: 0 })]);
    const executor = createInvestigationExecutor({
      pool,
      guard: fixtureGuard(client.server.port, [API_HOST], net),
      browsers: null,
      strategy: createStrategyRuntime({ pool, guard: fixtureGuard(client.server.port, [API_HOST], net), browsers: null }),
    });
    const result = await executor({
      runId,
      apiId,
      ownerId: A,
      strategyVersion: null,
      input: null,
      kind: 'investigation',
      signal: new AbortController().signal,
      recordAttempt: async () => undefined,
      log: async () => undefined,
      personal: new (await import('@runtime/core')).PersonalValueRegistry(),
      excludeSubjects: (_s, items) => ({ kept: [...items], dropped: 0 }),
      writeItems: async () => ({ dataset_id: '', written: 0, new_items: null, dropped: 0, skipped: 0 }),
    });
    expect(result).toMatchObject({ state: 'failed', failure_class: 'code_error', error_detail: 'instance_contact_missing' });
    expect((await client.stats()).total).toBe(0);
  });
});
