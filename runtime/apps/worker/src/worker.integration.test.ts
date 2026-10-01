// SPDX-License-Identifier: AGPL-3.0-only
// Worker de bout en bout sur base réelle (tâche 1.3, INV4, D-12) : run tracé du web au worker (assert_run_traced),
// clé différente → arrêt avant tout run (assert_worker_key_mismatch), `kill -9` d'un vrai processus en plein run →
// run repris ou `failed`, jamais bloqué en `running`, SIGTERM → fin sous le délai ou remise en file.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { generateMasterKey, MasterKey, RUN_QUEUE, type RunExecutor } from '@runtime/core';
import {
  createRun,
  ensureDatasetItemsPartitions,
  eraseSubject,
  keyCheck,
  KeyCheckError,
  loadSubjectKey,
  migrateUp,
  PgBossJobQueue,
  readRun,
  rekey,
  resolveSubjectValues,
  runQueueDefinition,
  withActor,
} from '@runtime/db';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { loadWorkerConfig } from './config.js';
import { startWorker, unavailableExecutor, type Worker } from './worker.js';

const CHILD = new URL('../dist/testing/child.testkit.js', import.meta.url).pathname;
const silent = pino({ level: 'silent' });

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let masterKey: string;
const A = randomUUID();
const actorA = { userId: A, role: 'member' as const };
let readApi: string;
let writeApi: string;
const workers: Worker[] = [];
const children: ChildProcess[] = [];

/** Réglages courts pour les tests (défauts de production : 10 s, 30 s, 60 s, 30 s). */
const fastEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  DATABASE_URL: tdb.url,
  MASTER_KEY: masterKey,
  RUN_HEARTBEAT_SECONDS: '0.5',
  RUN_STALE_SECONDS: '2',
  SWEEP_INTERVAL_SECONDS: '0.5',
  WORKER_HEARTBEAT_SECONDS: '0.5',
  QUEUE_POLLING_SECONDS: '0.5',
  SHUTDOWN_TIMEOUT_SECONDS: '1',
  ...extra,
});

async function inProcessWorker(executor: RunExecutor, extra: Record<string, string> = {}): Promise<Worker> {
  const worker = await startWorker({ config: loadWorkerConfig(fastEnv(extra)), executor, logger: silent });
  workers.push(worker);
  return worker;
}

