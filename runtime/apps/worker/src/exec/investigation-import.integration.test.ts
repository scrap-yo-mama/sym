// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 3.12 de bout en bout sur base réelle, fixtures locales (0.5), faux fournisseur LLM (15 §4), sans navigateur :
// une API exportée puis importée REPASSE PAR L'ENQUÊTE (16 § 6). L'import entre au stade `access_check` (rapport
// d'accès, robots.txt, INV11), puis `testing` : la stratégie importée est essayée par l'exécuteur de stratégie et toutes
// ses gardes, N exécutions conformes validées contre le schéma (INV1), essais journalisés par coût croissant (INV2), puis
// version `created_by = import` et statut `sain` par la machine à états (transition 1, aucun nouvel état : INV3).
// Aucun appel au LLM (la stratégie et le schéma viennent du fichier). Robots.txt interdit → `bloquee` sans essai ;
// stratégie importée non conforme → `erreur`, aucune version.
import { randomUUID } from 'node:crypto';
import { DomainPacer, generateMasterKey, MasterKey, parseApiExport, sealExport, Secret, validateOutput, type ApiExport, type RunExecutor } from '@runtime/core';
import { firstCostInversion } from '@runtime/core/investigation';
import * as net from '@runtime/core/net';
import { exportApi, importApi, keyCheck, listInvestigationEvents, migrateUp, PgBossJobQueue, PgPacingStore, readRun, runQueueDefinition, startInvestigation, withActor } from '@runtime/db';
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
const ROBOTS_HOST = 'zz_test_robots.localhost';
const MODEL = 'zz_investigate';
const A = randomUUID();
const actorA = { userId: A, role: 'member' as const };

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let client: Client;
let worker: Worker;
let fake: FakeProvider;

const base = (host: string) => `http://${host}:${client.server.port}`;

const llmConfig = (): LlmConfig => ({
  providers: [{ id: 'fake', baseUrl: fake.baseUrl, apiKey: new Secret('zz-test-key-0000'), models: [{ id: MODEL, price: { in: 1, out: 1 } }] }],
  roles: { investigate: { provider: 'fake', model: MODEL } },
});

/** Proposition scriptée du rôle `investigate` pour l'API JSON de contacts (gisement c1, pagination par page). */
const CONTACTS_PROPOSAL = {
  fields: [
    { name: 'id', type: 'string', required: true, personal: false, description: 'Identifiant du contact' },
    { name: 'city', type: 'string', required: false, personal: false, description: 'Ville' },
    { name: 'score', type: 'integer', required: true, personal: false, description: 'Score' },
  ],
  sources: [
    {
      candidate: 'c1',
      paths: [
        { field: 'id', path: '$.id', ops: [] },
        { field: 'city', path: '$.city', ops: [] },
        { field: 'score', path: '$.score', ops: [] },
      ],
      pagination: { type: 'page_param', param: 'url.query.page', start: 1, has_more_path: '$.has_more', next_path: null },
    },
  ],
};

