// SPDX-License-Identifier: AGPL-3.0-only
// Test d'un brouillon par le worker (tâche 3.14, 19 §6) : un run `draft_test` rejoue la stratégie du BROUILLON contre son schéma de
// sortie, avec les gardes d'un run, mais ne change jamais le statut de l'API (assert_draft_run_no_status_change), ne répare pas, ne
// compile pas et ne mesure pas la qualité ; un run normal du même moment sert toujours la version en service.
import { randomUUID } from 'node:crypto';
import { DomainPacer, generateMasterKey, MasterKey } from '@runtime/core';
import * as net from '@runtime/core/net';
import { createRun, keyCheck, migrateUp, PgBossJobQueue, PgPacingStore, readRun, refineDraft, runQueueDefinition, withActor } from '@runtime/db';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { startClient, type Client } from '../../../../fixtures/src/test-helpers.ts';
import { contactsSpecInput, fixtureGuard, SCHEMA_CONTACT } from '../../../../tests/helpers/fixture-net.ts';
import { createTestDatabase, type TestDatabase } from '../../../../tests/helpers/pg.js';
import { loadWorkerConfig } from '../config.js';
import { startWorker, type Worker } from '../worker.js';
import { createStrategyExecutor } from './strategy-executor.js';

const API_HOST = 'zz_test_api_json.localhost';
const LOGIN_HOST = 'zz_test_login.localhost';
const A = randomUUID();
const actorA = { userId: A, role: 'member' as const };

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let client: Client;
let worker: Worker;

const withProp = (extra: Record<string, unknown>, required: string[] = []) => ({
  ...SCHEMA_CONTACT,
  required: [...SCHEMA_CONTACT.required, ...required],
  properties: { ...SCHEMA_CONTACT.properties, ...extra },
});

