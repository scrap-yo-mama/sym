// SPDX-License-Identifier: AGPL-3.0-only
// File et cycle de vie des runs sur base réelle (tâche 1.3, INV4, T2 R2/R4/R5) : run et job dans la même transaction,
// RLS côté web, jeton de clôture `job_id`, balayeur (reprise ou `failed`), annulation, `skipped_*`, coûts et jetons,
// bail de réparation. Le processus worker (kill -9, SIGTERM, D-12) est testé dans apps/worker.
import { randomUUID } from 'node:crypto';
import { RUN_QUEUE, RUN_STATES, type AttemptRecord } from '@runtime/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { migrateUp } from './migrate.js';
import { PgBossJobQueue } from './queue.js';
import { withActor } from './rls.js';
import {
  acquireRepairLease,
  cancelRun,
  chargeRunCost,
  claimRun,
  createRun,
  finishRun,
  heartbeatRun,
  pauseRun,
  readRun,
  recordAttempt,
  recordSkippedRun,
  releaseRepairLease,
  renewRepairLease,
  requeueRun,
  RunLeaseLostError,
  RunNotFoundError,
  runQueueDefinition,
  sweepOrphans,
} from './runs.js';

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
const A = randomUUID();
const B = randomUUID();
let readApi: string;
let writeApi: string;
const actorA = { userId: A, role: 'member' as const };
const actorB = { userId: B, role: 'member' as const };

beforeAll(async () => {
  tdb = await createTestDatabase('runs');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 4 });
  for (const [id, email] of [[A, 'zz_test_a@example.test'], [B, 'zz_test_b@example.test']]) {
    await pool.query("INSERT INTO users (id, email, status) VALUES ($1, $2, 'active')", [id, email]);
  }
  readApi = (await pool.query<{ id: string }>("INSERT INTO apis (slug, owner_id) VALUES ('zz_test_read', $1) RETURNING id", [A])).rows[0]!.id;
  writeApi = (
    await pool.query<{ id: string }>("INSERT INTO apis (slug, owner_id, allow_write_actions) VALUES ('zz_test_write', $1, true) RETURNING id", [A])
  ).rows[0]!.id;
  await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, created_by) VALUES ($1, 3, $2, 'fetch', 'direct', 'user')", [readApi, A]);
  await pool.query('UPDATE apis SET current_strategy_version = 3 WHERE id = $1', [readApi]);
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
});

afterAll(async () => {
  await queue?.stop({ timeoutMs: 1000 });
  await pool?.end();
  await tdb?.drop();
});

const create = (apiId = readApi) => withActor(pool, actorA, (tx) => createRun(tx, queue, { apiId, ownerId: A, trigger: 'rest', input: { q: 'zz_test' } }));
const row = async (runId: string) =>
  (
    await pool.query<{ state: string; job_id: string; requeue_count: number; failure_class: string | null; retryable: boolean | null; error_detail: string | null }>(
      'SELECT state, job_id, requeue_count, failure_class, retryable, error_detail FROM runs WHERE id = $1',
      [runId],
    )
  ).rows[0];
const makeStale = (runId: string) => pool.query("UPDATE runs SET heartbeat_at = now() - interval '1 hour' WHERE id = $1", [runId]);

