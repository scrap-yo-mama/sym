// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.1 de bout en bout sur base réelle, faux fournisseur LLM (15 §4), fixtures locales (0.5), sans navigateur
// (DISABLE_BROWSER : reconnaissance statique) : enquête mise en file côté web (`startInvestigation`) → worker (1.3) →
// exécuteur choisi par `runs.kind` → étape 0 (rapport d'accès, 1.11) → reconnaissance → schéma de sortie proposé par le
// rôle `investigate` (squelettes seulement) → essais du moins cher au plus cher par l'exécuteur de stratégie (1.6, 1.7,
// 1.9) → stratégie v1, résultat livré, statut (1.2).
// Critères : `assert_cheapest_first_logged` (fixture API JSON : `fetch/direct` retenu), fixture Next : E1 `embedded`,
// budget dépassé → `erreur`, validation du schéma en deux temps (`validate_schema`), étape 0 d'abord
// (`assert_access_report_first`), robots.txt qui interdit le chemin sans effet sur l'enquête (D-91).
import { randomUUID } from 'node:crypto';
import { DomainPacer, generateMasterKey, inputSchemaIssues, MasterKey, Secret, secretValues, validateOutput, type RunExecutor } from '@runtime/core';
import { firstCostInversion, milestoneHeading, type InvestigationMilestone } from '@runtime/core/investigation';
import * as net from '@runtime/core/net';
import {
  createRun,
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
import { htmlListItem, HTML_LIST_TOTAL } from '../../../../fixtures/src/sites/case-sites.ts';
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
/** Liste HTML statique paginée par le chemin (constat Janssens), fixture `html_list`. */
const HTML_LIST = 'zz_test_html_list.localhost';
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

/**
 * État d'enquête de la console (apps/web/src/lib/investigation.ts), chargé à l'exécution : la console a son propre build
 * (vue-tsc) et n'est pas dans le typecheck du serveur ; seule la forme lue ici est déclarée.
 */
const CONSOLE_INVESTIGATION = '../../../web/src/lib/investigation.ts';
type ConsoleState = { runId: string | null; phase: string | null; budget: { retainedEstUsd: number | null } | null };
type ConsoleInvestigationLib = {
  emptyInvestigation(): ConsoleState;
  ingestEvent(state: ConsoleState, event: { id: string; event: string; data: string }, nowMs: number): boolean;
  trialCards(state: ConsoleState): { execution: string; network: string | null; state: string }[];
};

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
    { name: 'id', type: 'string', required: true, personal: false, description: 'Contact identifier' },
    { name: 'name', type: 'string', required: true, personal: true, description: 'Name' },
    { name: 'email', type: 'string', required: true, personal: true, description: 'E-mail address' },
    { name: 'city', type: 'string', required: false, personal: false, description: 'City' },
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
    { name: 'sku', type: 'string', required: true, personal: false, description: 'Reference' },
    { name: 'title', type: 'string', required: true, personal: false, description: 'Title' },
    { name: 'price_cents', type: 'integer', required: true, personal: false, description: 'Price in cents' },
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
  const guard = fixtureGuard(client.server.port, [API_HOST, NEXT_HOST, ROBOTS_HOST, CHALLENGE_HOST, SSR_HOST, HTML_LIST], net);
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
    const finished = events.filter((e) => e.kind === 'attempt.finished').map((e) => e.payload as { executions: { ok: boolean; pages: number }[]; pagination?: { verified: boolean; stop: string | null; pages: number } });
    expect(finished).toHaveLength(1);
    // N = 3 exécutions conformes, dont au moins une en page 2.
    expect(finished[0]!.executions).toHaveLength(3);
    expect(finished[0]!.executions.every((x) => x.ok)).toBe(true);
    expect(finished[0]!.executions.some((x) => x.pages >= 2)).toBe(true);
    // Tâche 2.2 : les 3 exécutions s'arrêtent à 2 pages ; une exécution de plus, au plafond dur, constate la règle d'arrêt
    // (`has_more` faux) sur la DERNIÈRE page des 500 contacts : 25 pages de 20, pas une de plus.
    expect(finished[0]!.executions.map((x) => x.pages)).toEqual([2, 2, 2]);
    expect(finished[0]!.pagination).toEqual({ verified: true, stop: 'path_equals', pages: 25 });
    const paths = (await client.stats()).hosts[API_HOST]?.paths ?? {};
    expect(paths['/api/contacts']).toBeGreaterThanOrEqual(3 * 2 + 25);

    // Résultat livré conforme au schéma validé ; schéma d'entrée proposé (plafond de pages).
    const items = await withActor(pool, actorA, (tx) => tx.query<{ item: unknown }>('SELECT item FROM dataset_items WHERE dataset_id = $1', [run.dataset_id]));
    expect(items.rows.length).toBe(run.items);
    for (const r of items.rows) expect(validateOutput(api.output_schema, r.item)).toEqual({ ok: true });
    expect(api.input_schema).toMatchObject({ properties: { max_pages: { type: 'integer', minimum: 1, maximum: 50 } } });
    // Tâche 2.2 : le schéma d'entrée proposé décrit chaque champ (assert_input_schema_described).
    expect(inputSchemaIssues(api.input_schema)).toEqual([]);
    expect((api.input_schema as { properties: { max_pages: { description: string } } }).properties.max_pages.description.length).toBeGreaterThan(20);
    const done = events.find((e) => e.kind === 'investigation.finished')!.payload as { pagination?: { verified: boolean; stop: string | null } };
    expect(done.pagination).toMatchObject({ verified: true, stop: 'path_equals' });

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
    // Coût de l'appel borné AVANT l'envoi (max_tokens × prix) : l'appel qui dépasserait le budget n'est jamais envoyé,
    // le coût imputé reste sous le plafond (04b « coût imputé ≤ plafond »).
    expect(fake.requests).toBe(0);
    expect(run.cost.llm_usd ?? 0).toBeLessThanOrEqual(0.001);
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

  test('assert_schema_gate_before_trials, assert_trial_plan_cheapest_first_ui (worker → console) : le plan chiffré et le coût de rejeu partent AVEC la porte, avant tout essai ; assert_milestones_same_labels (journaux)', async () => {
    fake.setScenario(MODEL, [scripted.json(CONTACTS_PROPOSAL)]);
    const apiId = await insertApi('zz_test_inv_gate_plan', { allow: ['direct', 'dc_proxy'] });
    const first = await investigate(apiId, { url: `${base(API_HOST)}/`, description: 'liste des contacts' });
    expect(first).toMatchObject({ state: 'succeeded', items: 0 });
    expect(await attemptsOf(first.id)).toEqual([]);

    // Le worker annonce le plan estimé et le coût de rejeu avec la phase de la porte : rien n'est encore essayé.
    const events = await eventsOf(first.id);
    type GatePayload = { phase: string; plan?: { execution: string; network: string; est_cost_usd: number }[]; budget: { retained_est_usd?: number } };
    const gate = events.find((e) => e.kind === 'phase.started' && (e.payload as GatePayload).phase === 'awaiting_schema_validation')?.payload as GatePayload | undefined;
    expect(gate?.plan?.map((p) => `${p.execution}/${p.network}`)).toEqual(['fetch/direct', 'fetch/dc_proxy']);
    expect(firstCostInversion(gate!.plan!.map((p) => p.est_cost_usd))).toBe(-1);
    expect(gate!.budget.retained_est_usd).toBe(gate!.plan![0]!.est_cost_usd);

    // La console range ces mêmes événements (contrat de lib/investigation.ts) : plan chiffré à la porte, toutes les cartes « à essayer ».
    const consoleLib = (await import(/* @vite-ignore */ CONSOLE_INVESTIGATION)) as ConsoleInvestigationLib;
    const state = consoleLib.emptyInvestigation();
    state.runId = first.id;
    for (const e of events) consoleLib.ingestEvent(state, { id: `${first.id}:${e.seq}`, event: e.kind, data: JSON.stringify(e.payload) }, 0);
    expect(state.phase).toBe('awaiting_schema_validation');
    expect(consoleLib.trialCards(state).map((c) => `${c.execution}/${c.network}:${c.state}`)).toEqual(['fetch/direct:planned', 'fetch/dc_proxy:planned']);
    expect(state.budget?.retainedEstUsd).toBe(gate!.plan![0]!.est_cost_usd);

    // Second run (accord donné) : le plan essayé est celui montré à la porte.
    const { runId } = await withActor(pool, actorA, (tx) => validateInvestigationSchema(tx, queue, { apiId, ownerId: A, trigger: 'rest' }));
    expect(await waitRun(runId)).toMatchObject({ state: 'succeeded', strategy_version: 1 });
    const testing = (await eventsOf(runId)).find((e) => e.kind === 'phase.started' && (e.payload as GatePayload).phase === 'testing')!.payload as GatePayload;
    expect(testing.plan?.map((p) => `${p.execution}/${p.network}`)).toEqual(gate!.plan!.map((p) => `${p.execution}/${p.network}`));

    // Journaux : chaque jalon atteint est écrit avec la clé et l'intitulé du noyau (« 2/4 Explore »), comme la frise et le récit.
    const milestones = async (id: string) =>
      (await pool.query<{ data: { milestone: string; heading: string } }>("SELECT data FROM run_logs WHERE run_id = $1 AND event = 'milestone' ORDER BY seq", [id])).rows.map((r) => r.data);
    const logged = [...(await milestones(first.id)), ...(await milestones(runId))];
    expect(logged.map((l) => l.milestone)).toEqual(['reconnaissance', 'schema', 'trials']);
    expect(logged.map((l) => l.heading)).toEqual(logged.map((l) => milestoneHeading(l.milestone as InvestigationMilestone, 'en')));
  });

  test('assert_robots_not_gating / assert_robots_not_auto_fetched — robots.txt interdit le chemin : l’enquête se poursuit, statut jamais bloquee, robots.txt jamais demandé', async () => {
    fake.setScenario(MODEL, [scripted.json(CONTACTS_PROPOSAL)]);
    const apiId = await insertApi('zz_test_inv_robots');
    const run = await investigate(apiId, { url: `${base(ROBOTS_HOST)}/prive/liste`, description: 'liste', auto_validate: true });
    expect(run.failure_class ?? '').not.toMatch(/^robots_/);
    const api = await apiRow(apiId);
    expect(api.status).not.toBe('bloquee');
    expect(String(api.status_reason ?? '')).not.toMatch(/^robots_/);
    const events = await eventsOf(run.id);
    const report = events.find((e) => e.kind === 'access_report')!.payload as { verdict: { proceed: boolean }; robots?: unknown };
    expect(report.verdict.proceed).toBe(true);
    expect(report.robots).toBeUndefined();
    expect(events.map((e) => e.kind)).toContain('reconnaissance.finished');
    const paths = (await client.stats()).hosts[ROBOTS_HOST]?.paths ?? {};
    expect(paths['/prive/liste']).toBeGreaterThanOrEqual(1);
    expect(paths['/robots.txt']).toBeUndefined();
  });

  test('page sans API ni blob (rendu serveur) : schéma proposé sans gisement, seule la voie E4 (agent_fetch) est essayable sans navigateur, et retenue', async () => {
    withExtract = true;
    fake.setScenario(MODEL, [
      scripted.json({
        fields: [
          { name: 'title', type: 'string', required: true, personal: false, description: 'Title' },
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

  test('assert_html_replay_no_llm — page HTML statique : l’essai E4 conforme est compilé en déclaratif html (vérifié sans LLM), E4 gardé en repli, puis le rejeu compte 0 appel LLM', async () => {
    withExtract = true;
    // Éléments que l'agent lit sur la page 1 (texte visible), relevés sur la fixture : 20 cartes produit.
    const served = (await client.get(SSR_HOST, '/')).body;
    const items = [...served.matchAll(/<h2 class="title"><a [^>]*>([^<]+)<\/a><\/h2><span class="price">([0-9]+),([0-9]{2})/g)].map((m) => ({ title: m[1]!, price: Number(`${m[2]}.${m[3]}`) }));
    expect(items).toHaveLength(20);
    const op = (name: string, decimal: string | null = null) => ({ op: name, pattern: null, group: null, decimal, format: null });
    fake.setScenario(MODEL, [
      scripted.json({
        fields: [
          { name: 'title', type: 'string', required: true, personal: false, description: 'Titre' },
          { name: 'price', type: 'number', required: true, personal: false, description: 'Prix en euros' },
        ],
        sources: [],
      }),
      // Compilation (rôle investigate) : sélecteurs et opérateurs de la liste fermée, rien d'autre.
      scripted.json({ records: 'article.product', fields: [{ field: 'title', css: 'h2.title a', attr: null, ops: [op('trim')] }, { field: 'price', css: '.price', attr: null, ops: [op('to_number', ',')] }] }),
    ]);
    fake.setScenario(EXTRACT_MODEL, [scripted.json({ items }), scripted.json({ items }), scripted.json({ items })]);
    const apiId = await insertApi('zz_test_inv_html_replay');
    const run = await investigate(apiId, { url: `${base(SSR_HOST)}/`, description: 'liste des produits du catalogue', auto_validate: true });
    // Constat Janssens : la page porte une pagination (`?page=N`, rel=next) ; la compilée la reprend, vérifiée en page 2 (2 × 20).
    expect(run).toMatchObject({ state: 'succeeded', items: 40, strategy_version: 2 });
    // E4 essayé en échantillon, conforme, puis UNE compilation vérifiée sans LLM (page 2 comprise) : elle tient lieu des
    // exécutions E4 suivantes (banc R06, R08) ; 2 appels du rôle investigate, 1 seul du rôle extract.
    expect(fake.byRole[MODEL]).toBe(2);
    expect(fake.byRole[EXTRACT_MODEL]).toBe(1);
    const versions = (
      await pool.query<{ version: number; execution: string; parent_version: number | null; was_current: boolean; spec: { sources?: { from: string }[]; request?: { allowed_hosts: string[] } } }>(
        'SELECT version, execution, parent_version, was_current, spec FROM strategy_versions WHERE api_id = $1 ORDER BY version',
        [apiId],
      )
    ).rows;
    expect(versions.map((v) => [v.version, v.execution, v.parent_version, v.was_current])).toEqual([
      [1, 'agent_fetch', null, true],
      [2, 'fetch', 1, true],
    ]);
    expect(versions[1]!.spec.sources).toEqual([{ id: 'page', from: 'html', records: 'article.product' }]);
    expect((versions[1]!.spec as { pagination?: unknown }).pagination).toMatchObject({ type: 'page_param', param: 'url.query.page', start: 1 });
    expect(versions[1]!.spec.request!.allowed_hosts).toEqual([SSR_HOST]);
    expect((await apiRow(apiId)).current_strategy_version).toBe(2);
    const events = await eventsOf(run.id);
    const compiled = events.find((e) => e.kind === 'strategy.compiled')!.payload as Record<string, unknown>;
    expect(compiled).toMatchObject({ from: 'agent_fetch', to: 'fetch', ok: true, proposals: 1, records: 20, ratio: 1, pagination: { type: 'page_param', verified: true, pages: 2, items: 40 } });
    expect(compiled['cost_usd']).toEqual(expect.any(Number));
    expect(compiled['cost_usd']).toBeGreaterThan(0);
    const finished = events.find((e) => e.kind === 'investigation.finished')!.payload as { strategy: Record<string, unknown> };
    expect(finished.strategy).toMatchObject({ version: 2, execution: 'fetch', compiled_from: 'agent_fetch', fallback_version: 1 });
    // Coût de la compilation imputé au run d'enquête (en plus des essais).
    const attemptsUsd = run.attempts.reduce((s, a) => s + (a.cost_usd ?? 0), 0);
    expect(run.cost.total_usd).toBeGreaterThan(attemptsUsd);

    // Rejeu : stratégie html déclarative, E1, AUCUN appel LLM.
    fake.reset();
    const { runId } = await withActor(pool, actorA, (tx) => createRun(tx, queue, { apiId, ownerId: A, trigger: 'rest' }));
    const replay = await waitRun(runId);
    // Toutes les pages du catalogue (5 × 20), sans LLM ; la page 1 est celle que l'agent avait lue.
    expect(replay).toMatchObject({ state: 'succeeded', items: 100, strategy_version: 2 });
    expect(fake.requests).toBe(0);
    const delivered = (await pool.query<{ item: unknown }>('SELECT item FROM dataset_items WHERE run_id = $1 ORDER BY seq', [runId])).rows.map((r) => r.item);
    expect(delivered.slice(0, 20)).toEqual(items);
  });

  test('assert_html_replay_no_llm (recette UX-30, UX-31) — boutique de livres (note en mot, « In stock », prix en livres) puis citations (champ tableau) : compilées en html, vérifiées sans LLM, rejouées avec 0 appel LLM', async () => {
    withExtract = true;
    const op = (name: string, extra: Record<string, unknown> = {}) => ({ op: name, pattern: null, group: null, decimal: null, format: null, ...extra });
    const WORDS: Record<string, number> = { One: 1, Two: 2, Three: 3, Four: 4, Five: 5 };
    // 1. Livres : éléments que l'agent lit sur la page (titre complet, note en entier, disponibilité en booléen, prix en nombre).
    const shop = (await client.get(SSR_HOST, '/livres')).body;
    const books = [...shop.matchAll(/title="([^"]+)">[^<]*<\/a><\/h3><p class="star-rating ([A-Za-z]+)">.*?<p class="price_color">£([0-9.]+)<\/p><p class="instock availability">\s*([^<]+?)\s*<\/p>/gs)].map((m) => ({
      title: m[1]!,
      rating: WORDS[m[2]!]!,
      in_stock: m[4] === 'In stock',
      price_gbp: Number(m[3]),
    }));
    expect(books).toHaveLength(20);
    fake.setScenario(MODEL, [
      scripted.json({
        fields: [
          { name: 'title', type: 'string', required: true, personal: false, description: 'Titre du livre' },
          { name: 'rating', type: 'integer', required: true, personal: false, description: 'Note, 1 à 5 étoiles' },
          { name: 'in_stock', type: 'boolean', required: true, personal: false, description: 'En stock' },
          { name: 'price_gbp', type: 'number', required: true, personal: false, description: 'Prix en livres sterling' },
        ],
        sources: [],
      }),
      // Compilation : la note et la disponibilité lues en texte (aucun opérateur ne convertit un mot), le prix par to_number.
      scripted.json({
        records: 'article.product_pod',
        fields: [
          { field: 'title', css: 'h3 a', attr: 'title', ops: [] },
          { field: 'rating', css: 'p.star-rating', attr: 'class', ops: [op('regex_extract', { pattern: 'star-rating ([A-Za-z]+)', group: 1 })] },
          { field: 'in_stock', css: 'p.availability', attr: null, ops: [op('trim')] },
          { field: 'price_gbp', css: 'p.price_color', attr: null, ops: [op('to_number', { decimal: '.' })] },
        ],
      }),
    ]);
    fake.setScenario(EXTRACT_MODEL, [scripted.json({ items: books }), scripted.json({ items: books }), scripted.json({ items: books })]);
    const shopApi = await insertApi('zz_test_inv_html_books');
    const run = await investigate(shopApi, { url: `${base(SSR_HOST)}/livres`, description: 'catalogue des livres : titre, note, disponibilité, prix', auto_validate: true });
    expect(run).toMatchObject({ state: 'succeeded', items: 20, strategy_version: 2 });
    const compiled = (await eventsOf(run.id)).find((e) => e.kind === 'strategy.compiled')!.payload as Record<string, unknown>;
    expect(compiled).toMatchObject({ from: 'agent_fetch', to: 'fetch', ok: true, proposals: 1, records: 20, ratio: 1 });
    expect((await apiRow(shopApi)).current_strategy_version).toBe(2);
    fake.reset();
    const replay = await waitRun((await withActor(pool, actorA, (tx) => createRun(tx, queue, { apiId: shopApi, ownerId: A, trigger: 'rest' }))).runId);
    expect(replay).toMatchObject({ state: 'succeeded', items: 20, strategy_version: 2 });
    expect(fake.requests).toBe(0);
    expect((await pool.query<{ item: unknown }>('SELECT item FROM dataset_items WHERE run_id = $1 ORDER BY seq', [replay.id])).rows.map((r) => r.item)).toEqual(books);

    // 2. Citations : le propriétaire valide un schéma dont `tags` est un tableau de chaînes (sélecteur multiple).
    const page = (await client.get(SSR_HOST, '/citations')).body;
    const quotes = [...page.matchAll(/<span class="text">([^<]+)<\/span>.*?<small class="author">([^<]+)<\/small>.*?<div class="tags">(.*?)<\/div>/gs)].map((m) => ({
      text: m[1]!,
      author: m[2]!,
      tags: [...m[3]!.matchAll(/<a class="tag"[^>]*>([^<]+)<\/a>/g)].map((t) => t[1]!),
    }));
    expect(quotes).toHaveLength(10);
    expect(quotes.some((q) => q.tags.length > 1)).toBe(true);
    const quoteFields = {
      fields: [
        { name: 'text', type: 'string', required: true, personal: false, description: 'Citation' },
        { name: 'author', type: 'string', required: true, personal: false, description: 'Auteur' },
      ],
      sources: [],
    };
    fake.setScenario(MODEL, [
      scripted.json(quoteFields),
      scripted.json(quoteFields),
      scripted.json({
        records: 'div.quote',
        fields: [
          { field: 'text', css: 'span.text', attr: null, ops: [] },
          { field: 'author', css: 'small.author', attr: null, ops: [] },
          { field: 'tags', css: 'a.tag', attr: null, ops: [op('trim')] },
        ],
      }),
    ]);
    fake.setScenario(EXTRACT_MODEL, [scripted.json({ items: quotes }), scripted.json({ items: quotes }), scripted.json({ items: quotes })]);
    const quoteApi = await insertApi('zz_test_inv_html_quotes');
    const gate = await investigate(quoteApi, { url: `${base(SSR_HOST)}/citations`, description: 'citations : texte, auteur, étiquettes' });
    expect(gate).toMatchObject({ state: 'succeeded', items: 0 });
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['text', 'author', 'tags'],
      properties: { text: { type: 'string' }, author: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    };
    const { runId } = await withActor(pool, actorA, (tx) => validateInvestigationSchema(tx, queue, { apiId: quoteApi, ownerId: A, trigger: 'rest', outputSchema: schema }));
    const second = await waitRun(runId);
    expect(second).toMatchObject({ state: 'succeeded', items: 10, strategy_version: 2 });
    const quoteCompiled = (await eventsOf(runId)).find((e) => e.kind === 'strategy.compiled')!.payload as Record<string, unknown>;
    expect(quoteCompiled).toMatchObject({ ok: true, proposals: 1, records: 10, ratio: 1 });
    fake.reset();
    const quoteReplay = await waitRun((await withActor(pool, actorA, (tx) => createRun(tx, queue, { apiId: quoteApi, ownerId: A, trigger: 'rest' }))).runId);
    expect(quoteReplay).toMatchObject({ state: 'succeeded', items: 10, strategy_version: 2 });
    expect(fake.requests).toBe(0);
    expect((await pool.query<{ item: unknown }>('SELECT item FROM dataset_items WHERE run_id = $1 ORDER BY seq', [quoteReplay.id])).rows.map((r) => r.item)).toEqual(quotes);
  });

  test('constat Janssens — essai E4 correct sur la page 1 (champ requis constant sur cette page) : plus jeté en minimal_content ni escaladé ; compilé en html, pagination détectée par le code, vérifiée en page 2, rejeu sans LLM de toutes les pages', async () => {
    withExtract = true;
    const op = (name: string) => ({ op: name, pattern: null, group: null, decimal: null, format: null });
    const items = Array.from({ length: 10 }, (_, k) => {
      const b = htmlListItem(k + 1);
      return { title: b.title, sector: b.sector, reference: b.ref, url: `${base(HTML_LIST)}${b.path}` };
    });
    // Le secteur est le même sur les 10 cartes de la page 1 : contenu minimal en échec sur les sorties d'E4 seules.
    expect(new Set(items.map((i) => i.sector)).size).toBe(1);
    const fields = {
      fields: [
        { name: 'title', type: 'string', required: true, personal: false, description: 'Title' },
        { name: 'sector', type: 'string', required: true, personal: false, description: 'Sector' },
        { name: 'reference', type: 'string', required: true, personal: false, description: 'Reference' },
        { name: 'url', type: 'string', required: true, personal: false, description: 'Listing URL' },
      ],
      sources: [],
    };
    fake.setScenario(MODEL, [
      scripted.json(fields),
      scripted.json({
        records: 'main article.item-bien',
        fields: [
          { field: 'title', css: 'h3', attr: null, ops: [op('trim')] },
          { field: 'sector', css: 'span.flex-none', attr: null, ops: [op('trim')] },
          { field: 'reference', css: 'a', attr: 'data-ref', ops: [] },
          { field: 'url', css: 'a', attr: 'href', ops: [op('abs_url')] },
        ],
      }),
    ]);
    fake.setScenario(EXTRACT_MODEL, [scripted.json({ items }), scripted.json({ items }), scripted.json({ items })]);
    const apiId = await insertApi('zz_test_inv_html_list_e4');
    const run = await investigate(apiId, { url: `${base(HTML_LIST)}/nos-maisons/`, description: 'liste des biens de cette page, toutes les pages, sans ouvrir les fiches', auto_validate: true });
    expect(run).toMatchObject({ state: 'succeeded', items: 20 });
    // Un seul essai, E4, conforme : ni minimal_content ni escalade.
    const attempts = (await eventsOf(run.id)).filter((e) => e.kind === 'attempt.finished').map((e) => e.payload as { attempt: { execution: string; result: string }; why?: { code: string } });
    expect(attempts.map((a) => [a.attempt.execution, a.attempt.result])).toEqual([['agent_fetch', 'ok']]);
    const compiled = (await eventsOf(run.id)).find((e) => e.kind === 'strategy.compiled')!.payload as Record<string, unknown>;
    expect(compiled).toMatchObject({ ok: true, records: 10, ratio: 1, pagination: { type: 'page_param', verified: true, pages: 2, items: 20 } });
    // Version courante : la compilée, déclarative html paginée par le chemin ; E4 reste la version de repli.
    const current = (await pool.query<{ execution: string; spec: { sources: { from: string }[]; pagination?: Record<string, unknown> } }>('SELECT v.execution, v.spec FROM strategy_versions v JOIN apis a ON a.id = v.api_id AND a.current_strategy_version = v.version WHERE v.api_id = $1', [apiId])).rows[0]!;
    expect(current.execution).toBe('fetch');
    expect(current.spec.sources[0]).toMatchObject({ from: 'html' });
    expect(current.spec.pagination).toMatchObject({ type: 'page_param', param: 'url.path', path_pattern: '/nos-maisons/page/{page}/' });
    expect((await pool.query<{ execution: string }>('SELECT execution FROM strategy_versions WHERE api_id = $1 ORDER BY version', [apiId])).rows.map((r) => r.execution)).toEqual(['agent_fetch', 'fetch']);
    // LLM de l'enquête : la proposition, la compilation, et UNE mise en forme E4 (la compilée vérifiée sans LLM tient lieu
    // des suivantes, banc R06 et R08) ; rien de plus.
    expect(fake.byRole[MODEL]).toBe(2);
    expect(fake.byRole[EXTRACT_MODEL]).toBe(1);
    // Rejeu : toutes les pages, sans aucun appel LLM.
    fake.reset();
    const replay = await waitRun((await withActor(pool, actorA, (tx) => createRun(tx, queue, { apiId, ownerId: A, trigger: 'rest' }))).runId);
    expect(replay).toMatchObject({ state: 'succeeded', items: HTML_LIST_TOTAL });
    expect(fake.requests).toBe(0);
  });

  test('type non compilable (tableau d’objets) : compilation refusée AVANT tout appel (unsupported_field_type), E4 gardé, aucun coût de compilation', async () => {
    withExtract = true;
    const items = { items: [{ title: 'Lampe Zztest 0001', offers: [{ price: 1 }] }, { title: 'Table Zztest 0002', offers: [{ price: 2 }] }] };
    const fields = { fields: [{ name: 'title', type: 'string', required: true, personal: false, description: 'Titre' }], sources: [] };
    fake.setScenario(MODEL, [scripted.json(fields), scripted.json(fields)]);
    fake.setScenario(EXTRACT_MODEL, [scripted.json(items), scripted.json(items), scripted.json(items)]);
    const apiId = await insertApi('zz_test_inv_html_unsupported');
    await investigate(apiId, { url: `${base(SSR_HOST)}/`, description: 'liste des produits du catalogue' });
    const schema = {
      type: 'object',
      required: ['title'],
      properties: { title: { type: 'string' }, offers: { type: 'array', items: { type: 'object', properties: { price: { type: 'number' } } } } },
      additionalProperties: false,
    };
    const { runId } = await withActor(pool, actorA, (tx) => validateInvestigationSchema(tx, queue, { apiId, ownerId: A, trigger: 'rest', outputSchema: schema }));
    expect(await waitRun(runId)).toMatchObject({ state: 'succeeded', strategy_version: 1 });
    const compiled = (await eventsOf(runId)).find((e) => e.kind === 'strategy.compiled')!.payload as Record<string, unknown>;
    expect(compiled).toMatchObject({ ok: false, reason: 'unsupported_field_type', fields: ['offers'] });
    expect(compiled['cost_usd']).toBeUndefined();
    // Deux appels du rôle investigate (proposition, puis remise en forme sur le schéma corrigé) : aucun pour la compilation.
    expect(fake.byRole[MODEL]).toBe(2);
  });

  test('UX-33 — équipe dont le nom de famille figure dans l’URL de départ : les exécutions 2 et 3 de l’essai E4 ne sont plus refusées (valeur vue, URL déclarée)', async () => {
    withExtract = true;
    const page = (await client.get(SSR_HOST, '/le-groupe-dupontzz/equipe')).body;
    const team = [...page.matchAll(/<span class="first">([^<]+)<\/span> <span class="last">([^<]+)<\/span><\/h3><p class="role">([^<]+)<\/p>/g)].map((m) => ({ first_name: m[1]!, last_name: m[2]!, role: m[3]! }));
    expect(team).toHaveLength(6);
    fake.setScenario(MODEL, [
      scripted.json({
        fields: [
          { name: 'first_name', type: 'string', required: true, personal: true, description: 'Prénom' },
          { name: 'last_name', type: 'string', required: true, personal: true, description: 'Nom' },
          { name: 'role', type: 'string', required: false, personal: false, description: 'Métier' },
        ],
        sources: [],
      }),
      // Compilation refusée deux fois (aucun bloc) : E4 n'est pas remplacé, ses 3 exécutions ont lieu (objet du test).
      scripted.json({ records: 'div.zz-none', fields: [{ field: 'first_name', css: '.first', attr: null, ops: [] }, { field: 'last_name', css: '.last', attr: null, ops: [] }, { field: 'role', css: '.role', attr: null, ops: [] }] }),
      scripted.json({ records: 'div.zz-none', fields: [{ field: 'first_name', css: '.first', attr: null, ops: [] }, { field: 'last_name', css: '.last', attr: null, ops: [] }, { field: 'role', css: '.role', attr: null, ops: [] }] }),
    ]);
    fake.setScenario(EXTRACT_MODEL, [scripted.json({ items: team }), scripted.json({ items: team }), scripted.json({ items: team })]);
    const apiId = await insertApi('zz_test_inv_team_url_value');
    const run = await investigate(apiId, { url: `${base(SSR_HOST)}/le-groupe-dupontzz/equipe`, description: 'membres de l’équipe : prénom, nom, métier', auto_validate: true });
    expect(run).toMatchObject({ state: 'succeeded', items: 6 });
    const attempt = (await eventsOf(run.id)).find((e) => e.kind === 'attempt.finished')!.payload as { attempt: { result: string }; executions: { ok: boolean; records: number }[]; why?: unknown };
    expect(attempt.attempt.result).toBe('ok');
    expect(attempt.executions.map((e) => [e.ok, e.records])).toEqual([
      [true, 6],
      [true, 6],
      [true, 6],
    ]);
    expect(attempt.why).toBeUndefined();
    const blocked = await pool.query("SELECT 1 FROM run_logs WHERE run_id = $1 AND event = 'agent_request_blocked'", [run.id]);
    expect(blocked.rowCount).toBe(0);
  });

  test('UX-33 — un refus de la garde des requêtes porte son motif : why.params.reason dans le récit, code et motifs au journal (jamais la valeur)', async () => {
    withExtract = true;
    const secret = 'zz-test-request-secret-3301';
    secretValues.add(secret);
    fake.setScenario(MODEL, [scripted.json({ fields: [{ name: 'title', type: 'string', required: true, personal: false, description: 'Titre' }], sources: [] })]);
    const apiId = await insertApi('zz_test_inv_request_blocked');
    const run = await investigate(apiId, { url: `${base(SSR_HOST)}/?k=${secret}`, description: 'liste des produits du catalogue', auto_validate: true });
    expect(run.state).toBe('failed');
    const attempt = (await eventsOf(run.id)).find((e) => e.kind === 'attempt.finished')!.payload as { why?: unknown };
    expect(attempt.why).toEqual({ code: 'agent_request_blocked', params: { reason: 'sensitive_value', reasons: 'sensitive_value' } });
    const logs = (await pool.query<{ data: Record<string, unknown> }>("SELECT data FROM run_logs WHERE run_id = $1 AND event = 'agent_request_blocked'", [run.id])).rows;
    expect(logs.map((l) => l.data)).toEqual([expect.objectContaining({ code: 'agent_request_blocked', execution: 'agent_fetch', reasons: ['sensitive_value'] })]);
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(fake.byRole[EXTRACT_MODEL] ?? 0).toBe(0);
    // UX-29 : la fin dit sa vraie cause (aucune stratégie conforme), jamais « budget d'enquête épuisé ».
    expect(await apiRow(apiId)).toMatchObject({ status: 'erreur', status_reason: 'no_conformant_strategy' });
    expect(await detailOf(run.id)).toBe('no_conformant_strategy');
  });

  test('UX-29, UX-32 — essai plus cher que max_cost_usd : l’appel qui franchirait le plafond n’est jamais envoyé ; raison trial_cost_over_cap, distincte du budget d’enquête', async () => {
    withExtract = true;
    fake.setScenario(MODEL, [scripted.json({ fields: [{ name: 'title', type: 'string', required: true, personal: false, description: 'Titre' }], sources: [] })]);
    const items = { items: [{ title: 'Lampe Zztest 0001' }] };
    fake.setScenario(EXTRACT_MODEL, [scripted.json(items), scripted.json(items), scripted.json(items)]);
    const apiId = await insertApi('zz_test_inv_trial_over_cap');
    // Plafond par run sous le coût prévu de la mise en forme E4 (page de 20 cartes, ~1 $ par million de jetons d'entrée).
    await pool.query('UPDATE apis SET max_cost_usd = 0.0002 WHERE id = $1', [apiId]);
    const run = await investigate(apiId, { url: `${base(SSR_HOST)}/`, description: 'liste des produits du catalogue', auto_validate: true });
    expect(run).toMatchObject({ state: 'failed' });
    expect(fake.byRole[EXTRACT_MODEL] ?? 0).toBe(0);
    const attempt = (await eventsOf(run.id)).find((e) => e.kind === 'attempt.finished')!.payload as { attempt: { result: string; cost_usd: number }; why?: { code: string } };
    expect(attempt.attempt).toMatchObject({ result: 'run_budget_exceeded' });
    expect(attempt.attempt.cost_usd).toBeLessThanOrEqual(0.0002);
    expect(attempt.why).toMatchObject({ code: 'max_cost_usd' });
    expect(await apiRow(apiId)).toMatchObject({ status: 'erreur', status_reason: 'trial_cost_over_cap' });
    expect(await detailOf(run.id)).toBe('trial_cost_over_cap');
  });

  test('constat Janssens — essai coupé par le RESTE du budget d’enquête (max_cost_usd plus haut) : motif investigation_budget_usd, jamais « max_cost_usd »', async () => {
    withExtract = true;
    // Rôle investigate presque gratuit ; budget d'enquête minuscule ; max_cost_usd de l'API à 3 $ (cas des runs a55da9e7, 7cc0533a).
    price = { in: 0.001, out: 0.001 };
    fake.setScenario(MODEL, [scripted.json({ fields: [{ name: 'title', type: 'string', required: true, personal: false, description: 'Titre' }], sources: [] })]);
    const items = { items: [{ title: 'Lampe Zztest 0001' }] };
    fake.setScenario(EXTRACT_MODEL, [scripted.json(items), scripted.json(items), scripted.json(items)]);
    const apiId = await insertApi('zz_test_inv_trial_over_budget');
    await pool.query('UPDATE apis SET max_cost_usd = 3 WHERE id = $1', [apiId]);
    const run = await investigate(apiId, { url: `${base(SSR_HOST)}/`, description: 'liste des produits du catalogue', auto_validate: true, budget_usd: 0.0002 });
    expect(run).toMatchObject({ state: 'failed' });
    expect(fake.byRole[EXTRACT_MODEL] ?? 0).toBe(0);
    const attempt = (await eventsOf(run.id)).find((e) => e.kind === 'attempt.finished')!.payload as { attempt: { result: string }; why?: { code: string } };
    expect(attempt.attempt).toMatchObject({ result: 'run_budget_exceeded' });
    expect(attempt.why).toMatchObject({ code: 'investigation_budget_usd' });
    expect(await apiRow(apiId)).toMatchObject({ status: 'erreur', status_reason: 'investigation_budget_exhausted' });
    expect(await detailOf(run.id)).toBe('investigation_budget_usd');
  });

  test('D-123 — API sans plafond par run : l’essai tourne sous le budget d’enquête restant, jamais sous le reste du budget du jour (qui compte déjà la réservation de l’enquête)', async () => {
    withExtract = true;
    price = { in: 0.001, out: 0.001 };
    fake.setScenario(MODEL, [scripted.json({ fields: [{ name: 'title', type: 'string', required: true, personal: false, description: 'Titre' }], sources: [] })]);
    const items = { items: [{ title: 'Lampe Zztest 0001' }] };
    fake.setScenario(EXTRACT_MODEL, [scripted.json(items), scripted.json(items), scripted.json(items)]);
    const apiId = await insertApi('zz_test_inv_no_run_cap');
    expect((await pool.query<{ cap: string | null }>('SELECT max_cost_usd AS cap FROM apis WHERE id = $1', [apiId])).rows[0]!.cap).toBeNull();
    // Dépense du jour presque au budget du jour par défaut (50 $) : le reste du jour, réservation de l'enquête déduite, vaut 0.
    const spent = await pool.query<{ id: string }>(
      "INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, outcome, kind, cost_llm_usd, cost_proxy_usd, input) VALUES ($1, $2, $2, 'rest', 'succeeded', 'clean', 'run', 49.9999, 0, '{}') RETURNING id",
      [apiId, A],
    );
    try {
      const run = await investigate(apiId, { url: `${base(SSR_HOST)}/`, description: 'liste des produits du catalogue', auto_validate: true, budget_usd: 0.0002 });
      expect(run).toMatchObject({ state: 'failed' });
      const attempt = (await eventsOf(run.id)).find((e) => e.kind === 'attempt.finished')!.payload as { attempt: { result: string }; why?: { code: string } };
      expect(attempt.why).toMatchObject({ code: 'investigation_budget_usd' });
      // Jamais « trial_cost_over_cap » ni « max_cost_usd » : aucun plafond par run n'est fixé.
      expect(await detailOf(run.id)).toBe('investigation_budget_usd');
    } finally {
      await pool.query('DELETE FROM runs WHERE id = $1', [spent.rows[0]!.id]);
    }
  });

  test('page HTML statique, compilation refusée (valeurs divergentes deux fois) : E4 gardé tel quel, raison dans le récit', async () => {
    withExtract = true;
    const op = (name: string) => ({ op: name, pattern: null, group: null, decimal: null, format: null });
    const wrong = { records: 'article.product', fields: [{ field: 'title', css: 'span.stock', attr: null, ops: [op('trim')] }, { field: 'price', css: '.price', attr: null, ops: [op('to_number')] }] };
    fake.setScenario(MODEL, [
      scripted.json({ fields: [{ name: 'title', type: 'string', required: true, personal: false, description: 'Titre' }], sources: [] }),
      scripted.json(wrong),
      scripted.json(wrong),
    ]);
    const items = { items: [{ title: 'Lampe Zztest 0001' }, { title: 'Table Zztest 0002' }] };
    fake.setScenario(EXTRACT_MODEL, [scripted.json(items), scripted.json(items), scripted.json(items)]);
    const apiId = await insertApi('zz_test_inv_html_refused');
    const run = await investigate(apiId, { url: `${base(SSR_HOST)}/`, description: 'liste des produits du catalogue', auto_validate: true });
    expect(run).toMatchObject({ state: 'succeeded', items: 2, strategy_version: 1 });
    expect((await pool.query<{ execution: string }>('SELECT execution FROM strategy_versions WHERE api_id = $1', [apiId])).rows).toEqual([{ execution: 'agent_fetch' }]);
    const compiled = (await eventsOf(run.id)).find((e) => e.kind === 'strategy.compiled')!.payload as Record<string, unknown>;
    expect(compiled).toMatchObject({ ok: false, proposals: 2, reason: expect.stringMatching(/^(count|values|extraction|invalid_spec)$/) });
    expect(fake.byRole[MODEL]).toBe(3);
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
    // Run réel (sans job : jamais pris par le worker) : la fin d'enquête ferme le récit, rattaché à ce run.
    const runId = (await pool.query<{ id: string }>("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, kind, state) VALUES ($1, $2, $2, 'rest', 'investigation', 'running') RETURNING id", [apiId, A])).rows[0]!.id;
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
    expect(result).toMatchObject({ state: 'failed', failure_class: null, stop_reason: 'instance_contact_missing', error_detail: 'instance_contact_missing' });
    // Fin de configuration : phase close et récit fermé (l'API ne reste pas en `enquete` / access_check sans suite).
    expect((await apiRow(apiId)).investigation_phase).toBe('done');
    expect((await eventsOf(runId)).map((e) => e.kind).at(-1)).toBe('investigation.finished');
    expect((await client.stats()).total).toBe(0);
  });
});
