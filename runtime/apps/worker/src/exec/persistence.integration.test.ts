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

/**
 * API saine (enquête réelle, validation automatique demandée à la création), puis cassée (rejeu en extraction,
 * réparation abandonnée : 11 puis 13) avec le mode activé en console. `startAt` : horloge simulée du mode.
 */
async function healthyThenBroken(slug: string, startAt: number, budgetUsd?: number) {
  fake.setScenario(MODEL, [scripted.json(PROPOSAL)]);
  const apiId = (await pool.query<{ id: string }>("INSERT INTO apis (slug, owner_id, domain_pacing) VALUES ($2, $1, '{\"min_delay_ms\": 5, \"max_requests_per_run\": 200, \"max_wait_ms\": 60000}') RETURNING id", [A, slug])).rows[0]!.id;
  const { runId: first } = await withActor(pool, actorA, (tx) => startInvestigation(tx, queue, { apiId, ownerId: A, trigger: 'rest', request: { url: `http://${API_HOST}:${client.server.port}/`, description: 'liste des contacts', auto_validate: true } }));
  expect(await waitRun(first)).toMatchObject({ state: 'succeeded', strategy_version: 1 });
  // La validation automatique de la création n'est pas celle d'une ré-enquête ultérieure : le propriétaire la coupe.
  await pool.query("UPDATE apis SET investigation = jsonb_set(investigation, '{request,auto_validate}', 'false') WHERE id = $1", [apiId]);
  const clock = { at: startAt };
  const ctx: PersistenceContext = { queue, now: () => new Date(clock.at), random: () => 0.5, negativeMemory: { available: true, priorRefusal: async () => false } };
  expect(await setPersistenceMode(pool, ctx, { apiId, actor: { userId: A, via: 'ui' }, enable: true, ...(budgetUsd === undefined ? {} : { budgetUsd }) })).toEqual({ ok: true });
  const replay = (await pool.query<{ id: string }>("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, failure_class, finished_at) VALUES ($1, $2, $2, 'ui', 'failed', 'extraction', now()) RETURNING id", [apiId, A])).rows[0]!.id;
  for (const event of [{ type: 'run_failed', failureClass: 'extraction' }, { type: 'repair_failed', cause: 'budget_exhausted' }] as const) {
    expect((await applyStatusAndNotify(pool, queue, { apiId, runId: replay, event, clock: { now: () => new Date(clock.at) } }, { now: () => new Date(clock.at), persistence: ctx })).ok).toBe(true);
  }
  expect(await readPersistenceState(pool, { apiId, userId: A })).toMatchObject({ enabled: true, attempt: 0, next_at: new Date(clock.at + 3_600_000).toISOString() });
  return { apiId, ctx, clock };
}

const finishedEvent = async (runId: string) =>
  (await pool.query<{ payload: { outcome: string; failure_class?: string; detail?: string; budget: { max_usd: number } } }>(
    "SELECT payload FROM investigation_events WHERE run_id = $1 AND kind = 'investigation.finished' ORDER BY seq DESC LIMIT 1",
    [runId],
  )).rows[0]?.payload;

describe('assert_persistence_schedule_and_caps (worker réel)', () => {
  test('tentative due : 16, ré-enquête sur le schéma validé sans appel LLM, retour à sain par la 1, cycle clos, bail rendu', async () => {
    const { apiId, ctx, clock: c } = await healthyThenBroken('zz_test_persist', Date.now(), 0.4);
    const contract = (await pool.query<{ output_schema: unknown }>('SELECT output_schema FROM apis WHERE id = $1', [apiId])).rows[0]!.output_schema;
    const llmCalls = fake.requests;
    c.at += 3_600_000;
    const tick = await runPersistenceAttempt(pool, ctx, apiId);
    expect(tick).toMatchObject({ kind: 'launched', attempt: 1 });
    const attempt = await waitRun((tick as { runId: string }).runId);
    expect(attempt).toMatchObject({ state: 'succeeded', strategy_version: 2 });
    // Plafond strict : l'enquête de la tentative est bornée par le plafond du mode (0,4 $), pas par sa demande (1 $).
    expect((await finishedEvent((tick as { runId: string }).runId))?.budget.max_usd).toBe(0.4);
    // La demande du propriétaire reste sans validation automatique.
    expect((await pool.query<{ v: boolean }>("SELECT (investigation -> 'request' ->> 'auto_validate')::boolean AS v FROM apis WHERE id = $1", [apiId])).rows[0]!.v).toBe(false);

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

describe('assert_persistence_never_on_refusal (worker réel)', () => {
  // La page répond, la source de données répond 451 : à la reconnaissance (première page), ou pendant les essais seulement
  // (page 2 : tous les couples épuisés, le dernier sur un 451). Dans les deux cas, le run garde `network/geo_restriction`,
  // le mode s'arrête (refused) et plus aucune tentative ne part. Horloges du mode décalées : le créneau du domaine pris
  // par un test précédent est passé.
  test.each([
    ['data_451', 3, 'reconnaissance'],
    ['data_451_page_2', 6, 'testing'],
  ] as const)('451 de la source de données (%s) pendant une tentative : run network/geo_restriction, fin du mode (refused), 0 tentative ensuite', async (mutation, offsetDays, at) => {
    const { apiId, ctx, clock: c } = await healthyThenBroken(`zz_test_persist_${mutation}`, Date.now() + offsetDays * 86_400_000);
    await client.control({ op: 'site', site: 'api_json', mutation });
    try {
      c.at += 3_600_000;
      const tick = await runPersistenceAttempt(pool, ctx, apiId);
      expect(tick).toMatchObject({ kind: 'launched', attempt: 1 });
      const runId = (tick as { runId: string }).runId;
      expect(await waitRun(runId)).toMatchObject({ state: 'failed', failure_class: 'network' });
      expect((await pool.query<{ error_detail: string }>('SELECT error_detail FROM runs WHERE id = $1', [runId])).rows[0]!.error_detail).toBe('geo_restriction');
      expect(await finishedEvent(runId)).toMatchObject({ outcome: 'failed', failure_class: 'network', detail: 'geo_restriction', at });
      await vi.waitFor(async () => expect(await readPersistenceState(pool, { apiId, userId: A })).toMatchObject({ ended: 'refused', ended_reason: 'geo_restricted', next_at: null }), { timeout: 10_000, interval: 100 });
      for (const days of [1, 2, 5]) {
        c.at += days * 86_400_000;
        expect((await runPersistenceAttempt(pool, ctx, apiId)).kind).toBe('idle');
      }
      expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM runs WHERE api_id = $1 AND kind = 'investigation'", [apiId])).rows[0]!.n).toBe(2);
    } finally {
      await client.control({ op: 'site', site: 'api_json', mutation: 'none' });
    }
  }, 120_000);
});
