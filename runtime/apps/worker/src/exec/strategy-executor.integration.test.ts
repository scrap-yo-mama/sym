// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.6 de bout en bout sur base réelle : run mis en file côté web → worker (1.3) → exécuteur de stratégie E1 avec
// cadence par domaine en base (1.9) → dataset écrit comme le propriétaire, essai tracé (INV4), sortie conforme (INV1).
// Refus : 401 → auth_required sans dataset ; E2 sans navigateur (DISABLE_BROWSER) ; proxy absent → proxy_not_configured.
// RGPD (D-28) : items extraits inscrits au registre du run, sujet effacé retiré avant écriture du dataset.
import { randomUUID } from 'node:crypto';
import { DomainPacer, generateMasterKey, MasterKey, validateOutput, type RunExecutor } from '@runtime/core';
import * as net from '@runtime/core/net';
import {
  createRun,
  eraseSubject,
  keyCheck,
  loadSubjectKey,
  migrateUp,
  PgBossJobQueue,
  PgPacingStore,
  readRun,
  resolveSubjectValues,
  runQueueDefinition,
  withActor,
} from '@runtime/db';
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
let masterKeyText: string;
/** Taille du registre de masquage du dernier run, lue à la sortie de l'exécuteur (le worker le vide ensuite). */
let lastPersonalSize = -1;