describe('création (web, sous withActor)', () => {
  test('run et job sont écrits dans la même transaction : ROLLBACK ne laisse ni l’un ni l’autre', async () => {
    let jobId = '';
    let runId = '';
    await expect(
      withActor(pool, actorA, async (tx) => {
        ({ runId, jobId } = await createRun(tx, queue, { apiId: readApi, ownerId: A, trigger: 'rest' }));
        expect(await queue.jobState(RUN_QUEUE, jobId, { tx })).toBe('created'); // visible dans la transaction
        throw new Error('zz_test rollback');
      }),
    ).rejects.toThrow('zz_test rollback');
    expect(await row(runId)).toBeUndefined();
    expect(await queue.jobState(RUN_QUEUE, jobId)).toBeNull();

    const created = await create();
    expect(await row(created.runId)).toMatchObject({ state: 'queued', job_id: created.jobId, requeue_count: 0 });
    expect(await queue.jobState(RUN_QUEUE, created.jobId)).toBe('created');
  });

  test('RLS : B ne peut lancer un run sur l’API privée de A, ni lire ses runs', async () => {
    await expect(withActor(pool, actorB, (tx) => createRun(tx, queue, { apiId: readApi, ownerId: B, trigger: 'rest' }))).rejects.toBeInstanceOf(RunNotFoundError);
    const { runId } = await create();
    expect(await withActor(pool, actorB, (tx) => readRun(tx, runId))).toBeNull();
    expect(await withActor(pool, actorB, (tx) => cancelRun(tx, queue, runId))).toBe(false);
    expect((await withActor(pool, actorA, (tx) => readRun(tx, runId)))?.state).toBe('queued');
  });

  test('skipped_* : tracé, terminal, sans job', async () => {
    const id = await withActor(pool, actorA, (tx) =>
      recordSkippedRun(tx, { apiId: readApi, ownerId: A, trigger: 'schedule', state: 'skipped_quota', reason: 'budget_daily' }),
    );
    expect(await row(id)).toMatchObject({ state: 'skipped_quota', job_id: null, error_detail: 'budget_daily' });
  });

  test('toutes les valeurs de RUN_STATES passent le CHECK SQL', async () => {
    const { runId } = await create();
    for (const state of RUN_STATES) await pool.query('UPDATE runs SET state = $2 WHERE id = $1', [runId, state]);
  });
});

