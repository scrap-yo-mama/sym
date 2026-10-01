// SPDX-License-Identifier: AGPL-3.0-only
// assert_no_circumvention (INV6, tâche 1.7), étage I1 : run réel (file → worker → exécuteur E1 → base) contre les
// fixtures de refus, avec le classifieur PAR DÉFAUT et un port de réparation espion branché derrière la garde.
// - défi servi en 200 : `blocked_by_protection`, rien d'extrait (la stratégie sait pourtant lire la page), 1 requête,
//   l'agent de réparation n'est jamais invoqué, aucun texte de la page dans le run ni dans `run_logs` ; statut :
//   sain → reparation → bloquee (transitions 10 puis 15) sans réparation ;
// - 401 → auth_required (action_requise), 403 → forbidden (bloquee), 403 signé → blocked_by_protection ; jamais network ;
// - une vraie casse (DOM v2) atteint, elle, la réparation (le port est bien branché) ;
// - assert_circuit_opens_on_refusals : 5 refus consécutifs ouvrent le disjoncteur du domaine ; le run suivant est
//   refusé sans requête (`pacing_circuit_open`), toujours en `direct` (aucun changement de proxy ni d'IP).
import { randomUUID } from 'node:crypto';
import { DomainPacer, generateMasterKey, MasterKey } from '@runtime/core';
import * as net from '@runtime/core/net';
import { applyStatusTransition, createRun, keyCheck, migrateUp, PgBossJobQueue, PgPacingStore, readRun, runQueueDefinition, withActor } from '@runtime/db';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { startClient, type Client } from '../../../../fixtures/src/test-helpers.ts';
import { fixtureGuard } from '../../../../tests/helpers/fixture-net.ts';
import { createTestDatabase, type TestDatabase } from '../../../../tests/helpers/pg.js';
import { loadWorkerConfig } from '../config.js';
import { startWorker, type Worker } from '../worker.js';
import { createStrategyExecutor, type RepairPort } from './strategy-executor.js';

const HOSTS = {
  challenge200: 'zz_test_challenge_200.localhost',
  signed403: 'zz_test_signed403.localhost',
  login: 'zz_test_login.localhost',
  dom: 'zz_test_dom.localhost',
};
const A = randomUUID();
const actorA = { userId: A, role: 'member' as const };
const T0 = Date.parse('2026-10-01T12:00:00Z');
const NAME_SCHEMA = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let client: Client;
let worker: Worker;
const repair = vi.fn<RepairPort>(async () => null);

const base = (host: string) => `http://${host}:${client.server.port}`;
/** Stratégie HTML qui SAIT extraire la page de défi (titre `h1`) : sans la garde, le run « réussirait ». */
const headingSpec = (host: string, path = '/') => ({
  schema_version: 1,
  kind: 'declarative',
  request: { method: 'GET', url: `${base(host)}${path}`, allowed_hosts: [host] },
  sources: [{ id: 'dom', from: 'html', records: 'h1' }],
  fields: { name: { attr: 'text', type: 'string', required: true } },
});