async function seedApi(slug: string): Promise<string> {
  const base = `http://${API_HOST}:${client.server.port}`;
  const id = (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, status, output_schema, domain_pacing) VALUES ($1, $2, 'sain', $3, '{"min_delay_ms": 5, "max_requests_per_run": 200, "max_wait_ms": 60000}') RETURNING id`,
      [slug, A, JSON.stringify(SCHEMA_CONTACT)],
    )
  ).rows[0]!.id;
  await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, est_cost_usd, created_by) VALUES ($1, 1, $2, 'fetch', 'direct', $3, 0, 'user')", [id, A, JSON.stringify(contactsSpecInput(base, API_HOST, 50))]);
  await pool.query('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [id]);
  return id;
}

async function draftRun(apiId: string, version: number) {
  const { runId } = await withActor(pool, actorA, async (tx) => {
    const made = await createRun(tx, queue, { apiId, ownerId: A, trigger: 'draft_test' });
    await tx.query('UPDATE runs SET strategy_version = $2 WHERE id = $1', [made.runId, version]);
    return made;
  });
  await vi.waitFor(async () => expect(['succeeded', 'failed']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), { timeout: 30_000, interval: 100 });
  return (await withActor(pool, actorA, (tx) => readRun(tx, runId)))!;
}

const sideEffects = async (apiId: string) => ({
  events: Number((await pool.query('SELECT count(*) FROM status_events WHERE api_id = $1', [apiId])).rows[0].count),
  status: (await pool.query<{ status: string; current_strategy_version: number }>('SELECT status, current_strategy_version FROM apis WHERE id = $1', [apiId])).rows[0]!,
  versions: Number((await pool.query('SELECT count(*) FROM strategy_versions WHERE api_id = $1', [apiId])).rows[0].count),
  profiles: Number((await pool.query('SELECT count(*) FROM run_profiles WHERE api_id = $1', [apiId])).rows[0].count),
});

beforeAll(async () => {
  client = await startClient();
  tdb = await createTestDatabase('draft_exec');
  await migrateUp({ connectionString: tdb.url });
  const masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: tdb.url, max: 6 });
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_draft_exec@example.test', 'active')", [A]);
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  const guard = fixtureGuard(client.server.port, [API_HOST, LOGIN_HOST], net);
  const executor = createStrategyExecutor({ pool, guard, pacer: new DomainPacer(new PgPacingStore(pool)), browsers: null });
  worker = await startWorker({
    config: loadWorkerConfig({ DATABASE_URL: tdb.url, MASTER_KEY: masterKey, QUEUE_POLLING_SECONDS: '0.5', RUN_HEARTBEAT_SECONDS: '0.5', RUN_STALE_SECONDS: '5', BROWSER_CONCURRENCY: '1' }),
    executor,
    logger: pino({ level: 'silent' }),
  });
}, 180_000);

afterAll(async () => {
  await worker?.stop();
  await queue?.stop({ timeoutMs: 1000 });
  await pool?.end();
  await tdb?.drop();
  await client?.close();
});

describe('assert_draft_run_no_status_change : run draft_test', () => {
  test('brouillon conforme : 500 items contre le schéma du brouillon, run tracé, aucun statut, aucune version, aucune baseline', async () => {
    const apiId = await seedApi('zz_test_draft_ok');
    const refined = await refineDraft(pool, { apiId, ownerId: A, authorId: A, origin: 'mcp', feedback: { text: 'ajoute le pays' }, outputSchema: withProp({ country: { type: 'string' } }) });
    const before = await sideEffects(apiId);
    const run = await draftRun(apiId, refined.draft_version);
    expect(run).toMatchObject({ state: 'succeeded', outcome: 'clean', items: 500, strategy_version: refined.draft_version });
    expect((await pool.query('SELECT trigger FROM runs WHERE id = $1', [run.id])).rows[0].trigger).toBe('draft_test');
    expect(run.attempts).toHaveLength(1);
    expect(run.attempts[0]).toMatchObject({ result: 'ok' });
    // Aucun effet de bord : statut, `status_events`, versions (pas de compilation ni de réparation), profil de qualité.
    expect(await sideEffects(apiId)).toEqual({ ...before, versions: before.versions });
    expect((await sideEffects(apiId)).events).toBe(0);
    expect((await sideEffects(apiId)).status).toEqual({ status: 'sain', current_strategy_version: 1 });
  });

  test('schéma du brouillon qui exige un champ sans chemin d’extraction : le run ne démarre pas (invalid_strategy_spec), rien n’est réparé', async () => {
    const apiId = await seedApi('zz_test_draft_nopath');
    const refined = await refineDraft(pool, { apiId, ownerId: A, authorId: A, origin: 'mcp', outputSchema: withProp({ country: { type: 'string' } }, ['country']) });
    const before = await sideEffects(apiId);
    const run = await draftRun(apiId, refined.draft_version);
    expect(run).toMatchObject({ state: 'failed', failure_class: 'code_error' });
    expect((await pool.query('SELECT error_detail FROM runs WHERE id = $1', [run.id])).rows[0].error_detail).toBe('invalid_strategy_spec');
    expect(await sideEffects(apiId)).toEqual(before);
  });

  test('brouillon non conforme à SON schéma (items écartés) : le run échoue en extraction, rien n’est promu, réparé ni journalisé au statut', async () => {
    const apiId = await seedApi('zz_test_draft_reject');
    const refined = await refineDraft(pool, { apiId, ownerId: A, authorId: A, origin: 'mcp', outputSchema: { ...SCHEMA_CONTACT, properties: { ...SCHEMA_CONTACT.properties, name: { type: 'string', maxLength: 1 } } } });
    const before = await sideEffects(apiId);
    const run = await draftRun(apiId, refined.draft_version);
    expect(run).toMatchObject({ state: 'failed', failure_class: 'extraction' });
    expect(run.items_rejected).toBeGreaterThan(0);
    expect(await sideEffects(apiId)).toEqual(before);
    expect((await sideEffects(apiId)).status.status).toBe('sain');
  });

  test('refus 401 pendant le test : la classe est rendue, mais l’API ne passe ni en réparation ni en action requise', async () => {
    const apiId = await seedApi('zz_test_draft_401');
    const refined = await refineDraft(pool, { apiId, ownerId: A, authorId: A, origin: 'mcp', outputSchema: withProp({ country: { type: 'string' } }) });
    const login = `http://${LOGIN_HOST}:${client.server.port}`;
    const spec = {
      schema_version: 1,
      kind: 'declarative',
      request: { method: 'GET', url: `${login}/api/orders`, allowed_hosts: [LOGIN_HOST] },
      sources: [{ id: 'api', from: 'response', records: '$.items[*]' }],
      fields: { id: { path: '$.id', type: 'string', required: true } },
    };
    await pool.query('UPDATE strategy_versions SET output_schema = $3::jsonb WHERE api_id = $1 AND version = $2', [apiId, refined.draft_version, JSON.stringify({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] })]);
    await pool.query('UPDATE strategy_versions SET spec = $3::jsonb WHERE api_id = $1 AND version = $2', [apiId, refined.draft_version, JSON.stringify(spec)]);
    const before = await sideEffects(apiId);
    const run = await draftRun(apiId, refined.draft_version);
    expect(run).toMatchObject({ state: 'failed', failure_class: 'auth_required' });
    expect(await sideEffects(apiId)).toEqual(before);
    expect((await sideEffects(apiId)).events).toBe(0);
  });

  test('un run normal du même moment sert la version en service, avec son schéma', async () => {
    const apiId = await seedApi('zz_test_draft_current');
    await refineDraft(pool, { apiId, ownerId: A, authorId: A, origin: 'mcp', outputSchema: withProp({ country: { type: 'string' } }, ['country']) });
    const { runId } = await withActor(pool, actorA, (tx) => createRun(tx, queue, { apiId, ownerId: A, trigger: 'rest' }));
    await vi.waitFor(async () => expect(['succeeded', 'failed']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), { timeout: 30_000, interval: 100 });
    const run = (await withActor(pool, actorA, (tx) => readRun(tx, runId)))!;
    expect(run).toMatchObject({ state: 'succeeded', items: 500, strategy_version: 1 });
  });
});