describe('exécution (worker, identité système)', () => {
  test('cycle complet : prise, essais, coûts et jetons, clôture ; version de stratégie figée', async () => {
    const { runId, jobId } = await create();
    const claim = await claimRun(pool, { runId, jobId, workerId: 'zz_test_w1' });
    expect(claim).toMatchObject({ apiId: readApi, ownerId: A, strategyVersion: 3, input: { q: 'zz_test' }, allowWriteActions: false });
    expect(await claimRun(pool, { runId, jobId, workerId: 'zz_test_w2' })).toBeNull(); // une seule prise
    const attempts: AttemptRecord[] = [
      { execution: 'fetch', network: 'direct', est_cost_usd: 0, result: 'extraction', ms: 120 },
      { execution: 'fetch', network: 'dc_proxy', est_cost_usd: 0.0004, result: 'network', ms: 340, proxy_usd: 0.0003 },
      {
        execution: 'agent_fetch',
        network: 'direct',
        est_cost_usd: 0.02,
        result: 'ok',
        ms: 2100,
        llm_usd: 0.0123,
        tokens: { in: 1200, cached: 200, out: 300, reasoning: 50, estimated: true },
        model_id: 'zz_test_model',
        prompt_version: 'p1',
        engine: 'fake',
      },
    ];
    for (const a of attempts) await recordAttempt(pool, runId, jobId, a);
    expect(await heartbeatRun(pool, runId, jobId)).toBe(true);
    expect(await finishRun(pool, runId, jobId, { state: 'succeeded', outcome: 'degraded', degraded_reasons: ['escalated'], items: 7 })).toBe(true);
    const run = await withActor(pool, actorA, (tx) => readRun(tx, runId));
    expect(run).toMatchObject({
      state: 'succeeded',
      outcome: 'degraded',
      strategy_version: 3,
      items: 7,
      cost: { llm_usd: 0.0123, proxy_usd: 0.0003, total_usd: 0.0126 },
      tokens: { in: 1200, cached: 200, out: 300, reasoning: 50, estimated: true },
    });
    expect(run?.attempts.map((a) => [a.execution, a.network, a.result, a.cost_usd, a.ms])).toEqual([
      ['fetch', 'direct', 'extraction', 0, 120],
      ['fetch', 'dc_proxy', 'network', 0.0003, 340],
      ['agent_fetch', 'direct', 'ok', 0.0123, 2100],
    ]);
    // Clos : plus aucune écriture du worker.
    expect(await heartbeatRun(pool, runId, jobId)).toBe(false);
    await expect(recordAttempt(pool, runId, jobId, attempts[0]!)).rejects.toBeInstanceOf(RunLeaseLostError);
  });

  test('annulation : run `cancelled`, job annulé, le worker perd son bail', async () => {
    const queued = await create();
    expect(await withActor(pool, actorA, (tx) => cancelRun(tx, queue, queued.runId))).toBe(true);
    expect((await row(queued.runId))?.state).toBe('cancelled');
    expect(await queue.jobState(RUN_QUEUE, queued.jobId)).toBe('cancelled');
    expect(await claimRun(pool, { runId: queued.runId, jobId: queued.jobId, workerId: 'zz_test_w1' })).toBeNull();

    const active = await create();
    await claimRun(pool, { runId: active.runId, jobId: active.jobId, workerId: 'zz_test_w1' });
    expect(await withActor(pool, actorA, (tx) => cancelRun(tx, queue, active.runId))).toBe(true);
    expect(await heartbeatRun(pool, active.runId, active.jobId)).toBe(false);
    expect(await finishRun(pool, active.runId, active.jobId, { state: 'succeeded', outcome: 'clean', items: 1 })).toBe(false);
    expect((await row(active.runId))?.state).toBe('cancelled');
    expect(await withActor(pool, actorA, (tx) => cancelRun(tx, queue, active.runId))).toBe(false);
  });

  test('bail perdu (pause, annulation) : le coût déjà engagé par l’ancien worker est imputé quand même, sans battement (INV4)', async () => {
    const cost = async (runId: string) =>
      (await pool.query<{ llm: string; proxy: string; tokens_in: number; attempts: number }>(
        'SELECT cost_llm_usd AS llm, cost_proxy_usd AS proxy, tokens_in, (SELECT count(*)::int FROM run_attempts WHERE run_id = runs.id) AS attempts FROM runs WHERE id = $1',
        [runId],
      )).rows[0]!;
    for (const lose of ['pause', 'cancel'] as const) {
      const { runId, jobId } = await create();
      await claimRun(pool, { runId, jobId, workerId: 'zz_test_w_lost' });
      await withActor<unknown>(pool, actorA, (tx) => (lose === 'pause' ? pauseRun(tx, queue, runId) : cancelRun(tx, queue, runId)));
      // Un appel LLM était en vol : son coût réel arrive après la perte du bail.
      await expect(chargeRunCost(pool, runId, jobId, { llm_usd: 0.25, proxy_usd: 0.01, tokens: { in: 100 } })).rejects.toBeInstanceOf(RunLeaseLostError);
      await expect(recordAttempt(pool, runId, jobId, { execution: 'fetch', network: 'dc_proxy', est_cost_usd: 0, result: 'network', ms: 5, proxy_usd: 0.02 })).rejects.toBeInstanceOf(RunLeaseLostError);
      const c = await cost(runId);
      expect([Number(c.llm), Number(c.proxy), Number(c.tokens_in), c.attempts], lose).toEqual([0.25, 0.03, 100, 1]);
      // Le run perdu ne retrouve pas son bail pour autant.
      expect(await heartbeatRun(pool, runId, jobId)).toBe(false);
    }
  });
});