/** Lance un vrai processus worker (main de production, exécuteur qui attend l'interruption) ; attend qu'il prenne `runId`. */
async function childWorker(runId: string): Promise<{ child: ChildProcess; workerId: string }> {
  const child = spawn(process.execPath, [CHILD], {
    env: { PATH: process.env['PATH'], ...fastEnv({ EXECUTOR: 'hang' }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const stderr: string[] = [];
  child.stderr!.on('data', (d: Buffer) => stderr.push(d.toString()));
  const lines = createInterface({ input: child.stdout! });
  let workerId = '';
  let claimed = false;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker enfant : run non pris en 30 s\n${stderr.join('')}`)), 30_000);
    lines.on('line', (line) => {
      if (line === `claimed ${runId}`) claimed = true;
      if (line.startsWith('ready ')) workerId = line.slice('ready '.length);
      if (claimed && workerId) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => reject(new Error(`worker enfant sorti (code ${code})\n${stderr.join('')}`)));
  });
  return { child, workerId };
}

const exited = (child: ChildProcess) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
    else child.once('exit', (code, signal) => resolve({ code, signal }));
  });

const create = (apiId = readApi) => withActor(pool, actorA, (tx) => createRun(tx, queue, { apiId, ownerId: A, trigger: 'rest' }));
const runRow = async (runId: string) =>
  (
    await pool.query<{ state: string; job_id: string; requeue_count: number; error_detail: string | null; retryable: boolean | null; worker_id: string | null }>(
      'SELECT state, job_id, requeue_count, error_detail, retryable, worker_id FROM runs WHERE id = $1',
      [runId],
    )
  ).rows[0]!;
const waitState = (runId: string, states: string[], timeout = 20_000) =>
  vi.waitFor(async () => expect(states).toContain((await runRow(runId)).state), { timeout, interval: 100 });

beforeAll(async () => {
  tdb = await createTestDatabase('worker');
  await migrateUp({ connectionString: tdb.url });
  masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: tdb.url, max: 4 });
  await keyCheck(pool, { current: MasterKey.parse(masterKey) }); // témoin créé avec la clé de l'instance
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_w@example.test', 'active')", [A]);
  readApi = (await pool.query<{ id: string }>("INSERT INTO apis (slug, owner_id) VALUES ('zz_test_read', $1) RETURNING id", [A])).rows[0]!.id;
  writeApi = (
    await pool.query<{ id: string }>("INSERT INTO apis (slug, owner_id, allow_write_actions) VALUES ('zz_test_write', $1, true) RETURNING id", [A])
  ).rows[0]!.id;
  await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, created_by) VALUES ($1, 2, $2, 'fetch', 'direct', 'user')", [readApi, A]);
  await pool.query('UPDATE apis SET current_strategy_version = 2 WHERE id = $1', [readApi]);
  // Côté web : une file pg-boss sans supervision, pour mettre les runs en file.
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
});

beforeEach(async () => {
  for (const w of workers.splice(0)) await w.stop();
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
});

afterAll(async () => {
  for (const w of workers.splice(0)) await w.stop();
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  await queue?.stop({ timeoutMs: 1000 });
  await pool?.end();
  await tdb?.drop();
});

test('assert_run_traced : un run qui essaie 3 couples a sa version de stratégie, 3 run_attempts complets, coût = somme des essais', async () => {
  const executor: RunExecutor = async (ctx) => {
    await ctx.recordAttempt({ execution: 'fetch', network: 'direct', est_cost_usd: 0, result: 'extraction', ms: 110 });
    await ctx.recordAttempt({ execution: 'fetch', network: 'dc_proxy', est_cost_usd: 0.0004, result: 'network', ms: 250, proxy_usd: 0.0002 });
    await ctx.recordAttempt({
      execution: 'agent_fetch',
      network: 'direct',
      est_cost_usd: 0.03,
      result: 'ok',
      ms: 1900,
      llm_usd: 0.0215,
      tokens: { in: 900, cached: 100, out: 250, reasoning: 40 },
      model_id: 'zz_test_model',
      prompt_version: 'p1',
    });
    return { state: 'succeeded', outcome: 'degraded', degraded_reasons: ['escalated'], items: 12 };
  };
  await inProcessWorker(executor);
  const { runId } = await create();
  await waitState(runId, ['succeeded']);
  const run = (await withActor(pool, actorA, (tx) => readRun(tx, runId)))!;
  expect(run.strategy_version).toBe(2);
  expect(run.attempts).toHaveLength(3);
  for (const a of run.attempts) {
    expect(a).toEqual(expect.objectContaining({ execution: expect.any(String), network: expect.any(String), result: expect.any(String), cost_usd: expect.any(Number), ms: expect.any(Number) }));
  }
  expect(run.attempts.map((a) => a.result)).toEqual(['extraction', 'network', 'ok']);
  const sum = run.attempts.reduce((s, a) => s + a.cost_usd, 0);
  expect(run.cost.total_usd).toBeCloseTo(sum, 6);
  expect(run.cost).toEqual({ llm_usd: 0.0215, proxy_usd: 0.0002, total_usd: 0.0217 });
  expect(run.tokens).toEqual({ in: 900, cached: 100, out: 250, reasoning: 40, estimated: false });
  expect(run).toMatchObject({ state: 'succeeded', outcome: 'degraded', degraded_reasons: ['escalated'], items: 12, failure_class: null });
});

test('assert_worker_key_mismatch : un worker avec une autre MASTER_KEY s’arrête avant tout run (D-12)', async () => {
  const { runId, jobId } = await create();
  const other = generateMasterKey();
  const config = loadWorkerConfig(fastEnv({ MASTER_KEY: other }));
  await expect(startWorker({ config, executor: async () => ({ state: 'succeeded', outcome: 'clean', items: 0 }), logger: silent })).rejects.toBeInstanceOf(
    KeyCheckError,
  );
  // Processus réel : `main` refuse de démarrer (code 2) sans divulguer la clé.
  const child = spawn(process.execPath, [CHILD], { env: { PATH: process.env['PATH'], ...fastEnv({ MASTER_KEY: other }) }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
  expect(await exited(child)).toEqual({ code: 2, signal: null });
  expect(out).toMatch(/Refus de démarrer le worker : MASTER_KEY ne correspond pas/);
  expect(out).not.toContain(other);
  expect(out).not.toMatch(/claimed|ready/);
  // Aucun run touché, aucun job pris, aucun worker inscrit.
  expect(await runRow(runId)).toMatchObject({ state: 'queued', job_id: jobId, worker_id: null });
  expect(await queue.jobState(RUN_QUEUE, jobId)).toBe('created');
  expect((await pool.query('SELECT 1 FROM worker_heartbeats')).rowCount).toBe(0);
  // Nettoyage : ce run ne doit pas polluer les tests suivants.
  await pool.query("UPDATE runs SET state = 'cancelled' WHERE id = $1", [runId]);
  await queue.cancel(RUN_QUEUE, jobId);
});

describe('kill -9 en plein run (vrai processus)', () => {
  test('API en lecture : run repris par un autre worker puis `succeeded`, jamais bloqué en `running`', async () => {
    const { runId, jobId } = await create();
    const { child } = await childWorker(runId);
    expect(await runRow(runId)).toMatchObject({ state: 'running', job_id: jobId });
    const killedAt = Date.now();
    child.kill('SIGKILL');
    expect((await exited(child)).signal).toBe('SIGKILL');
    // Un second worker (balayeur + exécution) reprend le run.
    await inProcessWorker(async (ctx) => {
      await ctx.recordAttempt({ execution: 'fetch', network: 'direct', est_cost_usd: 0, result: 'ok', ms: 3 });
      return { state: 'succeeded', outcome: 'clean', items: 2 };
    });
    await waitState(runId, ['queued', 'succeeded']);
    // Borne T2 R4 : plus `running` en moins de 2 × battement + période du balayeur (+ marge de charge).
    expect(Date.now() - killedAt).toBeLessThan((2 * 2 + 0.5 + 10) * 1000);
    await waitState(runId, ['succeeded']);
    const row = await runRow(runId);
    expect(row.requeue_count).toBe(1);
    expect(row.job_id).not.toBe(jobId);
    const run = (await withActor(pool, actorA, (tx) => readRun(tx, runId)))!;
    expect(run.attempts).toHaveLength(2); // l'essai du worker tué reste tracé
  });

  test('API qui écrit : run `failed` (worker_lost, non relançable), jamais rejoué', async () => {
    const { runId } = await create(writeApi);
    const { child } = await childWorker(runId);
    child.kill('SIGKILL');
    await exited(child);
    let executed = false;
    await inProcessWorker(async () => {
      executed = true;
      return { state: 'succeeded', outcome: 'clean', items: 0 };
    });
    await waitState(runId, ['failed']);
    expect(await runRow(runId)).toMatchObject({ state: 'failed', error_detail: 'worker_lost', retryable: false, requeue_count: 0 });
    expect(executed).toBe(false);
  });
});

describe('SIGTERM', () => {
  test('run non fini sous SHUTDOWN_TIMEOUT_SECONDS : remis en file, sortie 0, worker désinscrit, puis repris ailleurs', async () => {
    const { runId, jobId } = await create();
    const { child, workerId } = await childWorker(runId);
    const beats = (id: string) => pool.query('SELECT 1 FROM worker_heartbeats WHERE worker_id = $1', [id]).then((r) => r.rowCount);
    expect(await beats(workerId)).toBe(1);
    child.kill('SIGTERM');
    expect(await exited(child)).toEqual({ code: 0, signal: null });
    const row = await runRow(runId);
    expect(row).toMatchObject({ state: 'queued', requeue_count: 0, worker_id: null });
    expect(row.job_id).not.toBe(jobId);
    expect(await beats(workerId)).toBe(0);
    await inProcessWorker(async () => ({ state: 'succeeded', outcome: 'clean', items: 1 }));
    await waitState(runId, ['succeeded']);
  });

  test('run fini sous le délai : l’arrêt attend sa fin, `succeeded`, aucune nouvelle prise pendant l’arrêt', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const worker = await inProcessWorker(
      async () => {
        started();
        await gate;
        return { state: 'succeeded', outcome: 'clean', items: 3 };
      },
      { SHUTDOWN_TIMEOUT_SECONDS: '20' },
    );
    const { runId } = await create();
    await running;
    const stopping = worker.stop();
    await vi.waitFor(async () =>
      expect((await pool.query<{ draining: boolean }>('SELECT draining FROM worker_heartbeats WHERE worker_id = $1', [worker.workerId])).rows[0]?.draining).toBe(true),
    );
    const late = await create(); // arrive pendant l'arrêt : pas pris par ce worker
    release();
    await stopping;
    expect((await runRow(runId)).state).toBe('succeeded');
    expect(await runRow(late.runId)).toMatchObject({ state: 'queued', worker_id: null });
    await pool.query("UPDATE runs SET state = 'cancelled' WHERE id = $1", [late.runId]);
    await queue.cancel(RUN_QUEUE, late.jobId);
  });
});

test('exception de l’exécuteur : run `failed` (code_error, message masqué), jamais laissé `running`', async () => {
  await inProcessWorker(async () => {
    throw new Error('zz_test boom');
  });
  const { runId } = await create();
  await waitState(runId, ['failed']);
  expect(await runRow(runId)).toMatchObject({ error_detail: 'Error: zz_test boom', retryable: false });
  expect((await withActor(pool, actorA, (tx) => readRun(tx, runId)))?.failure_class).toBe('code_error');
});

test('exécuteur par défaut (avant la tâche 1.6) : run `failed` executor_unavailable', async () => {
  const worker = await startWorker({ config: loadWorkerConfig(fastEnv()), logger: silent });
  workers.push(worker);
  const { runId } = await create();
  await waitState(runId, ['failed']);
  expect(await runRow(runId)).toMatchObject({ error_detail: 'executor_unavailable', retryable: false });
});

describe('RGPD câblé dans un run réel (tâche 1.8, revue : points 2, 7, 8, 9, 18 ; D-25)', () => {
  const SCHEMA = {
    type: 'object',
    properties: { email: { type: 'string', 'x-personal': 'identifier' }, name: { type: 'string', 'x-personal': true }, title: { type: 'string' } },
  };
  const ALICE = { email: 'alice.worker@example.test', name: 'Alice Lefebvre', title: 'fiche' };
  const BOB = { email: 'bob.worker@example.test', name: 'Bob Marchetti', title: 'fiche' };

  test('assert_erasure_survives_rekey : erase_subject, rekey complet, puis un run réel exclut toujours le sujet ; error_detail masqué par le registre du run', async () => {
    const db2 = await createTestDatabase('workerrk');
    const p2 = new pg.Pool({ connectionString: db2.url, max: 4 });
    const q2 = new PgBossJobQueue({ connectionString: db2.url, max: 2, supervise: false });
    let worker: Worker | undefined;
    try {
      await migrateUp({ connectionString: db2.url });
      const oldKey = MasterKey.parse(generateMasterKey());
      const newKey = generateMasterKey();
      const subjectKey = await loadSubjectKey(p2, { current: oldKey }, await keyCheck(p2, { current: oldKey }));
      const owner = randomUUID();
      await p2.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_wrk@example.test', 'active')", [owner]);
      const api = (await p2.query<{ id: string }>("INSERT INTO apis (slug, owner_id, output_schema) VALUES ('zz_test_rk', $1, $2::jsonb) RETURNING id", [owner, JSON.stringify(SCHEMA)])).rows[0]!.id;
      await ensureDatasetItemsPartitions(p2, new Date());
      const ds = (await p2.query<{ id: string }>('INSERT INTO datasets (api_id, owner_id) VALUES ($1, $2) RETURNING id', [api, owner])).rows[0]!.id;
      await p2.query('INSERT INTO dataset_items (created_at, dataset_id, seq, owner_id, item, size_bytes) VALUES (now(), $1, 1, $2, $3::jsonb, 10)', [ds, owner, JSON.stringify(ALICE)]);
      const req = { values: await resolveSubjectValues(p2, { datasetId: ds, seq: 1 }), key: subjectKey, actor: { userId: owner, via: 'ui' as const }, scope: { ownerId: owner } };
      const dry = await eraseSubject(p2, req, { dryRun: true });
      await eraseSubject(p2, req, { confirm: dry.plan.confirmation });

      const client = await p2.connect();
      try {
        expect(await rekey(client, { current: MasterKey.parse(newKey), previous: oldKey })).toMatchObject({ status: 'done' });
      } finally {
        client.release();
      }

      let seen: { kept: unknown[]; dropped: number } | undefined;
      let registrySize = -1;
      const executor: RunExecutor = async (ctx) => {
        seen = ctx.excludeSubjects(SCHEMA, [ALICE, BOB]);
        for (const item of seen.kept) ctx.personal.addFromItem(SCHEMA, item);
        registrySize = ctx.personal.size;
        return { state: 'failed', failure_class: 'extraction', retryable: false, error_detail: `validation échouée pour ${BOB.name}` };
      };
      worker = await startWorker({ config: loadWorkerConfig(fastEnv({ DATABASE_URL: db2.url, MASTER_KEY: newKey })), executor, logger: silent });
      await q2.start();
      await q2.createQueue(runQueueDefinition());
      const { runId } = await withActor(p2, { userId: owner, role: 'member' }, (tx) => createRun(tx, q2, { apiId: api, ownerId: owner, trigger: 'rest' }));
      await vi.waitFor(
        async () => expect((await p2.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state).toBe('failed'),
        { timeout: 20_000, interval: 100 },
      );
      expect(seen).toEqual({ kept: [BOB], dropped: 1 });
      expect(registrySize).toBe(2);
      const detail = (await p2.query<{ error_detail: string }>('SELECT error_detail FROM runs WHERE id = $1', [runId])).rows[0]!.error_detail;
      expect(detail).toBe('validation échouée pour [PERSONAL]');
    } finally {
      await worker?.stop();
      await q2.stop({ timeoutMs: 1000 }).catch(() => undefined);
      await p2.end();
      await db2.drop();
    }
  });

  test('la purge est planifiée par le worker : passe de rétention journalisée sans appel manuel', async () => {
    await inProcessWorker(unavailableExecutor, { RETENTION_TICK_SECONDS: '0.5' });
    await vi.waitFor(
      async () => expect((await pool.query("SELECT 1 FROM audit_events WHERE action = 'retention.purge'")).rowCount).toBeGreaterThan(0),
      { timeout: 15_000, interval: 200 },
    );
    expect((await pool.query("SELECT value FROM settings WHERE key = 'retention_state'")).rows[0]!.value).toHaveProperty('daily_at');
  });
});