async function insertApi(slug: string): Promise<string> {
  return (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, network_policy, domain_pacing) VALUES ($1, $2, '{"allow": ["direct", "dc_proxy"]}', '{"min_delay_ms": 5, "max_requests_per_run": 200, "max_wait_ms": 60000}') RETURNING id`,
      [slug, A],
    )
  ).rows[0]!.id;
}

const waitRun = async (runId: string) => {
  await vi.waitFor(async () => expect(['succeeded', 'failed']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), { timeout: 45_000, interval: 100 });
  return (await withActor(pool, actorA, (tx) => readRun(tx, runId)))!;
};

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

/** API de référence enquêtée (stratégie v1 fetch/direct, schémas posés), puis exportée et relue comme le ferait le serveur. */
let exported: ApiExport;

/** Import comme `POST /api/apis/import?confirm=true` : relecture du fichier, API et enquête dans la même transaction. */
async function importAs(slug: string, doc: ApiExport): Promise<{ apiId: string; runId: string }> {
  // Scellé à nouveau : les cas ci-dessous modifient la stratégie ou la demande (le fichier d'origine reste intact).
  const { integrity: _integrity, ...content } = doc;
  const parsed = parseApiExport(JSON.parse(JSON.stringify(sealExport(content))), { runtimeVersion: '9.9.9' });
  if (!parsed.ok) throw new Error(`export illisible : ${parsed.code} ${parsed.message}`);
  return withActor(pool, actorA, async (tx) => {
    const made = await importApi(tx, queue, { ownerId: A, slug, trigger: 'rest', export: parsed.export, networkPolicy: { allow: ['direct', 'dc_proxy'] } });
    // Cadence de test (fixtures locales), posée dans la transaction de l'import : le job n'est visible qu'au commit.
    await tx.query('UPDATE apis SET domain_pacing = $2 WHERE id = $1', [made.apiId, JSON.stringify({ min_delay_ms: 5, max_requests_per_run: 200, max_wait_ms: 60000 })]);
    return made;
  });
}

/** Copie de l'export dont la stratégie et la demande visent un autre hôte de fixture (même chemin), scellée à nouveau. */
function retarget(doc: ApiExport, host: string, path: string): ApiExport {
  const text = JSON.stringify(doc).replaceAll(API_HOST, host);
  const moved = JSON.parse(text) as ApiExport;
  return { ...moved, api: { ...moved.api, source_url: `${base(host)}${path}` } };
}

beforeAll(async () => {
  client = await startClient();
  fake = await createFakeProvider();
  tdb = await createTestDatabase('investigation_import');
  await migrateUp({ connectionString: tdb.url });
  const masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: tdb.url, max: 8 });
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_import@example.test', 'active')", [A]);
  await pool.query("INSERT INTO settings (key, value) VALUES ('proxies', $1)", [JSON.stringify([{ id: 'zz_test_dc', type: 'dc', url: 'http://127.0.0.1:9', price: { per_gb_usd: 10 } }])]);
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  const guard = fixtureGuard(client.server.port, [API_HOST, ROBOTS_HOST], net);
  const pacer = new DomainPacer(new PgPacingStore(pool));
  const strategy = createStrategyRuntime({ pool, guard, pacer, browsers: null, instanceContact: async () => 'mailto:ops@zz-test.example', version: '9.9.9' });
  const investigation = createInvestigationExecutor({
    pool,
    guard,
    pacer,
    browsers: null,
    strategy,
    llm: { config: async () => llmConfig(), client: (config) => createLlmClient(config) },
    instanceContact: async () => 'mailto:ops@zz-test.example',
    version: '9.9.9',
  });
  const executor: RunExecutor = dispatchByKind({ run: strategy.executor, investigation });
  worker = await startWorker({
    config: loadWorkerConfig({ DATABASE_URL: tdb.url, MASTER_KEY: masterKey, QUEUE_POLLING_SECONDS: '0.5', RUN_HEARTBEAT_SECONDS: '0.5', RUN_STALE_SECONDS: '10', BROWSER_CONCURRENCY: '1' }),
    executor,
    logger: pino({ level: 'silent' }),
  });

  // Référence : enquête complète (LLM scripté) sur la fixture API JSON, puis export.
  fake.setScenario(MODEL, [scripted.json(CONTACTS_PROPOSAL)]);
  const refId = await insertApi('zz-test-import-ref');
  const { runId } = await withActor(pool, actorA, (tx) => startInvestigation(tx, queue, { apiId: refId, ownerId: A, trigger: 'rest', request: { url: `${base(API_HOST)}/`, description: 'liste des contacts', auto_validate: true } }));
  expect(await waitRun(runId)).toMatchObject({ state: 'succeeded', strategy_version: 1 });
  const doc = await withActor(pool, actorA, (tx) => exportApi(tx, { apiId: refId, ownerId: A, exportedAt: new Date('2026-10-02T10:00:00Z') }));
  if (doc === null) throw new Error('export introuvable');
  exported = doc;
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
  await client.reset();
});

describe('import : repasse par l’enquête (tâche 3.12)', () => {
  test('access_check puis testing de la stratégie importée : N exécutions conformes, version created_by import, sain, aucun appel LLM', async () => {
    expect(exported.strategy).toMatchObject({ execution: 'fetch', network: 'direct' });
    const { apiId, runId } = await importAs('zz-test-import-ok', exported);
    expect(await apiRow(apiId)).toMatchObject({ status: 'enquete', investigation_phase: 'access_check', current_strategy_version: null });
    const run = await waitRun(runId);
    expect(run).toMatchObject({ state: 'succeeded', outcome: 'clean', strategy_version: 1 });

    const api = await apiRow(apiId);
    expect(api).toMatchObject({ status: 'sain', status_reason: 'strategy_conform', investigation_phase: 'done', current_strategy_version: 1 });
    expect(api.output_schema).toEqual(exported.api.output_schema);
    expect(api.input_schema).toEqual(exported.api.input_schema);
    const sv = (await pool.query<{ execution: string; network: string; created_by: string; spec: unknown }>('SELECT execution, network, created_by, spec FROM strategy_versions WHERE api_id = $1', [apiId])).rows;
    expect(sv).toEqual([{ execution: 'fetch', network: 'direct', created_by: 'import', spec: exported.strategy!.spec }]);

    // INV2 : essais journalisés par coût croissant, fetch/direct d'abord ; INV1 : items livrés conformes au schéma.
    const attempts = await attemptsOf(runId);
    expect(attempts[0]).toMatchObject({ execution: 'fetch', network: 'direct', result_class: 'ok' });
    expect(firstCostInversion(attempts.map((x) => (x.est_cost_usd === null ? null : Number(x.est_cost_usd))))).toBe(-1);
    const items = await withActor(pool, actorA, (tx) => tx.query<{ item: unknown }>('SELECT item FROM dataset_items WHERE dataset_id = $1', [run.dataset_id]));
    expect(items.rows.length).toBeGreaterThan(0);
    for (const r of items.rows) expect(validateOutput(api.output_schema, r.item)).toEqual({ ok: true });

    // Récit : étape 0 (rapport d'accès) avant tout essai, puis `testing` ; ni reconnaissance ni schéma proposé ; aucun LLM.
    const events = await eventsOf(runId);
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe('investigation.started');
    expect(kinds.indexOf('access_report')).toBeGreaterThan(-1);
    expect(kinds.indexOf('access_report')).toBeLessThan(kinds.indexOf('attempt.finished'));
    expect(kinds.filter((k) => k.startsWith('reconnaissance') || k === 'schema.proposed')).toEqual([]);
    const testing = events.find((e) => e.kind === 'phase.started' && (e.payload as { phase: string }).phase === 'testing')!.payload as { plan: { execution: string; network: string; source: string }[] };
    expect(testing.plan.map((p) => `${p.execution}/${p.network}/${p.source}`)).toEqual(['fetch/direct/import', 'fetch/dc_proxy/import']);
    const finished = events.filter((e) => e.kind === 'attempt.finished').map((e) => e.payload as { executions: { ok: boolean }[] });
    expect(finished[0]!.executions.length).toBe(3);
    expect(finished[0]!.executions.every((x) => x.ok)).toBe(true);
    expect(fake.requests).toBe(0);
  });

  test('INV11 : robots.txt interdit le chemin de l’API importée → rapport d’accès seul, bloquee, aucun essai, aucune requête sur /prive/', async () => {
    const { apiId, runId } = await importAs('zz-test-import-robots', retarget(exported, ROBOTS_HOST, '/prive/liste'));
    const run = await waitRun(runId);
    expect(run).toMatchObject({ state: 'failed', failure_class: 'robots_disallowed', retryable: false });
    expect(await apiRow(apiId)).toMatchObject({ status: 'bloquee', status_reason: 'robots_disallowed', current_strategy_version: null });
    expect(await attemptsOf(runId)).toEqual([]);
    const kinds = (await eventsOf(runId)).map((e) => e.kind);
    expect(kinds).toContain('access_report');
    expect(kinds.filter((k) => k.startsWith('attempt'))).toEqual([]);
    const paths = (await client.stats()).hosts[ROBOTS_HOST]?.paths ?? {};
    expect(Object.entries(paths).filter(([p]) => p.startsWith('/prive/')).reduce((n, [, c]) => n + c, 0)).toBe(0);
    expect(fake.requests).toBe(0);
  });

  test('stratégie importée non conforme (aucun enregistrement) : erreur, aucune version, aucun appel LLM ni repli', async () => {
    const broken = JSON.parse(JSON.stringify(exported)) as ApiExport & { strategy: { spec: { sources: { records: string }[] } } };
    broken.strategy.spec.sources[0]!.records = '$.zz_absent[*]';
    const { apiId, runId } = await importAs('zz-test-import-broken', broken);
    const run = await waitRun(runId);
    expect(run).toMatchObject({ state: 'failed' });
    expect(await apiRow(apiId)).toMatchObject({ status: 'erreur', current_strategy_version: null, investigation_phase: 'done' });
    expect((await pool.query('SELECT 1 FROM strategy_versions WHERE api_id = $1', [apiId])).rowCount).toBe(0);
    expect((await attemptsOf(runId)).length).toBeGreaterThan(0);
    expect(fake.requests).toBe(0);
  });
});
