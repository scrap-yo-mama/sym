// SPDX-License-Identifier: AGPL-3.0-only
// assert_no_circumvention (INV6, tâche 1.7), étage I1 : run réel (file → worker → exécuteur E1 → base) contre les
// fixtures de refus, avec le classifieur PAR DÉFAUT et un port de réparation espion branché derrière la garde.
// - défi servi en 200 : `blocked_by_protection`, rien d'extrait (la stratégie sait pourtant lire la page), 1 requête,
//   l'agent de réparation n'est jamais invoqué, aucun texte de la page dans le run ni dans `run_logs` ; statut (machine
//   à états appliquée PAR LE TEST à la classe du run, le câblage run → statut dans le worker est différé à 2.3) :
//   sain → reparation → bloquee (transitions 10 puis 15) sans réparation ;
// - garde par preuves : un défi passé inaperçu du classifieur (extraction en échec) n'atteint jamais l'agent ; le run
//   rend la classe corrigée (`blocked_by_protection`) et le port de réparation ne reçoit que des preuves passées par la garde ;
// - 401 → auth_required (action_requise), 403 → forbidden (bloquee), 403 signé → blocked_by_protection ; jamais network ;
// - une vraie casse (DOM v2) atteint, elle, la réparation (le port est bien branché) ;
// - assert_circuit_opens_on_refusals : 5 refus consécutifs ouvrent le disjoncteur du domaine ; le run suivant est
//   refusé sans requête (`pacing_circuit_open`), toujours en `direct` (aucun changement de proxy ni d'IP).
import { randomUUID } from 'node:crypto';
import { DomainPacer, generateMasterKey, MasterKey } from '@runtime/core';
import { classifyExchange, type ClassifyContext, type ExecFailure, type HttpExchange } from '@runtime/core/exec';
import * as net from '@runtime/core/net';
import { createRun, keyCheck, migrateUp, PgBossJobQueue, PgPacingStore, readRun, runQueueDefinition, withActor } from '@runtime/db';
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
const NAME_SCHEMA = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let client: Client;
let worker: Worker;
const repair = vi.fn<RepairPort>(async () => ({ kind: 'failed', cause: 'budget_exhausted', detail: 'zz_test_no_repair' }));
/**
 * Classifieur de l'exécuteur : celui par défaut, ou (test de la garde par preuves) un classifieur qui laisse tout passer,
 * pour qu'un défi non détecté avant extraction atteigne la porte de la réparation.
 */
let classifyOverride: ((exchange: HttpExchange, context?: ClassifyContext) => ExecFailure | null) | undefined;

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

/** Requêtes de contenu reçues par un hôte : hors `/robots.txt`, lu d'abord par le module d'accès (1.11). */
const contentTotal = async (host: string): Promise<number> =>
  Object.entries((await client.stats()).hosts[host]?.paths ?? {})
    .filter(([path]) => path !== '/robots.txt')
    .reduce((n, [, count]) => n + count, 0);

/** `error_detail` (code stable) n'est pas dans le contrat `Run` : lu dans la table. */
const detailOf = async (runId: string) => (await pool.query<{ error_detail: string | null }>('SELECT error_detail FROM runs WHERE id = $1', [runId])).rows[0]!.error_detail;

const routeLog = async (runId: string) =>
  (await pool.query<{ data: Record<string, unknown> }>("SELECT data FROM run_logs WHERE run_id = $1 AND event = 'failure_route'", [runId])).rows.map((r) => r.data);

/** Applique l'échec du run à la machine à états. DIFFÉRÉ à 2.3 : aucun code de production ne relie encore un run échoué au statut (le câblage naît avec la réparation) ; ce test vérifie la machine à états sur la classe rendue par le run, pas le câblage. */
/**
 * Transitions écrites par le WORKER pendant le run (câblage run échoué → statut, tâche 2.3) : `status_events` du run,
 * dans l'ordre, sous la forme `[de, vers, raison]`.
 */