async function insertApi(slug: string, strategy: { execution: string; network: string; spec: unknown }, extra: { outputSchema?: unknown } = {}): Promise<string> {
  const id = (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, output_schema, domain_pacing) VALUES ($1, $2, $3, '{"min_delay_ms": 5, "max_requests_per_run": 200, "max_wait_ms": 60000}') RETURNING id`,
      [slug, A, JSON.stringify(extra.outputSchema ?? {})],
    )
  ).rows[0]!.id;
  await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, est_cost_usd, created_by) VALUES ($1, 1, $2, $3, $4, $5, 0, 'user')", [
    id,
    A,
    strategy.execution,
    strategy.network,
    JSON.stringify(strategy.spec),
  ]);
  await pool.query('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [id]);
  return id;
}

const runOf = async (apiId: string) => {
  const { runId } = await withActor(pool, actorA, (tx) => createRun(tx, queue, { apiId, ownerId: A, trigger: 'rest' }));
  await vi.waitFor(async () => expect(['succeeded', 'failed']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), {
    timeout: 30_000,
    interval: 100,
  });
  return (await withActor(pool, actorA, (tx) => readRun(tx, runId)))!;
};

beforeAll(async () => {
  client = await startClient();
  tdb = await createTestDatabase('exec');
  await migrateUp({ connectionString: tdb.url });
  const masterKey = generateMasterKey();
  masterKeyText = masterKey;
  pool = new pg.Pool({ connectionString: tdb.url, max: 6 });
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_exec@example.test', 'active')", [A]);
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  const guard = fixtureGuard(client.server.port, [API_HOST, LOGIN_HOST, 'zz_test_ssrf.localhost', 'zz_test_internal.localhost'], net);
  const real = createStrategyExecutor({ pool, guard, pacer: new DomainPacer(new PgPacingStore(pool)), browsers: null });
  const executor: RunExecutor = async (ctx) => {
    const result = await real(ctx);
    lastPersonalSize = ctx.personal.size;
    return result;
  };
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

describe('exécuteur de stratégie branché sur le worker', () => {
  test('E1 : 500 contacts conformes, dataset écrit comme le propriétaire, un essai tracé, cadence par domaine', async () => {
    const base = `http://${API_HOST}:${client.server.port}`;
    const apiId = await insertApi('zz_test_e1', { execution: 'fetch', network: 'direct', spec: contactsSpecInput(base, API_HOST, 50) }, { outputSchema: SCHEMA_CONTACT });
    const run = await runOf(apiId);
    expect(run).toMatchObject({ state: 'succeeded', outcome: 'clean', items: 500, strategy_version: 1 });
    expect(run.attempts).toHaveLength(1);
    expect(run.attempts[0]).toMatchObject({ execution: 'fetch', network: 'direct', result: 'ok', cost_usd: 0 });
    expect(run.dataset_id).not.toBeNull();
    const items = await withActor(pool, actorA, (tx) =>
      tx.query<{ item: unknown; seq: number }>('SELECT item, seq FROM dataset_items WHERE dataset_id = $1 ORDER BY seq', [run.dataset_id]),
    );
    expect(items.rows).toHaveLength(500);
    expect(items.rows.map((r) => r.seq)).toEqual(Array.from({ length: 500 }, (_, i) => i));
    for (const r of items.rows) expect(validateOutput(SCHEMA_CONTACT, r.item)).toEqual({ ok: true });
    const dataset = (await pool.query<{ owner_id: string; item_count: number; bytes: string }>('SELECT owner_id, item_count, bytes FROM datasets WHERE id = $1', [run.dataset_id])).rows[0]!;
    expect(dataset).toMatchObject({ owner_id: A, item_count: 500 });
    expect(Number(dataset.bytes)).toBeGreaterThan(0);
    // Cadence (1.9) : clé = domaine de la cible.
    const pacing = await pool.query<{ domain: string }>('SELECT domain FROM domain_pacing_state');
    expect(pacing.rows.map((r) => r.domain)).toContain(API_HOST);
  });

  test('401 → auth_required, aucune extraction ni dataset', async () => {
    const base = `http://${LOGIN_HOST}:${client.server.port}`;
    const spec = {
      schema_version: 1,
      kind: 'declarative',
      request: { method: 'GET', url: `${base}/api/orders`, allowed_hosts: [LOGIN_HOST] },
      sources: [{ id: 'api', from: 'response', records: '$.items[*]' }],
      fields: { id: { path: '$.id', type: 'string', required: true } },
    };
    const run = await runOf(await insertApi('zz_test_401', { execution: 'fetch', network: 'direct', spec }));
    expect(run).toMatchObject({ state: 'failed', failure_class: 'auth_required', retryable: false, items: 0, dataset_id: null });
    expect(run.attempts[0]).toMatchObject({ execution: 'fetch', result: 'auth_required' });
  });

  test('E2 sans navigateur (DISABLE_BROWSER) → code_error browser_disabled ; dc_proxy sans proxy défini → proxy_not_configured', async () => {
    const base = `http://${API_HOST}:${client.server.port}`;
    const e2 = await runOf(await insertApi('zz_test_e2_off', { execution: 'fetch_in_page', network: 'direct', spec: contactsSpecInput(base, API_HOST) }));
    expect(e2).toMatchObject({ state: 'failed', failure_class: 'code_error' });
    expect((await pool.query<{ error_detail: string }>('SELECT error_detail FROM runs WHERE id = $1', [e2.id])).rows[0]!.error_detail).toBe('browser_disabled');
    const dc = await runOf(await insertApi('zz_test_dc_missing', { execution: 'fetch', network: 'dc_proxy', spec: contactsSpecInput(base, API_HOST) }));
    expect(dc).toMatchObject({ state: 'failed', failure_class: 'code_error' });
    expect((await pool.query<{ error_detail: string }>('SELECT error_detail FROM runs WHERE id = $1', [dc.id])).rows[0]!.error_detail).toBe('proxy_not_configured');
    expect(dc.attempts[0]).toMatchObject({ network: 'dc_proxy', result: 'code_error' });
  });

  test('RGPD (D-28) : items extraits inscrits à ctx.personal ; sujet effacé exclu avant écriture du dataset (exécuteur réel)', async () => {
    const SCHEMA = {
      ...SCHEMA_CONTACT,
      properties: { ...SCHEMA_CONTACT.properties, name: { type: 'string', 'x-personal': true }, email: { type: 'string', 'x-personal': 'identifier' } },
    };
    const base = `http://${API_HOST}:${client.server.port}`;
    const apiId = await insertApi('zz_test_rgpd', { execution: 'fetch', network: 'direct', spec: contactsSpecInput(base, API_HOST, 50) }, { outputSchema: SCHEMA });
    const first = await runOf(apiId);
    expect(first).toMatchObject({ state: 'succeeded', items: 500 });
    // Noms et e-mails des 500 items : tous inscrits au registre de masquage du run.
    expect(lastPersonalSize).toBeGreaterThanOrEqual(500);
    const target = (await pool.query<{ item: { email: string } }>('SELECT item FROM dataset_items WHERE dataset_id = $1 AND seq = 7', [first.dataset_id])).rows[0]!.item;
    const keyring = { current: MasterKey.parse(masterKeyText) };
    const subjectKey = await loadSubjectKey(pool, keyring, await keyCheck(pool, keyring));
    const req = { values: await resolveSubjectValues(pool, { datasetId: first.dataset_id!, seq: 7 }), key: subjectKey, actor: { userId: A, via: 'ui' as const }, scope: { ownerId: A } };
    const dry = await eraseSubject(pool, req, { dryRun: true });
    await eraseSubject(pool, req, { confirm: dry.plan.confirmation });

    const second = await runOf(apiId);
    expect(second).toMatchObject({ state: 'succeeded', items: 499 });
    const emails = (await withActor(pool, actorA, (tx) => tx.query<{ email: string }>("SELECT item->>'email' AS email FROM dataset_items WHERE dataset_id = $1", [second.dataset_id]))).rows.map((r) => r.email);
    expect(emails).toHaveLength(499);
    expect(emails).not.toContain(target.email);
    const logs = await pool.query<{ event: string }>("SELECT event FROM run_logs WHERE run_id = $1 AND event = 'subjects_excluded'", [second.id]);
    expect(logs.rowCount).toBe(1);
  });

  test('assert_domain_lock_redirects (E1 de bout en bout) : redirection hors des domaines de l’API → code_error domain_not_allowed, 0 requête vers l’hôte', async () => {
    const SSRF_HOST = 'zz_test_ssrf.localhost';
    const base = `http://${SSRF_HOST}:${client.server.port}`;
    await client.reset();
    const spec = {
      schema_version: 1,
      kind: 'declarative',
      request: { method: 'GET', url: `${base}/to-internal`, allowed_hosts: [SSRF_HOST] },
      sources: [{ id: 'api', from: 'response', records: '$' }],
      fields: { id: { path: '$.id', type: 'string', required: true } },
    };
    const run = await runOf(await insertApi('zz_test_redirect_out', { execution: 'fetch', network: 'direct', spec }));
    expect(run).toMatchObject({ state: 'failed', failure_class: 'code_error', retryable: false });
    expect((await pool.query<{ error_detail: string }>('SELECT error_detail FROM runs WHERE id = $1', [run.id])).rows[0]!.error_detail).toBe('domain_not_allowed');
    expect((await client.stats()).hosts['zz_test_internal.localhost']?.total ?? 0).toBe(0);
  });

  test('version de stratégie invalide (spec hors format) → code_error, jamais un succès', async () => {
    const run = await runOf(await insertApi('zz_test_bad_spec', { execution: 'fetch', network: 'direct', spec: { kind: 'declarative' } }));
    expect(run).toMatchObject({ state: 'failed', failure_class: 'code_error' });
  });
});
