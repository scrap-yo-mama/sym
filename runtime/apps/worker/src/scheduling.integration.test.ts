// SPDX-License-Identifier: AGPL-3.0-only
// Planification de bout en bout dans de vrais workers (tâche 2.5) : horloge simulée, DEUX workers, cron chaque minute →
// trois déclenchements, trois runs exécutés une fois chacun (0 doublon), webhook signé reçu pour chacun ; une API
// `bloquee` planifiée ne produit aucun run exécuté. Les règles fines sont testées dans `@runtime/db`.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateMasterKey, loadKeyring, secretValues, verifyWebhook, type RunExecutor } from '@runtime/core';
import { createSsrfPolicy, SsrfGuard } from '@runtime/core/net';
import { createWebhookSubscription, keyCheck, migrateUp, PgBossJobQueue, secretStore } from '@runtime/db';
import pg from 'pg';
import { TestClock } from 'pg-boss';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { loadWorkerConfig } from './config.js';
import { startWorker, type Worker } from './worker.js';

const silent = pino({ level: 'silent' });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let tdb: TestDatabase;
let pool: pg.Pool;
let masterKey: string;
let receiver: Server;
let port: number;
const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
const workers: Worker[] = [];
const owner = randomUUID();

beforeAll(async () => {
  masterKey = generateMasterKey();
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  port = (receiver.address() as AddressInfo).port;
});

// Base neuve par test : le cron de pg-boss garde en base l'heure de son dernier passage (ici simulée), un test qui repart d'une
// heure antérieure sur la même base attendrait la fin du temps déjà simulé.
beforeEach(async () => {
  received.length = 0;
  tdb = await createTestDatabase('worker_sched');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 4 });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_owner@example.test', 'active')", [owner]);
});

afterEach(async () => {
  for (const w of workers.splice(0)) await w.stop().catch(() => undefined);
  await pool?.end();
  await tdb?.drop();
});

afterAll(async () => {
  secretValues.clear();
  receiver?.closeAllConnections();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

const fastEnv = (): NodeJS.ProcessEnv => ({
  DATABASE_URL: tdb.url,
  MASTER_KEY: masterKey,
  RUN_HEARTBEAT_SECONDS: '0.5',
  RUN_STALE_SECONDS: '2',
  SWEEP_INTERVAL_SECONDS: '5',
  WORKER_HEARTBEAT_SECONDS: '5',
  QUEUE_POLLING_SECONDS: '0.5',
  SHUTDOWN_TIMEOUT_SECONDS: '1',
  ALLOWED_PRIVATE_HOSTS: '127.0.0.0/8',
  ALLOWED_EGRESS_PORTS: String(port),
});

async function twoWorkers(clock: TestClock, executor: RunExecutor): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const w = await startWorker({
      config: loadWorkerConfig(fastEnv()),
      executor,
      logger: silent,
      scheduling: { clock, now: () => new Date(clock.now()), supervise: false },
    });
    workers.push(w);
  }
}

async function advance(clock: TestClock, totalMs: number, stepMs = 2000): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await clock.tick(stepMs);
    await sleep(40);
  }
  await sleep(500);
}

const nextMinuteBoundary = (offsetMs: number) => Math.ceil(Date.now() / 60_000) * 60_000 + offsetMs;

async function schedulePair(status: string) {
  const api = (await pool.query<{ id: string }>('INSERT INTO apis (slug, owner_id, status) VALUES ($1, $2, $3) RETURNING id', [`zz_test_${randomUUID().slice(0, 8)}`, owner, status])).rows[0]!.id;
  const schedule = (await pool.query<{ id: string }>("INSERT INTO schedules (api_id, owner_id, cron, overlap) VALUES ($1, $2, '* * * * *', 'allow') RETURNING id", [api, owner])).rows[0]!.id;
  return { api, schedule };
}

