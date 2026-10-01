// SPDX-License-Identifier: AGPL-3.0-only
// assert_scraped_data_not_translated (tâche 3.20, 21b M7, renfort d'INV1) : la même fixture, la même API (partagée, visibilité
// instance) et deux utilisateurs, l'un en `fr`, l'autre en `en` : les items collectés sont identiques octet pour octet. Aucune
// étape de traduction dans le pipeline ; `runs.locale` (langue de la prose du LLM) est enregistrée sans toucher aux données.
import { randomUUID } from 'node:crypto';
import { DomainPacer, generateMasterKey, MasterKey } from '@runtime/core';
import * as net from '@runtime/core/net';
import { createRun, keyCheck, migrateUp, PgBossJobQueue, PgPacingStore, readRun, runQueueDefinition, withActor } from '@runtime/db';
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
const ALICE = randomUUID();
const BOB = randomUUID();
const asAlice = { userId: ALICE, role: 'member' as const };
const asBob = { userId: BOB, role: 'member' as const };

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let client: Client;
let worker: Worker;
let apiId: string;

beforeAll(async () => {
  client = await startClient();
  tdb = await createTestDatabase('i18n_data');
  await migrateUp({ connectionString: tdb.url });
  const masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: tdb.url, max: 6 });
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  await pool.query("INSERT INTO users (id, email, status, locale) VALUES ($1, 'zz_test_alice_i18n@example.test', 'active', 'fr'), ($2, 'zz_test_bob_i18n@example.test', 'active', 'en')", [ALICE, BOB]);
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  const guard = fixtureGuard(client.server.port, [API_HOST], net);
  worker = await startWorker({
    config: loadWorkerConfig({ DATABASE_URL: tdb.url, MASTER_KEY: masterKey, QUEUE_POLLING_SECONDS: '0.5', RUN_HEARTBEAT_SECONDS: '0.5', RUN_STALE_SECONDS: '5', BROWSER_CONCURRENCY: '1' }),
    executor: createStrategyExecutor({ pool, guard, pacer: new DomainPacer(new PgPacingStore(pool)), browsers: null }),
    logger: pino({ level: 'silent' }),
  });
  const base = `http://${API_HOST}:${client.server.port}`;
  apiId = (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, visibility, output_schema, domain_pacing) VALUES ('zz_test_shared_i18n', $1, 'instance', $2, '{"min_delay_ms": 5, "max_requests_per_run": 200, "max_wait_ms": 60000}') RETURNING id`,
      [ALICE, JSON.stringify(SCHEMA_CONTACT)],
    )
  ).rows[0]!.id;
  await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, est_cost_usd, created_by) VALUES ($1, 1, $2, 'fetch', 'direct', $3, 0, 'user')", [apiId, ALICE, JSON.stringify(contactsSpecInput(base, API_HOST, 50))]);
  await pool.query('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [apiId]);
}, 180_000);

afterAll(async () => {
  await worker?.stop();
  await queue?.stop({ timeoutMs: 1000 });
  await pool?.end();
  await tdb?.drop();
  await client?.close();
});

async function runAs(actor: { userId: string; role: 'member' }): Promise<{ datasetId: string; items: string[]; locale: string }> {
  const { runId } = await withActor(pool, actor, (tx) => createRun(tx, queue, { apiId, ownerId: actor.userId, trigger: 'rest' }));
  await vi.waitFor(async () => expect(['succeeded', 'failed']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), { timeout: 30_000, interval: 100 });
  const run = (await withActor(pool, actor, (tx) => readRun(tx, runId)))!;
  expect(run).toMatchObject({ state: 'succeeded', outcome: 'clean', items: 500 });
  const rows = await withActor(pool, actor, (tx) => tx.query<{ item: string }>('SELECT item::text AS item FROM dataset_items WHERE dataset_id = $1 ORDER BY seq', [run.dataset_id]));
  const locale = (await pool.query<{ locale: string }>('SELECT locale FROM runs WHERE id = $1', [runId])).rows[0]!.locale;
  return { datasetId: run.dataset_id!, items: rows.rows.map((r) => r.item), locale };
}

describe('M7 : les données collectées ne se traduisent pas', () => {
  test('assert_scraped_data_not_translated : même fixture, même API, un utilisateur fr et un en : items identiques octet pour octet', async () => {
    const fr = await runAs(asAlice);
    const en = await runAs(asBob);
    expect(fr.locale).toBe('fr');
    expect(en.locale).toBe('en');
    expect(fr.datasetId).not.toBe(en.datasetId);
    expect(fr.items).toHaveLength(500);
    expect(Buffer.from(fr.items.join('\n'), 'utf8').equals(Buffer.from(en.items.join('\n'), 'utf8'))).toBe(true);
    // Rien du contenu n'a été remplacé par un texte du catalogue (aucune étape de traduction).
    expect(fr.items.join('')).not.toMatch(/\[object|undefined/);
  }, 90_000);
});