describe('balayeur', () => {
  test('run `running` sans battement : remis en file une fois (nouveau job), puis `failed` worker_lost ; l’ancien worker est clôturé', async () => {
    const { runId, jobId } = await create();
    await claimRun(pool, { runId, jobId, workerId: 'zz_test_dead' });
    await makeStale(runId);
    const first = await sweepOrphans(pool, queue, { staleSeconds: 5 });
    expect(first.requeued).toContain(runId);
    const after = await row(runId);
    expect(after).toMatchObject({ state: 'queued', requeue_count: 1 });
    expect(after?.job_id).not.toBe(jobId);
    expect(await queue.jobState(RUN_QUEUE, after!.job_id)).toBe('created');
    // Le worker présumé mort se réveille : aucune écriture ne passe.
    expect(await heartbeatRun(pool, runId, jobId)).toBe(false);
    await expect(recordAttempt(pool, runId, jobId, { execution: 'fetch', network: 'direct', est_cost_usd: 0, result: 'ok', ms: 1 })).rejects.toBeInstanceOf(RunLeaseLostError);
    expect(await finishRun(pool, runId, jobId, { state: 'succeeded', outcome: 'clean', items: 1 })).toBe(false);

    // Seconde perte : plafond atteint (1 en lecture) → failed, jamais bloqué en running.
    await claimRun(pool, { runId, jobId: after!.job_id, workerId: 'zz_test_dead2' });
    await makeStale(runId);
    const second = await sweepOrphans(pool, queue, { staleSeconds: 5 });
    expect(second.failed).toContain(runId);
    expect(await row(runId)).toMatchObject({ state: 'failed', failure_class: 'transient', retryable: true, error_detail: 'worker_lost' });
  });

  test('API qui écrit (allow_write_actions) : jamais rejouée, `failed` non relançable', async () => {
    const { runId, jobId } = await create(writeApi);
    await claimRun(pool, { runId, jobId, workerId: 'zz_test_dead' });
    await makeStale(runId);
    expect((await sweepOrphans(pool, queue, { staleSeconds: 5 })).failed).toContain(runId);
    expect(await row(runId)).toMatchObject({ state: 'failed', retryable: false, error_detail: 'worker_lost', requeue_count: 0 });
  });

  test('run `queued` : job vivant laissé tel quel, job perdu remis en file ; run frais ignoré', async () => {
    const alive = await create();
    const lost = await create();
    const fresh = await create();
    await queue.cancel(RUN_QUEUE, lost.jobId); // job perdu pour le run (état terminal côté pg-boss)
    await makeStale(alive.runId);
    await makeStale(lost.runId);
    const res = await sweepOrphans(pool, queue, { staleSeconds: 5 });
    expect(res.requeued).toContain(lost.runId);
    expect(res.requeued).not.toContain(alive.runId);
    expect(res.requeued).not.toContain(fresh.runId);
    expect((await row(alive.runId))?.job_id).toBe(alive.jobId);
    expect((await row(lost.runId))?.job_id).not.toBe(lost.jobId);
  });

  test('arrêt (SIGTERM) : remise en file sans compter la perte ; API qui écrit → failed', async () => {
    const read = await create();
    await claimRun(pool, { runId: read.runId, jobId: read.jobId, workerId: 'zz_test_w' });
    expect(await requeueRun(pool, queue, { runId: read.runId, jobId: read.jobId, detail: 'worker_shutdown' })).toBe('requeued');
    expect(await row(read.runId)).toMatchObject({ state: 'queued', requeue_count: 0 });
    expect(await requeueRun(pool, queue, { runId: read.runId, jobId: read.jobId, detail: 'worker_shutdown' })).toBeNull();

    const write = await create(writeApi);
    await claimRun(pool, { runId: write.runId, jobId: write.jobId, workerId: 'zz_test_w' });
    expect(await requeueRun(pool, queue, { runId: write.runId, jobId: write.jobId, detail: 'worker_shutdown' })).toBe('failed');
    expect(await row(write.runId)).toMatchObject({ state: 'failed', error_detail: 'worker_shutdown', retryable: false });
  });
});

test('bail de réparation (T2 R5) : un seul titulaire, expiration, reprise par un autre', async () => {
  expect(await acquireRepairLease(pool, readApi, 'zz_test_w1', 90)).toBe(true);
  expect(await acquireRepairLease(pool, readApi, 'zz_test_w2', 90)).toBe(false);
  expect(await renewRepairLease(pool, readApi, 'zz_test_w1', 90)).toBe(true);
  // w1 meurt : le bail expire seul.
  await pool.query("UPDATE apis SET repair_lease_until = now() - interval '1 second' WHERE id = $1", [readApi]);
  expect(await acquireRepairLease(pool, readApi, 'zz_test_w2', 90)).toBe(true);
  expect(await renewRepairLease(pool, readApi, 'zz_test_w1', 90)).toBe(false);
  await releaseRepairLease(pool, readApi, 'zz_test_w1'); // sans effet : pas titulaire
  expect(await acquireRepairLease(pool, readApi, 'zz_test_w1', 90)).toBe(false);
  await releaseRepairLease(pool, readApi, 'zz_test_w2');
  expect(await acquireRepairLease(pool, readApi, 'zz_test_w1', 90)).toBe(true);
});