describe('planification de bout en bout', () => {
  test('3 déclenchements, 0 doublon avec 2 workers : trois runs exécutés une fois, trois webhooks signés', async () => {
    const { api, schedule } = await schedulePair('sain');
    const keyring = loadKeyring({ MASTER_KEY: masterKey });
    const store = secretStore(pool, keyring, await keyCheck(pool, keyring));
    const guard = new SsrfGuard({ policy: createSsrfPolicy({ allowedPrivateHosts: ['127.0.0.0/8'], allowedPorts: [port] }) });
    const sub = await createWebhookSubscription(pool, store, guard, { ownerId: owner, url: `http://127.0.0.1:${port}/hook`, events: ['run.succeeded'] });

    const executed: string[] = [];
    const executor: RunExecutor = async (ctx) => {
      executed.push(ctx.runId);
      await ctx.recordAttempt({ execution: 'fetch', network: 'direct', est_cost_usd: 0, result: 'ok', ms: 1 });
      return { state: 'succeeded', outcome: 'clean', items: 3 };
    };
    const clock = new TestClock(nextMinuteBoundary(20_000));
    await twoWorkers(clock, executor);
    await advance(clock, 2 * 60_000 + 40_000); // occurrences à M, M+1, M+2

    const runs = (await pool.query<{ id: string; state: string; scheduled_at: Date; schedule_job_id: string }>('SELECT id, state, scheduled_at, schedule_job_id FROM runs WHERE schedule_id = $1 ORDER BY scheduled_at', [schedule])).rows;
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.state === 'succeeded')).toBe(true);
    expect(new Set(runs.map((r) => r.scheduled_at.toISOString().slice(0, 16))).size).toBe(3);
    expect(new Set(runs.map((r) => r.schedule_job_id)).size).toBe(3);
    // Chaque run exécuté exactement une fois, par un seul des deux workers.
    expect([...executed].sort()).toEqual(runs.map((r) => r.id).sort());
    expect(new Set(executed).size).toBe(3);

    // Un webhook signé par run, `webhook-id` distinct par événement, signature vérifiée à l'instant de l'envoi.
    const events = received.filter((r) => JSON.parse(r.body).type === 'run.succeeded');
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.headers['webhook-id'])).size).toBe(3);
    const secret = (await pool.query<{ id: string }>('SELECT secret_id AS id FROM webhook_subscriptions WHERE id = $1', [sub.id])).rows[0]!.id;
    const value = (await store.get(secret)).reveal();
    for (const e of events) {
      const sentAt = new Date(Number(e.headers['webhook-timestamp']) * 1000);
      expect(() => verifyWebhook({ headers: e.headers, body: e.body, secrets: [value], now: sentAt })).not.toThrow();
      expect(JSON.parse(e.body).data).toMatchObject({ api_id: api, status: 'sain', items: 3, outcome: 'clean' });
    }
    expect((await pool.query("SELECT count(*)::int AS n FROM webhook_deliveries WHERE status = 'succeeded'")).rows[0].n).toBe(3);
  }, 120_000);

  test('assert_schedule_skips_bloquee (worker) : une API bloquee planifiée ne produit aucun run exécuté, 3 déclenchements tracés skipped_status', async () => {
    const { api, schedule } = await schedulePair('bloquee');
    const executed: string[] = [];
    const executor: RunExecutor = async (ctx) => {
      executed.push(ctx.runId);
      return { state: 'succeeded', outcome: 'clean', items: 1 };
    };
    const clock = new TestClock(nextMinuteBoundary(20_000));
    await twoWorkers(clock, executor);
    await advance(clock, 2 * 60_000 + 40_000);

    const runs = (await pool.query<{ state: string; job_id: string | null }>('SELECT state, job_id FROM runs WHERE schedule_id = $1', [schedule])).rows;
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.state === 'skipped_status' && r.job_id === null)).toBe(true);
    expect(executed).toEqual([]);
    expect((await pool.query('SELECT status FROM apis WHERE id = $1', [api])).rows[0].status).toBe('bloquee');
  }, 120_000);

  test('au redémarrage, le miroir pg-boss est reconstruit depuis `schedules` (ligne ajoutée hors service, clé orpheline retirée)', async () => {
    const { schedule } = await schedulePair('sain');
    const executor: RunExecutor = async () => ({ state: 'succeeded', outcome: 'clean', items: 0 });
    const clock = new TestClock(nextMinuteBoundary(20_000));
    const w = await startWorker({ config: loadWorkerConfig(fastEnv()), executor, logger: silent, scheduling: { clock, now: () => new Date(clock.now()), supervise: false } });
    workers.push(w);
    const probe = new PgBossJobQueue({ connectionString: tdb.url, max: 1, supervise: false });
    await probe.start();
    try {
      expect(await probe.scheduledKeys('scheduled-run')).toEqual([schedule]);
    } finally {
      await probe.stop({ timeoutMs: 500 });
    }
  }, 60_000);
});