async function statusEventsOf(runId: string): Promise<[string, string, string][]> {
  const { rows } = await pool.query<{ from_status: string; to_status: string; reason: string }>('SELECT from_status, to_status, reason FROM status_events WHERE run_id = $1 ORDER BY id', [runId]);
  return rows.map((r) => [r.from_status, r.to_status, r.reason]);
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
  const executor = createStrategyExecutor({
    pool,
    guard,
    pacer: new DomainPacer(new PgPacingStore(pool)),
    browsers: null,
    repair,
    classify: (exchange, context) => (classifyOverride ?? classifyExchange)(exchange, context),
  });
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
  classifyOverride = undefined;
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
    expect(await contentTotal(HOSTS.challenge200)).toBe(1);
    // La page de défi n'entre nulle part : ni dans le run, ni dans ses journaux.
    const dump = JSON.stringify([run, (await pool.query('SELECT event, data FROM run_logs WHERE run_id = $1', [run.id])).rows]);
    for (const text of ['Security check', 'verify you are human', 'zz_test_challenge_0001', 'not a robot']) expect(dump).not.toContain(text);
    // Statut : refus pendant un rejeu → 10 puis 15, dans le même run, sans réparation (appliqué par le worker, 2.3).
    expect(await statusEventsOf(run.id)).toEqual([
      ['sain', 'reparation', 'blocked_by_protection'],
      ['reparation', 'bloquee', 'blocked_by_protection'],
    ]);
    expect((await pool.query<{ status: string }>('SELECT status FROM apis WHERE id = $1', [apiId])).rows[0]!.status).toBe('bloquee');
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
      // Statut appliqué par le worker (2.3) : 10 puis 14 ou 15 dans le même run.
      expect((await pool.query<{ status: string }>('SELECT status FROM apis WHERE id = $1', [apiId])).rows[0]!.status, `${c.cls} (HTTP ${c.http})`).toBe(c.status);
      expect((await statusEventsOf(run.id)).map((e) => e[1]), c.cls).toEqual(['reparation', c.status]);
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
    // Le port reçoit l'échange en échec, déjà passé par la garde (corps borné), comme preuve.
    const evidence = repair.mock.calls[0]![0].evidence;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ status: 200, url: `${base(HOSTS.dom)}/` });
    // Preuve minimisée (04 §5, 17 §6) : la forme de la page (squelette, classes), jamais ses valeurs (titres, prix).
    const shown = evidence[0] as HttpExchange;
    expect(shown.body).toContain('<h3 class="card__name">');
    for (const value of ['Zztest', '€', 'data-cents', 'Liste v2']) expect(shown.body, value).not.toContain(value);
    expect(Object.keys(shown.headers)).toEqual(['content-type']);
    expect(await routeLog(run.id)).toEqual([{ failure_class: 'extraction', next: 'repair', agent_invoked: true }]);
  });
});

describe('assert_no_circumvention : garde par preuves avant réparation (défi non détecté avant extraction)', () => {
  test('défi passé inaperçu du classifieur → extraction en échec, mais la preuve est une page de défi : agent jamais invoqué, run et route en blocked_by_protection', async () => {
    classifyOverride = () => null;
    const spec = { ...headingSpec(HOSTS.challenge200), sources: [{ id: 'dom', from: 'html', records: 'li.item' }] };
    const run = await runOf(await insertApi('zz_test_evidence', spec, 'sain'));
    expect(repair).not.toHaveBeenCalled();
    expect(run).toMatchObject({ state: 'failed', failure_class: 'blocked_by_protection', retryable: false, items: 0 });
    expect(run.attempts[0]).toMatchObject({ result: 'blocked_by_protection' });
    expect(await routeLog(run.id)).toEqual([{ failure_class: 'blocked_by_protection', next: 'stop', agent_invoked: false, reclassified_from: 'extraction' }]);
  });

  test('interstitiel en 200 au titre exact, un seul signal (« Pardon Our Interruption », ~450 caractères) : passé par le classifieur PAR DÉFAUT, extraction en échec, refusé par la garde avant réparation ; agent jamais invoqué, refus rapporté au disjoncteur, sain → reparation → bloquee (revue de 1.7)', async () => {
    await pool.query('DELETE FROM domain_pacing_state');
    await client.control({ op: 'site', site: 'challenge_200', variant: 'interruption' });
    const spec = { ...headingSpec(HOSTS.challenge200), sources: [{ id: 'dom', from: 'html', records: 'li.item' }] };
    const apiId = await insertApi('zz_test_interruption', spec, 'sain');
    const run = await runOf(apiId);
    expect(repair).not.toHaveBeenCalled();
    expect(run).toMatchObject({ state: 'failed', failure_class: 'blocked_by_protection', retryable: false, items: 0, dataset_id: null });
    expect(await detailOf(run.id)).toBe('challenge_page');
    expect(run.attempts[0]).toMatchObject({ result: 'blocked_by_protection' });
    expect(await routeLog(run.id)).toEqual([{ failure_class: 'blocked_by_protection', next: 'stop', agent_invoked: false, reclassified_from: 'extraction' }]);
    expect(await contentTotal(HOSTS.challenge200)).toBe(1);
    // Cadence : la classe corrigée est rapportée (refus) ; le disjoncteur la compte.
    const state = (await pool.query<{ consecutive_failures: number }>('SELECT consecutive_failures FROM domain_pacing_state WHERE domain = $1', [HOSTS.challenge200])).rows[0];
    expect(state).toMatchObject({ consecutive_failures: 1 });
    // Statut : bloquee (transition 15), jamais reparation → erreur ni relance automatique de l'enquête.
    expect(await statusEventsOf(run.id)).toEqual([
      ['sain', 'reparation', 'blocked_by_protection'],
      ['reparation', 'bloquee', 'blocked_by_protection'],
    ]);
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
    expect(await contentTotal(HOSTS.signed403)).toBe(5);
    // Une autre API du même domaine est suspendue aussi (clé = domaine), sans requête ni changement de réseau.
    const other = await insertApi('zz_test_circuit_other', headingSpec(HOSTS.signed403, '/plain-forbidden'));
    const blocked = await runOf(other);
    expect(blocked).toMatchObject({ state: 'failed', failure_class: 'rate_limited', retryable: true });
    expect(await detailOf(blocked.id)).toBe('pacing_circuit_open');
    expect(blocked.attempts.map((a) => a.network)).toEqual(['direct']);
    expect(await contentTotal(HOSTS.signed403)).toBe(5);
    expect(repair).not.toHaveBeenCalled();
  });
});
