// SPDX-License-Identifier: AGPL-3.0-only
// Mode « SYM ne lâche pas » (tâche 2.16, D-49) de bout en bout : worker réel, exécuteur d'enquête réel, faux fournisseur
// LLM, fixture API JSON locale, sans navigateur. Une API saine entre en `erreur` (10 puis 13), le mode est activé, la
// tentative due part (16) : le worker ré-enquête sur le schéma VALIDÉ (aucun appel LLM, contrat inchangé), la fixture
// répond, l'API revient à `sain` par la 1 avec une version de stratégie de plus ; le cycle est clos et le bail rendu.
// Les créneaux, plafonds, refus et le domaine partagé sont joués en logique de base sous horloge simulée
// (packages/db/src/persistence.integration.test.ts).
import { randomUUID } from 'node:crypto';
import { DomainPacer, generateMasterKey, MasterKey, Secret, type RunExecutor } from '@runtime/core';
import * as net from '@runtime/core/net';
import {
  applyStatusAndNotify,
  keyCheck,
  migrateUp,
  PgBossJobQueue,
  PgPacingStore,
  readPersistenceState,
  readRun,
  runPersistenceAttempt,
  runQueueDefinition,
  setPersistenceMode,
  startInvestigation,
  withActor,
  type PersistenceContext,
} from '@runtime/db';
import { createLlmClient, type LlmConfig } from '@runtime/llm';
import { createFakeProvider, scripted, type FakeProvider } from '@runtime/llm/testing';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { startClient, type Client } from '../../../../fixtures/src/test-helpers.ts';
import { fixtureGuard } from '../../../../tests/helpers/fixture-net.ts';
import { createTestDatabase, type TestDatabase } from '../../../../tests/helpers/pg.js';
import { loadWorkerConfig } from '../config.js';
import { startWorker, type Worker } from '../worker.js';
import { createInvestigationExecutor, dispatchByKind } from './investigation-executor.js';
import { createStrategyRuntime } from './strategy-executor.js';

const API_HOST = 'zz_test_api_json.localhost';
const MODEL = 'zz_investigate';
const A = randomUUID();
const actorA = { userId: A, role: 'member' as const };

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let client: Client;
let worker: Worker;
let fake: FakeProvider;

const llmConfig = (): LlmConfig => ({
  providers: [{ id: 'fake', baseUrl: fake.baseUrl, apiKey: new Secret('zz-test-key-0000'), models: [{ id: MODEL, price: { in: 1, out: 1 } }] }],
  roles: { investigate: { provider: 'fake', model: MODEL } },
});

const PROPOSAL = {
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

const waitRun = async (runId: string) => {
  await vi.waitFor(async () => expect(['succeeded', 'failed']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), {
    timeout: 45_000,
    interval: 100,
  });
  return (await withActor(pool, actorA, (tx) => readRun(tx, runId)))!;
};

beforeAll(async () => {
  client = await startClient();
  fake = await createFakeProvider();
  tdb = await createTestDatabase('persistence_worker');
  await migrateUp({ connectionString: tdb.url });
  const masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: tdb.url, max: 8 });
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_persistence@example.test', 'active')", [A]);
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  const guard = fixtureGuard(client.server.port, [API_HOST], net);
  const pacer = new DomainPacer(new PgPacingStore(pool));
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

describe('assert_persistence_schedule_and_caps (worker réel)', () => {
  test('tentative due : 16, ré-enquête sur le schéma validé sans appel LLM, retour à sain par la 1, cycle clos, bail rendu', async () => {
    fake.setScenario(MODEL, [scripted.json(PROPOSAL)]);
    const apiId = (await pool.query<{ id: string }>("INSERT INTO apis (slug, owner_id, domain_pacing) VALUES ('zz_test_persist', $1, '{\"min_delay_ms\": 5, \"max_requests_per_run\": 200, \"max_wait_ms\": 60000}') RETURNING id", [A])).rows[0]!.id;
    const { runId: first } = await withActor(pool, actorA, (tx) => startInvestigation(tx, queue, { apiId, ownerId: A, trigger: 'rest', request: { url: `http://${API_HOST}:${client.server.port}/`, description: 'liste des contacts', auto_validate: true } }));
    expect(await waitRun(first)).toMatchObject({ state: 'succeeded', strategy_version: 1 });
    const contract = (await pool.query<{ output_schema: unknown }>('SELECT output_schema FROM apis WHERE id = $1', [apiId])).rows[0]!.output_schema;
    const llmCalls = fake.requests;

    // L'API casse (rejeu en extraction, réparation abandonnée) : 11 puis 13, le mode était activé en console.
    let clock = Date.now();
    const ctx: PersistenceContext = { queue, now: () => new Date(clock), random: () => 0.5, negativeMemory: { available: true, priorRefusal: async () => false } };
    expect(await setPersistenceMode(pool, ctx, { apiId, actor: { userId: A, via: 'ui' }, enable: true })).toEqual({ ok: true });
    const replay = (await pool.query<{ id: string }>("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, failure_class, finished_at) VALUES ($1, $2, $2, 'ui', 'failed', 'extraction', now()) RETURNING id", [apiId, A])).rows[0]!.id;
    for (const event of [{ type: 'run_failed', failureClass: 'extraction' }, { type: 'repair_failed', cause: 'budget_exhausted' }] as const) {
      expect((await applyStatusAndNotify(pool, queue, { apiId, runId: replay, event, clock: { now: () => new Date(clock) } }, { now: () => new Date(clock), persistence: ctx })).ok).toBe(true);
    }
    expect(await readPersistenceState(pool, { apiId, userId: A })).toMatchObject({ enabled: true, attempt: 0, next_at: new Date(clock + 3_600_000).toISOString() });

    clock += 3_600_000;
    const tick = await runPersistenceAttempt(pool, ctx, apiId);
    expect(tick).toMatchObject({ kind: 'launched', attempt: 1 });
    const attempt = await waitRun((tick as { runId: string }).runId);
    expect(attempt).toMatchObject({ state: 'succeeded', strategy_version: 2 });

    const api = (await pool.query<{ status: string; output_schema: unknown; repair_lease_owner: string | null; current_strategy_version: number }>(
      'SELECT status, output_schema, repair_lease_owner, current_strategy_version FROM apis WHERE id = $1',
      [apiId],
    )).rows[0]!;
    expect(api).toMatchObject({ status: 'sain', repair_lease_owner: null, current_strategy_version: 2 });
    // INV1 : une tentative ne change jamais le contrat ; schéma validé repris tel quel, aucun appel LLM d'enquête.
    expect(api.output_schema).toEqual(contract);
    expect(fake.requests).toBe(llmCalls);
    const transitions = (await pool.query<{ from_status: string; to_status: string; reason: string }>('SELECT from_status, to_status, reason FROM status_events WHERE api_id = $1 ORDER BY id', [apiId])).rows.map((r) => `${r.from_status}>${r.to_status}:${r.reason}`);
    expect(transitions.slice(-3)).toEqual(['reparation>erreur:repair_budget_exhausted', 'erreur>enquete:persistence_attempt', 'enquete>sain:strategy_conform']);
    expect(await readPersistenceState(pool, { apiId, userId: A })).toMatchObject({ enabled: true, attempt: 0, next_at: null, in_progress: false });
  }, 120_000);
});
