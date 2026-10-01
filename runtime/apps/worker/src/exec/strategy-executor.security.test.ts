// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.6 de bout en bout, étage S (Chromium réel) sur base réelle : run mis en file → worker (1.3) → `RunExecutor`
// de production (`createStrategyExecutor`) avec un vrai pool Chromium et le bac à sable de 1.5. Exercé ici, et nulle part
// ailleurs : `scriptSpecOf`, `loadInlineScript`, l'egress de l'essai et son coût (barreau dc_proxy chaîné au proxy BYO),
// `addUsage`, la validation `output_schema` des sorties navigateur, le RGPD (registre du run, `ctx.log` du script écrit
// dans `run_logs` et masqué, jamais dans le journal du worker), le dataset écrit comme le propriétaire, l'essai tracé.
// PostgreSQL : un conteneur propre à ce fichier (le job security n'a pas le globalSetup du projet integration).
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DomainPacer, generateMasterKey, MasterKey, validateOutput } from '@runtime/core';
import * as net from '@runtime/core/net';
import { createRun, keyCheck, migrateUp, PgBossJobQueue, PgPacingStore, readRun, runQueueDefinition, withActor } from '@runtime/db';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { BrowserPool, playwrightLauncher } from '../browser/pool.js';
import { loadWorkerConfig } from '../config.js';
import { loadInlineScript } from './script-executor.js';
import { createStrategyExecutor } from './strategy-executor.js';
import { ProcessSandboxEngine, sandboxOptionsFromEnv } from '../sandbox/engine.js';
import { startWorker, type Worker } from '../worker.js';
import { startClient, type Client } from '../../../../fixtures/src/test-helpers.ts';
import { fixtureGuard, SCHEMA_PRODUCT, spaApiSpecInput } from '../../../../tests/helpers/fixture-net.ts';
import { startConnectProxy, type UpstreamTestProxy } from '../../../../tests/helpers/upstream-proxies.ts';

const SPA = 'zz_test_spa.localhost';
const PERSONAL = 'zz_test_personal.localhost';
const A = randomUUID();
const actorA = { userId: A, role: 'member' as const };
const SCHEMA_PERSON = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['name', 'email'],
  properties: { name: { type: 'string', 'x-personal': true }, email: { type: 'string', 'x-personal': 'identifier' } },
  additionalProperties: false,
};

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let client: Client;
let worker: Worker;
let browsers: BrowserPool;
let launchProxy: net.EgressProxy;
let proxy: UpstreamTestProxy;
/** Sortie brute du journal du worker (pino) pendant tout le fichier. */
const workerLog: string[] = [];