async function insertApi(slug: string, spec: unknown, status = 'enquete'): Promise<string> {
  const id = (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, output_schema, status, network_policy, domain_pacing)
       VALUES ($1, $2, $3, $4, '{"allow": ["direct", "dc_proxy", "res_proxy"]}', '{"min_delay_ms": 5, "max_requests_per_run": 50, "max_wait_ms": 60000}') RETURNING id`,
      [`${slug}_${randomUUID().slice(0, 8)}`, A, JSON.stringify(NAME_SCHEMA), status],
    )
  ).rows[0]!.id;
  await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, est_cost_usd, created_by) VALUES ($1, 1, $2, 'fetch', 'direct', $3, 0, 'user')", [
    id,
    A,
    JSON.stringify(spec),
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

/** `error_detail` (code stable) n'est pas dans le contrat `Run` : lu dans la table. */
const detailOf = async (runId: string) => (await pool.query<{ error_detail: string | null }>('SELECT error_detail FROM runs WHERE id = $1', [runId])).rows[0]!.error_detail;

const routeLog = async (runId: string) =>
  (await pool.query<{ data: Record<string, unknown> }>("SELECT data FROM run_logs WHERE run_id = $1 AND event = 'failure_route'", [runId])).rows.map((r) => r.data);

/** Applique l'échec du run à la machine à états (le câblage run → statut naît avec la réparation, 2.3). */
async function applyFailure(apiId: string, runId: string, failureClass: string, httpStatus?: number) {
  return applyStatusTransition(pool, {
    apiId,
    runId,
    event: { type: 'run_failed', failureClass: failureClass as never, ...(httpStatus === undefined ? {} : { httpStatus }) },
    clock: { now: () => new Date(T0) },
  });
}

beforeAll(async () => {
  client = await startClient();
  tdb = await createTestDatabase('guard');
  await migrateUp({ connectionString: tdb.url });
  const masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: tdb.url, max: 6 });
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_guard@example.test', 'active')", [A]);
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  const guard = fixtureGuard(client.server.port, Object.values(HOSTS), net);
  const executor = createStrategyExecutor({ pool, guard, pacer: new DomainPacer(new PgPacingStore(pool)), browsers: null, repair });
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

beforeEach(async () => {
  await client.reset();
  repair.mockClear();
});

describe('assert_no_circumvention : garde de classification avant extraction et réparation (I1)', () => {
  test('défi servi en 200 : blocked_by_protection, rien d’extrait, agent jamais invoqué, sain → reparation → bloquee', async () => {
    const apiId = await insertApi('zz_test_challenge200', headingSpec(HOSTS.challenge200), 'sain');
    const run = await runOf(apiId);
    expect(run).toMatchObject({ state: 'failed', failure_class: 'blocked_by_protection', retryable: false, items: 0, dataset_id: null });
    expect(await detailOf(run.id)).toBe('challenge_page');
    expect(run.attempts).toHaveLength(1);
    expect(run.attempts[0]).toMatchObject({ execution: 'fetch', network: 'direct', result: 'blocked_by_protection' });
    expect(repair).not.toHaveBeenCalled();
    expect(await routeLog(run.id)).toEqual([{ failure_class: 'blocked_by_protection', next: 'stop', agent_invoked: false }]);
    // Une seule requête : aucun essai après la détection.
    expect((await client.stats()).hosts[HOSTS.challenge200]?.total).toBe(1);
    // La page de défi n'entre nulle part : ni dans le run, ni dans ses journaux.
    const dump = JSON.stringify([run, (await pool.query('SELECT event, data FROM run_logs WHERE run_id = $1', [run.id])).rows]);
    for (const text of ['Security check', 'verify you are human', 'zz_test_challenge_0001', 'not a robot']) expect(dump).not.toContain(text);
    // Statut : refus pendant un rejeu → 10 puis 15, dans le même run, sans réparation.
    const step = await applyFailure(apiId, run.id, run.failure_class!, 200);
    expect(step.ok && step.transitions.map((t) => [t.transition, t.to])).toEqual([
      [10, 'reparation'],
      [15, 'bloquee'],
    ]);
  });

  test('401 → auth_required (action_requise), 403 nu → forbidden (bloquee), 403 signé → blocked_by_protection : jamais network, jamais d’agent', async () => {
    const cases = [
      { host: HOSTS.login, spec: { ...headingSpec(HOSTS.login, '/api/orders'), sources: [{ id: 'api', from: 'response', records: '$.items[*]' }], fields: { name: { path: '$.customer', type: 'string', required: true } } }, cls: 'auth_required', status: 'action_requise', http: 401 },
      { host: HOSTS.login, spec: headingSpec(HOSTS.login, '/account'), cls: 'auth_required', status: 'action_requise', http: 200 },
      { host: HOSTS.signed403, spec: headingSpec(HOSTS.signed403, '/plain-forbidden'), cls: 'forbidden', status: 'bloquee', http: 403 },
      { host: HOSTS.signed403, spec: headingSpec(HOSTS.signed403, '/'), cls: 'blocked_by_protection', status: 'bloquee', http: 403 },
    ];
    for (const c of cases) {
      const apiId = await insertApi('zz_test_refus', c.spec, 'sain');
      const run = await runOf(apiId);
      expect(run, c.cls).toMatchObject({ state: 'failed', failure_class: c.cls, items: 0, dataset_id: null });
      expect(run.failure_class).not.toBe('network');
      expect(run.attempts.map((a) => a.network)).toEqual(['direct']);
      const step = await applyFailure(apiId, run.id, run.failure_class!, c.http);
      expect(step.ok && step.state.status, c.cls).toBe(c.status);
    }
    expect(repair).not.toHaveBeenCalled();
  });

  test('une vraie casse de structure (DOM v2) atteint la réparation, une seule fois, à travers la garde', async () => {
    await client.control({ op: 'site', site: 'dom', version: 2 });
    const spec = {
      schema_version: 1,
      kind: 'declarative',
      request: { method: 'GET', url: `${base(HOSTS.dom)}/`, allowed_hosts: [HOSTS.dom] },
      sources: [{ id: 'dom', from: 'html', records: 'li.item' }],
      fields: { name: { css: '.item-title', attr: 'text', type: 'string', required: true } },
    };
    const run = await runOf(await insertApi('zz_test_dom_v2', spec));
    expect(run).toMatchObject({ state: 'failed', failure_class: 'extraction' });
    expect(repair).toHaveBeenCalledOnce();
    expect(repair.mock.calls[0]![0].failure).toMatchObject({ failure_class: 'extraction' });
    expect(await routeLog(run.id)).toEqual([{ failure_class: 'extraction', next: 'repair', agent_invoked: true }]);
  });
});

describe('assert_circuit_opens_on_refusals : disjoncteur par domaine (04 §7)', () => {
  test('5 refus consécutifs ouvrent le disjoncteur ; le run suivant est refusé sans requête, sans changement de proxy', async () => {
    await pool.query('DELETE FROM domain_pacing_state');
    const apiId = await insertApi('zz_test_circuit', headingSpec(HOSTS.signed403, '/'));
    for (let i = 0; i < 5; i++) {
      const run = await runOf(apiId);
      expect(run, `run ${i + 1}`).toMatchObject({ failure_class: 'blocked_by_protection' });
      // Pénalité du refus (min_delay_ms) écoulée avant le run suivant : seul le disjoncteur peut refuser.
      await new Promise((r) => setTimeout(r, 20));
    }
    const state = (await pool.query<{ circuit_state: string; consecutive_failures: number }>('SELECT circuit_state, consecutive_failures FROM domain_pacing_state WHERE domain = $1', [HOSTS.signed403]))
      .rows[0]!;
    expect(state).toMatchObject({ circuit_state: 'open', consecutive_failures: 5 });
    expect((await client.stats()).hosts[HOSTS.signed403]?.total).toBe(5);
    // Une autre API du même domaine est suspendue aussi (clé = domaine), sans requête ni changement de réseau.
    const other = await insertApi('zz_test_circuit_other', headingSpec(HOSTS.signed403, '/plain-forbidden'));
    const blocked = await runOf(other);
    expect(blocked).toMatchObject({ state: 'failed', failure_class: 'rate_limited', retryable: true });
    expect(await detailOf(blocked.id)).toBe('pacing_circuit_open');
    expect(blocked.attempts.map((a) => a.network)).toEqual(['direct']);
    expect((await client.stats()).hosts[HOSTS.signed403]?.total).toBe(5);
    expect(repair).not.toHaveBeenCalled();
  });
});