async function insertApi(slug: string, strategy: { execution: string; network: string; spec: unknown; scriptRef?: string }, outputSchema: unknown, networkPolicy: unknown = null): Promise<string> {
  const id = (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, output_schema, network_policy, domain_pacing) VALUES ($1, $2, $3, $4, '{"min_delay_ms": 5, "max_requests_per_run": 200, "max_wait_ms": 60000}') RETURNING id`,
      [slug, A, JSON.stringify(outputSchema), JSON.stringify(networkPolicy ?? { allow: ['direct'] })],
    )
  ).rows[0]!.id;
  await pool.query(
    "INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, script_ref, est_cost_usd, created_by) VALUES ($1, 1, $2, $3, $4, $5, $6, 0, 'user')",
    [id, A, strategy.execution, strategy.network, JSON.stringify(strategy.spec), strategy.scriptRef ?? null],
  );
  await pool.query('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [id]);
  return id;
}

const runOf = async (apiId: string) => {
  const { runId } = await withActor(pool, actorA, (tx) => createRun(tx, queue, { apiId, ownerId: A, trigger: 'rest' }));
  await vi.waitFor(async () => expect(['succeeded', 'failed']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), {
    timeout: 60_000,
    interval: 200,
  });
  return (await withActor(pool, actorA, (tx) => readRun(tx, runId)))!;
};

beforeAll(async () => {
  container = await new PostgreSqlContainer(`postgres:${process.env.PG_VERSION ?? '16'}`).start();
  const url = container.getConnectionUri();
  await migrateUp({ connectionString: url });
  const masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: url, max: 6 });
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_exec_s@example.test', 'active')", [A]);
  queue = new PgBossJobQueue({ connectionString: url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  client = await startClient();
  proxy = await startConnectProxy();
  // Proxy BYO de l'admin (sans identifiants) : barreau dc_proxy, prix à la requête et au Go.
  await pool.query("INSERT INTO settings (key, value) VALUES ('proxies', $1)", [
    JSON.stringify([{ id: 'zz_test_dc', type: 'dc', url: proxy.url, allow_private_address: true, price: { per_gb_usd: 5, per_request_usd: 0.0001 } }]),
  ]);
  const guard = fixtureGuard(client.server.port, [SPA, PERSONAL], net);
  launchProxy = await net.startEgressProxy({ guard, refuseAll: true });
  browsers = new BrowserPool({ size: 1, launch: playwrightLauncher(launchProxy.url, process.env), recycleAfterRuns: 100 });
  const engine = new ProcessSandboxEngine({ ...sandboxOptionsFromEnv(process.env), production: false });
  const logger = pino({ level: 'trace' }, { write: (line: string) => void workerLog.push(line) });
  const executor = createStrategyExecutor({
    pool,
    guard,
    pacer: new DomainPacer(new PgPacingStore(pool)),
    browsers,
    logger,
    script: { engine, loadScript: loadInlineScript, limits: { timeoutMs: 20_000, memoryMb: 128 } },
  });
  worker = await startWorker({
    config: loadWorkerConfig({ DATABASE_URL: url, MASTER_KEY: masterKey, QUEUE_POLLING_SECONDS: '0.5', RUN_HEARTBEAT_SECONDS: '0.5', RUN_STALE_SECONDS: '10', BROWSER_CONCURRENCY: '1' }),
    executor,
    logger,
  });
}, 240_000);

afterAll(async () => {
  await worker?.stop();
  await queue?.stop({ timeoutMs: 1000 });
  await browsers?.close();
  await launchProxy?.close();
  await proxy?.close();
  await pool?.end();
  await client?.close();
  await container?.stop();
}, 120_000);

describe('RunExecutor de production, Chromium réel (E2, E3 en script)', () => {
  test('E3 en script (inline, bac à sable) sur l’annuaire factice : dataset conforme, essai tracé, ctx.log dans run_logs masqué, rien dans le journal du worker', async () => {
    const source = `
      const names = await ctx.page.textAll('tr.person td.name');
      const emails = await ctx.page.textAll('tr.person td.email');
      ctx.log('premier contact', names[0], emails[0]);
      names.forEach((n, i) => ctx.emit({ name: n, email: emails[i] }));`;
    const apiId = await insertApi(
      'zz_test_e3_script',
      { execution: 'playwright', network: 'direct', scriptRef: 'inline', spec: { kind: 'script', allowed_hosts: [PERSONAL], start_url: `http://${PERSONAL}:${client.server.port}/`, source } },
      SCHEMA_PERSON,
    );
    const run = await runOf(apiId);
    expect(run).toMatchObject({ state: 'succeeded', outcome: 'clean', items: 10, strategy_version: 1 });
    expect(run.attempts).toEqual([expect.objectContaining({ execution: 'playwright', network: 'direct', result: 'ok', cost_usd: 0 })]);
    const items = await withActor(pool, actorA, (tx) => tx.query<{ item: unknown }>('SELECT item FROM dataset_items WHERE dataset_id = $1 ORDER BY seq', [run.dataset_id]));
    expect(items.rows).toHaveLength(10);
    for (const r of items.rows) expect(validateOutput(SCHEMA_PERSON, r.item)).toEqual({ ok: true });
    // Journal du script : écrit dans run_logs (masqué par le registre du run et les motifs), jamais en clair.
    const logs = await pool.query<{ data: { args: string[] } }>("SELECT data FROM run_logs WHERE run_id = $1 AND event = 'sandbox_log'", [run.id]);
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]!.data.args[0]).toBe('premier contact');
    const runLogText = JSON.stringify(logs.rows);
    const workerText = workerLog.join('\n');
    for (const motif of ['zz_test_person_001', 'example.invalid', 'Zztest001']) {
      expect(runLogText).not.toContain(motif);
      expect(workerText).not.toContain(motif);
    }
    expect(runLogText).toContain('[PERSONAL]');
  }, 120_000);

  test('E2 fetch_in_page par le proxy BYO (dc_proxy) : 30 produits conformes, coût proxy imputé à l’essai', async () => {
    proxy.log.length = 0;
    const base = `http://${SPA}:${client.server.port}`;
    const apiId = await insertApi('zz_test_e2_dc', { execution: 'fetch_in_page', network: 'dc_proxy', spec: spaApiSpecInput(base, SPA) }, SCHEMA_PRODUCT, { allow: ['direct', 'dc_proxy'] });
    const run = await runOf(apiId);
    expect(run).toMatchObject({ state: 'succeeded', items: 30, strategy_version: 1 });
    expect(run.attempts).toHaveLength(1);
    expect(run.attempts[0]).toMatchObject({ execution: 'fetch_in_page', network: 'dc_proxy', result: 'ok' });
    expect(run.attempts[0]!.cost_usd).toBeGreaterThan(0);
    expect(proxy.log.length).toBeGreaterThan(0);
    const items = await withActor(pool, actorA, (tx) => tx.query<{ item: unknown }>('SELECT item FROM dataset_items WHERE dataset_id = $1', [run.dataset_id]));
    expect(items.rows).toHaveLength(30);
    for (const r of items.rows) expect(validateOutput(SCHEMA_PRODUCT, r.item)).toEqual({ ok: true });
  }, 120_000);

  test('E3 en script hors format (start_url hors des domaines) → code_error invalid_script_spec, essai tracé', async () => {
    const apiId = await insertApi(
      'zz_test_e3_bad',
      { execution: 'playwright', network: 'direct', scriptRef: 'inline', spec: { kind: 'script', allowed_hosts: [PERSONAL], start_url: `http://${SPA}:${client.server.port}/`, source: 'ctx.emit({})' } },
      SCHEMA_PERSON,
    );
    const run = await runOf(apiId);
    expect(run).toMatchObject({ state: 'failed', failure_class: 'code_error', items: 0, dataset_id: null });
    expect((await pool.query<{ error_detail: string }>('SELECT error_detail FROM runs WHERE id = $1', [run.id])).rows[0]!.error_detail).toBe('invalid_script_spec');
    expect(run.attempts[0]).toMatchObject({ execution: 'playwright', result: 'code_error' });
  }, 120_000);
});
