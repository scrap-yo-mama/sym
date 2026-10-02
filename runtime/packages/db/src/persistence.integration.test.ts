// SPDX-License-Identifier: AGPL-3.0-only
// Mode « SYM ne lâche pas » sur base réelle (D-49, 04 §6, tâche 2.16), horloge simulée injectée : activation (console
// seulement, version courante, mémoire négative, plafond, audit), entrée en `erreur` par la 13, tentatives à 1 h, 6 h,
// 24 h puis chaque jour par les transitions 16 puis 21 (1 au retour), webhook `api.persistence_attempt`, fin du mode sur
// un refus, plafonds, disjoncteur, `Retry-After`, bail de réparation, une tentative par domaine et par créneau.
// L'issue d'une tentative est jouée comme le worker la joue : la machine à états (applyStatusAndNotify) puis la clôture
// du run (finishRunAndNotify), dans cet ordre.
import { randomUUID } from 'node:crypto';
import { createSsrfPolicy, SsrfGuard } from '@runtime/core/net';
import { generateMasterKey, MasterKey, PERSISTENCE_DEFAULTS, type JobQueue, type Keyring, type RunResult, type StatusEventInput } from '@runtime/core';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { migrateUp } from './migrate.js';
import { applyStatusAndNotify, finishRunAndNotify } from './notify.js';
import {
  PERSISTENCE_QUEUE,
  persistenceQueueDefinition,
  readPersistenceState,
  runPersistenceAttempt,
  setPersistenceMode,
  type NegativeMemory,
  type PersistenceContext,
} from './persistence.js';
import { PgBossJobQueue } from './queue.js';
import { runQueueDefinition } from './runs.js';
import { keyCheck, secretStore } from './secrets.js';
import { createWebhookSubscription, webhookDeliveryQueueDefinition } from './webhooks.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
const A = randomUUID();
const B = randomUUID();
/** Horloge simulée : partie de l'heure réelle (le budget du jour se compte sur `runs.created_at`, horloge de la base). */
let clock = Math.floor(Date.now() / 1000) * 1000;
const now = () => new Date(clock);
const memory: NegativeMemory = { available: true, priorRefusal: async () => false };
let ctx: PersistenceContext;

beforeAll(async () => {
  tdb = await createTestDatabase('persistence');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 6 });
  for (const [id, email] of [[A, 'zz_test_a@example.test'], [B, 'zz_test_b@example.test']] as const) {
    await pool.query("INSERT INTO users (id, email, status) VALUES ($1, $2, 'active')", [id, email]);
  }
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 3, supervise: false });
  await queue.start();
  for (const d of [runQueueDefinition(), webhookDeliveryQueueDefinition(), persistenceQueueDefinition()]) await queue.createQueue(d);
  const keyring: Keyring = { current: MasterKey.parse(generateMasterKey()) };
  const store = secretStore(pool, keyring, await keyCheck(pool, keyring));
  const guard = new SsrfGuard({ policy: createSsrfPolicy({ allowedPrivateHosts: ['127.0.0.0/8'], allowedPorts: [9] }) });
  await createWebhookSubscription(pool, store, guard, { ownerId: A, url: 'http://127.0.0.1:9/hook', events: ['api.persistence_attempt', 'api.status_changed'] });
});

/** Jobs de la file `persistence-attempt` mis en file pendant le test (clé d'unicité comprise). */
let sent: { data: { api_id: string }; singletonKey: string }[] = [];
beforeEach(() => {
  sent = [];
  const recording: JobQueue = Object.create(queue) as JobQueue;
  recording.enqueueOnce = (name, data, options) => {
    if (name === PERSISTENCE_QUEUE) sent.push({ data: data as { api_id: string }, singletonKey: options.singletonKey });
    return queue.enqueueOnce(name, data, options);
  };
  ctx = { queue: recording, now, random: () => 0.5, negativeMemory: memory };
});

afterAll(async () => {
  await queue?.stop({ timeoutMs: 1000 });
  await pool?.end();
  await tdb?.drop();
});

// ------------------------------------------------------------------------------------------------- amorces

type ApiOpts = { status?: string; version?: number | null; host?: string; owner?: string; budget?: number | null; dailyBudget?: number };

async function newApi(opts: ApiOpts = {}): Promise<string> {
  const owner = opts.owner ?? A;
  const host = opts.host ?? `zz-test-${randomUUID().slice(0, 8)}.example`;
  const investigation = {
    request: { url: `https://${host}/catalogue`, description: 'zz_test catalogue', auto_validate: false, budget_usd: 0.5, timeout_s: 120 },
    validated_schema: { type: 'object', properties: { titre: { type: 'string' } }, required: ['titre'] },
    validated_by: 'user',
    spent_usd: 0.1,
    elapsed_ms: 1000,
  };
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO apis (slug, owner_id, status, current_strategy_version, investigation, investigation_phase, output_schema, persistence_budget_usd, budget_daily_usd)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'done', $6::jsonb, $7, $8) RETURNING id`,
    [`zz_test_${randomUUID().slice(0, 8)}`, owner, opts.status ?? 'warning', opts.version === undefined ? 1 : opts.version, JSON.stringify(investigation), JSON.stringify(investigation.validated_schema), opts.budget ?? null, opts.dailyBudget ?? 5],
  );
  return rows[0]!.id;
}

const consoleActor = (userId = A) => ({ userId, via: 'ui' as const });
const keyActor = (userId = A) => ({ userId, via: 'apikey' as const, ref: 'sy_live_zz01' });
const enable = (apiId: string, actor = consoleActor()) => setPersistenceMode(pool, ctx, { apiId, actor, enable: true });

/** Run de rejeu en échec puis réparation abandonnée : 11 puis 13, l'API entre en `erreur` comme en production. */
async function breakApi(apiId: string, failure: { failureClass?: 'extraction' | 'network' | 'code_error' | 'not_found'; detail?: string } = {}): Promise<void> {
  const owner = (await pool.query<{ owner_id: string }>('SELECT owner_id FROM apis WHERE id = $1', [apiId])).rows[0]!.owner_id;
  const run = await pool.query<{ id: string }>(
    "INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, failure_class, error_detail, finished_at) VALUES ($1, $2, $2, 'ui', 'failed', $3, $4, now()) RETURNING id",
    [apiId, owner, failure.failureClass ?? 'extraction', failure.detail ?? null],
  );
  const apply = (event: StatusEventInput) => applyStatusAndNotify(pool, queue, { apiId, runId: run.rows[0]!.id, event, clock: { now } }, { now });
  expect((await apply({ type: 'run_failed', failureClass: failure.failureClass ?? 'extraction' })).ok).toBe(true);
  expect((await apply({ type: 'repair_failed', cause: 'budget_exhausted' })).ok).toBe(true);
}

/** Issue d'une tentative, jouée comme le worker : machine à états d'abord (exécuteur d'enquête), puis clôture du run. */
async function settle(apiId: string, runId: string, event: StatusEventInput | null, result: RunResult, costUsd = 0.02): Promise<void> {
  await pool.query("UPDATE runs SET state = 'running', started_at = now(), cost_llm_usd = $2 WHERE id = $1", [runId, costUsd]);
  if (event !== null) await applyStatusAndNotify(pool, queue, { apiId, runId, event, clock: { now } }, { now });
  const { job_id } = (await pool.query<{ job_id: string }>('SELECT job_id FROM runs WHERE id = $1', [runId])).rows[0]!;
  expect(await finishRunAndNotify(pool, queue, { runId, jobId: job_id, result, now }, { persistence: ctx })).toBe(true);
}
const failedAttempt = (apiId: string, runId: string) =>
  settle(apiId, runId, { type: 'investigation_failed', cause: 'budget_exhausted' }, { state: 'failed', failure_class: 'run_budget_exceeded', retryable: false, error_detail: 'investigation_budget_usd' });

async function tickLaunched(apiId: string): Promise<{ runId: string; attempt: number }> {
  const tick = await runPersistenceAttempt(pool, ctx, apiId);
  if (tick.kind !== 'launched') throw new Error(`tentative attendue, reçu ${JSON.stringify(tick)}`);
  return tick;
}

const statusOf = async (apiId: string) => (await pool.query<{ status: string; status_reason: string | null }>('SELECT status, status_reason FROM apis WHERE id = $1', [apiId])).rows[0]!;
const transitionsOf = async (apiId: string) =>
  (await pool.query<{ from_status: string; to_status: string; reason: string }>('SELECT from_status, to_status, reason FROM status_events WHERE api_id = $1 ORDER BY id', [apiId])).rows.map(
    (r) => `${r.from_status}>${r.to_status}:${r.reason}`,
  );
type Payload = { type: string; data: Record<string, unknown> };
const hooks = async (apiId: string, event: string): Promise<Payload['data'][]> =>
  (await pool.query<{ payload: Payload }>('SELECT payload FROM webhook_deliveries WHERE event = $1 ORDER BY id', [event])).rows.map((r) => r.payload.data).filter((d) => d['api_id'] === apiId);
const attemptRuns = async (apiId: string) => (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM runs WHERE api_id = $1 AND kind = 'investigation'", [apiId])).rows[0]!.n;
const auditOf = async (apiId: string) =>
  (await pool.query<{ actor_user_id: string; actor_via: string; action: string; outcome: string; meta: Record<string, unknown> }>(
    "SELECT actor_user_id, actor_via, action, outcome, meta FROM audit_events WHERE target_id = $1 AND action LIKE 'api.persistence%' ORDER BY at, id",
    [apiId],
  )).rows;

// ------------------------------------------------------------------------------------------------- tests

describe('assert_persistence_opt_in_only', () => {
  test('désactivé par défaut ; activation en console seulement, auditée avec l’acteur ; une clé reçoit 403 et peut désactiver', async () => {
    const api = await newApi();
    expect(await readPersistenceState(pool, { apiId: api, userId: A })).toMatchObject({ enabled: false, budget_usd: 1, next_at: null, spent_usd: 0 });
    expect(await enable(api, keyActor())).toEqual({ ok: false, status: 403, code: 'human_confirmation_required' });
    expect((await pool.query('SELECT persistence_mode FROM apis WHERE id = $1', [api])).rows[0].persistence_mode).toBe(false);
    expect(await enable(api)).toEqual({ ok: true });
    expect(await setPersistenceMode(pool, ctx, { apiId: api, actor: keyActor(), enable: false })).toEqual({ ok: true });
    expect(await auditOf(api)).toEqual([
      expect.objectContaining({ actor_user_id: A, actor_via: 'apikey', action: 'api.persistence_enable', outcome: 'denied', meta: expect.objectContaining({ code: 'human_confirmation_required' }) }),
      expect.objectContaining({ actor_user_id: A, actor_via: 'ui', action: 'api.persistence_enable', outcome: 'success' }),
      expect.objectContaining({ actor_user_id: A, actor_via: 'apikey', action: 'api.persistence_disable', outcome: 'success' }),
    ]);
  });

  test('409 persistence_not_eligible : API jamais validée (entrée en erreur par la 2), mémoire négative absente, plafond ≤ 0', async () => {
    const neverValid = await newApi({ status: 'erreur', version: null });
    expect(await enable(neverValid)).toEqual({ ok: false, status: 409, code: 'persistence_not_eligible', reason: 'no_current_version' });
    const api = await newApi();
    ctx = { ...ctx, negativeMemory: { available: false, priorRefusal: async () => false } };
    expect(await enable(api)).toMatchObject({ status: 409, reason: 'negative_memory_unavailable' });
    // Défaut du dépôt : la mémoire négative de 2.12 n'est pas branchée, l'activation est refusée.
    const { negativeMemory: _unused, ...withoutMemory } = ctx;
    expect(await setPersistenceMode(pool, withoutMemory, { apiId: api, actor: consoleActor(), enable: true })).toMatchObject({ status: 409, reason: 'negative_memory_unavailable' });
    ctx = { ...ctx, negativeMemory: memory, policy: { ...PERSISTENCE_DEFAULTS, budgetUsdDefault: 0 } };
    expect(await enable(api)).toMatchObject({ status: 409, reason: 'budget_not_positive' });
    expect(await setPersistenceMode(pool, ctx, { apiId: api, actor: consoleActor(), enable: true, budgetUsd: -1 })).toMatchObject({ status: 409, reason: 'budget_not_positive' });
    expect((await pool.query('SELECT bool_or(persistence_mode) AS any FROM apis WHERE id = ANY($1::uuid[])', [[neverValid, api]])).rows[0].any).toBe(false);
  });

  test('l’API d’un autre utilisateur : introuvable, rien n’est écrit (INV12)', async () => {
    const api = await newApi();
    await expect(enable(api, consoleActor(B))).rejects.toThrow(/introuvable/);
    expect((await pool.query('SELECT persistence_mode FROM apis WHERE id = $1', [api])).rows[0].persistence_mode).toBe(false);
  });

  test('sans persistence_mode : la transition 16 automatique reste celle du backoff (aucune tentative, aucun job)', async () => {
    const api = await newApi();
    await breakApi(api);
    expect(await statusOf(api)).toMatchObject({ status: 'erreur' });
    expect((await runPersistenceAttempt(pool, ctx, api)).kind).toBe('idle');
    clock += 30 * DAY;
    expect((await runPersistenceAttempt(pool, ctx, api)).kind).toBe('idle');
    expect(await attemptRuns(api)).toBe(0);
    expect(await hooks(api, 'api.persistence_attempt')).toEqual([]);
  });
});

describe('assert_persistence_schedule_and_caps', () => {
  test('1 h, 6 h, 24 h puis 24 h : 16 puis 21 à chaque échec, 16 puis 1 au retour, un webhook par tentative', async () => {
    const api = await newApi();
    expect(await enable(api)).toEqual({ ok: true });
    const entered = clock;
    await breakApi(api);
    let state = await readPersistenceState(pool, { apiId: api, userId: A });
    expect(state).toMatchObject({ enabled: true, attempt: 0, ended: null });
    expect(new Date(state!.next_at!).getTime()).toBe(entered + HOUR);

    const delays = [HOUR, 6 * HOUR, DAY, DAY];
    let due = entered;
    for (const [i, delay] of delays.entries()) {
      due += delay;
      clock = due - 60_000;
      expect((await runPersistenceAttempt(pool, ctx, api)).kind).toBe('not_due');
      clock = due;
      const { runId, attempt } = await tickLaunched(api);
      expect(attempt).toBe(i + 1);
      expect(await statusOf(api)).toEqual({ status: 'enquete', status_reason: 'persistence_attempt' });
      // Une seule tentative à la fois : un second passage ne lance rien.
      expect((await runPersistenceAttempt(pool, ctx, api)).kind).toBe('idle');
      if (i < delays.length - 1) {
        await failedAttempt(api, runId);
        expect(await statusOf(api)).toMatchObject({ status: 'erreur' });
      } else {
        await settle(api, runId, { type: 'investigation_succeeded' }, { state: 'succeeded', outcome: 'clean', items: 3 });
        expect(await statusOf(api)).toMatchObject({ status: 'sain' });
      }
    }
    expect(await transitionsOf(api)).toEqual([
      'warning>reparation:extraction',
      'reparation>erreur:repair_budget_exhausted',
      ...Array.from({ length: 3 }, () => ['erreur>enquete:persistence_attempt', 'enquete>erreur:reinvestigation_failed']).flat(),
      'erreur>enquete:persistence_attempt',
      'enquete>sain:strategy_conform',
    ]);
    const attempts = await hooks(api, 'api.persistence_attempt');
    expect(attempts.map((h) => [h['attempt'], h['outcome'], h['ended']])).toEqual([[1, 'retry', null], [2, 'retry', null], [3, 'retry', null], [4, 'recovered', null]]);
    expect(attempts.map((h) => h['next_at'])).toEqual([new Date(entered + 7 * HOUR).toISOString(), new Date(entered + 31 * HOUR).toISOString(), new Date(entered + 55 * HOUR).toISOString(), null]);
    expect(attempts.map((h) => h['spent_usd'])).toEqual([0.02, 0.04, 0.06, 0.08]);
    expect((await hooks(api, 'api.status_changed')).at(-1)).toMatchObject({ from: 'enquete', to: 'sain' });
    // Cycle clos : mode toujours actif, plus aucune tentative en attente.
    state = await readPersistenceState(pool, { apiId: api, userId: A });
    expect(state).toMatchObject({ enabled: true, next_at: null, attempt: 0 });
    expect((await runPersistenceAttempt(pool, ctx, api)).kind).toBe('idle');
  });

  test('chaque tentative passe par une ré-enquête sur le schéma validé (contrat inchangé) et un job unique par API', async () => {
    const api = await newApi();
    await enable(api);
    await breakApi(api);
    // Job pg-boss unique par API : clé d'unicité `persistence:<api>`, politique `short` (un doublon en attente est écarté).
    expect(sent.filter((s) => s.data.api_id === api).map((s) => s.singletonKey)).toEqual([`persistence:${api}`]);
    expect(await queue.enqueueOnce(PERSISTENCE_QUEUE, { api_id: api }, { singletonKey: `persistence:${api}`, startAfterSeconds: 3600 })).toBeNull();
    clock += HOUR;
    const { runId } = await tickLaunched(api);
    const run = (await pool.query<{ kind: string; trigger: string }>('SELECT kind, trigger FROM runs WHERE id = $1', [runId])).rows[0]!;
    expect(run).toEqual({ kind: 'investigation', trigger: 'schedule' });
    const inv = (await pool.query<{ investigation: { validated_schema: unknown; spent_usd: number; request: { auto_validate: boolean } }; output_schema: unknown; investigation_phase: string }>(
      'SELECT investigation, output_schema, investigation_phase FROM apis WHERE id = $1',
      [api],
    )).rows[0]!;
    expect(inv.investigation.validated_schema).toEqual(inv.output_schema);
    expect(inv.investigation.spent_usd).toBe(0);
    expect(inv.investigation_phase).toBe('testing');
    await failedAttempt(api, runId);
    expect(new Set(sent.filter((s) => s.data.api_id === api).map((s) => s.singletonKey))).toEqual(new Set([`persistence:${api}`]));
  });

  test('persistence_budget_usd atteint (null = PERSISTENCE_BUDGET_USD_DEFAULT) : persistence_exhausted, plus aucune tentative', async () => {
    const api = await newApi({ budget: 0.05 });
    await enable(api);
    await breakApi(api);
    for (let i = 0; i < 3; i += 1) {
      clock += DAY + HOUR;
      const { runId } = await tickLaunched(api);
      await failedAttempt(api, runId);
    }
    // 3 × 0,02 $ ≥ 0,05 $ : la troisième issue clôt le mode.
    const state = await readPersistenceState(pool, { apiId: api, userId: A });
    expect(state).toMatchObject({ ended: 'exhausted', ended_reason: 'persistence_exhausted', next_at: null });
    expect((await hooks(api, 'api.persistence_attempt')).at(-1)).toMatchObject({ attempt: 3, outcome: 'exhausted', ended: 'exhausted' });
    clock += 2 * DAY;
    expect((await runPersistenceAttempt(pool, ctx, api)).kind).toBe('idle');
    expect(await attemptRuns(api)).toBe(3);
    expect(await statusOf(api)).toMatchObject({ status: 'erreur' });
  });

  test('budget_daily_usd atteint et PERSISTENCE_MAX_DAYS dépassé : persistence_exhausted sans tentative', async () => {
    const daily = await newApi({ dailyBudget: 0.01 });
    await enable(daily);
    await breakApi(daily);
    await pool.query("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, cost_llm_usd, created_at, finished_at) VALUES ($1, $2, $2, 'ui', 'succeeded', 0.02, $3, $3)", [daily, A, now()]);
    clock += HOUR;
    expect(await runPersistenceAttempt(pool, ctx, daily)).toMatchObject({ kind: 'ended', ended: 'exhausted', reason: 'daily_budget' });
    expect(await attemptRuns(daily)).toBe(0);

    const old = await newApi();
    await enable(old);
    await breakApi(old);
    clock += 30 * DAY;
    expect(await runPersistenceAttempt(pool, ctx, old)).toMatchObject({ kind: 'ended', ended: 'exhausted', reason: 'max_days' });
    expect(await attemptRuns(old)).toBe(0);
    expect((await hooks(old, 'api.persistence_attempt')).at(-1)).toMatchObject({ attempt: 0, outcome: 'exhausted', ended: 'exhausted' });
  });

  test('disjoncteur ouvert puis Retry-After : tentative reportée, compteur `attempt` inchangé, aucun run', async () => {
    const host = `zz-test-${randomUUID().slice(0, 8)}.example`;
    const api = await newApi({ host });
    await enable(api);
    await breakApi(api);
    clock += HOUR;
    await pool.query("INSERT INTO domain_pacing_state (domain, next_slot_at, circuit_state, circuit_open_until) VALUES ($1, now(), 'open', $2)", [host, new Date(clock + 2 * HOUR)]);
    expect(await runPersistenceAttempt(pool, ctx, api)).toMatchObject({ kind: 'deferred', reason: 'circuit_open', until: new Date(clock + 2 * HOUR) });
    await pool.query("UPDATE domain_pacing_state SET circuit_state = 'closed', circuit_open_until = NULL, penalty_until = $2 WHERE domain = $1", [host, new Date(clock + 3 * HOUR)]);
    clock += 2 * HOUR;
    expect(await runPersistenceAttempt(pool, ctx, api)).toMatchObject({ kind: 'deferred', reason: 'retry_after', until: new Date(clock + HOUR) });
    expect(await readPersistenceState(pool, { apiId: api, userId: A })).toMatchObject({ attempt: 0 });
    expect(await attemptRuns(api)).toBe(0);
    clock += HOUR;
    expect((await tickLaunched(api)).attempt).toBe(1);
  });

  test('un 429 pendant la tentative : prochain créneau après Retry-After, aucun changement de réseau', async () => {
    const host = `zz-test-${randomUUID().slice(0, 8)}.example`;
    const api = await newApi({ host });
    await enable(api);
    await breakApi(api);
    clock += HOUR;
    const { runId } = await tickLaunched(api);
    const policyBefore = (await pool.query('SELECT network_policy FROM apis WHERE id = $1', [api])).rows[0].network_policy;
    await pool.query("INSERT INTO domain_pacing_state (domain, next_slot_at, penalty_until) VALUES ($1, now(), $2)", [host, new Date(clock + 10 * HOUR)]);
    await settle(api, runId, { type: 'investigation_failed', cause: 'budget_exhausted' }, { state: 'failed', failure_class: 'rate_limited', retryable: true, error_detail: 'http_429' });
    expect((await hooks(api, 'api.persistence_attempt')).at(-1)).toMatchObject({ outcome: 'retry', reason: 'rate_limited', next_at: new Date(clock + 10 * HOUR).toISOString() });
    expect((await pool.query('SELECT network_policy FROM apis WHERE id = $1', [api])).rows[0].network_policy).toEqual(policyBefore);
  });

  test('bail de réparation tenu : la tentative attend le créneau suivant ; jamais une tentative et une réparation ensemble', async () => {
    const api = await newApi();
    await enable(api);
    await breakApi(api);
    await pool.query("UPDATE apis SET repair_lease_owner = 'zz_test_repair', repair_lease_until = now() + interval '1 hour' WHERE id = $1", [api]);
    clock += HOUR;
    expect(await runPersistenceAttempt(pool, ctx, api)).toMatchObject({ kind: 'deferred', reason: 'repair_lease' });
    await pool.query('UPDATE apis SET repair_lease_owner = NULL, repair_lease_until = NULL WHERE id = $1', [api]);
    clock += HOUR;
    const { runId } = await tickLaunched(api);
    // La tentative tient le bail : une réparation ne peut pas le prendre.
    expect((await pool.query("SELECT repair_lease_owner FROM apis WHERE id = $1", [api])).rows[0].repair_lease_owner).toBe(`persistence:${api}`);
    await failedAttempt(api, runId);
    expect((await pool.query("SELECT repair_lease_owner FROM apis WHERE id = $1", [api])).rows[0].repair_lease_owner).toBeNull();
  });

  test('trois API en erreur sur le même domaine : une seule tentative par créneau, la suivante après l’issue', async () => {
    const host = `zz-test-${randomUUID().slice(0, 8)}.example`;
    const apis = [await newApi({ host }), await newApi({ host: `www.${host}` }), await newApi({ host: `shop.${host}` })];
    for (const api of apis) {
      await enable(api);
      await breakApi(api);
    }
    clock += HOUR;
    const first = await tickLaunched(apis[0]!);
    expect(await runPersistenceAttempt(pool, ctx, apis[1]!)).toMatchObject({ kind: 'deferred', reason: 'domain_slot' });
    expect(await runPersistenceAttempt(pool, ctx, apis[2]!)).toMatchObject({ kind: 'deferred', reason: 'domain_slot' });
    await failedAttempt(apis[0]!, first.runId);
    // Issue connue mais même créneau : toujours un seul essai sur le domaine.
    expect(await runPersistenceAttempt(pool, ctx, apis[1]!)).toMatchObject({ kind: 'deferred', reason: 'domain_slot' });
    clock += HOUR;
    expect((await tickLaunched(apis[1]!)).attempt).toBe(1);
    expect(await runPersistenceAttempt(pool, ctx, apis[2]!)).toMatchObject({ kind: 'deferred', reason: 'domain_slot' });
  });
});

describe('assert_persistence_never_on_refusal', () => {
  test('403 signé pendant une tentative : bloquee par la 4, fin du mode (refused) sur toutes les API du domaine, 0 tentative ensuite', async () => {
    const host = `zz-test-${randomUUID().slice(0, 8)}.example`;
    const apis = [await newApi({ host }), await newApi({ host }), await newApi({ host })];
    for (const api of apis) {
      await enable(api);
      await breakApi(api);
    }
    clock += HOUR;
    const { runId } = await tickLaunched(apis[0]!);
    await settle(apis[0]!, runId, { type: 'run_failed', failureClass: 'forbidden', httpStatus: 403 }, { state: 'failed', failure_class: 'forbidden', retryable: false, error_detail: 'http_403' });
    expect(await statusOf(apis[0]!)).toEqual({ status: 'bloquee', status_reason: 'forbidden' });
    expect((await transitionsOf(apis[0]!)).slice(-2)).toEqual(['erreur>enquete:persistence_attempt', 'enquete>bloquee:forbidden']);
    for (const api of apis) {
      expect(await readPersistenceState(pool, { apiId: api, userId: A })).toMatchObject({ ended: 'refused', next_at: null });
      expect((await hooks(api, 'api.persistence_attempt')).at(-1)).toMatchObject({ ended: 'refused' });
    }
    clock += 10 * DAY;
    for (const api of apis) expect((await runPersistenceAttempt(pool, ctx, api)).kind).toBe('idle');
    expect(await attemptRuns(apis[1]!)).toBe(0);
    expect(await attemptRuns(apis[2]!)).toBe(0);
  });

  test('401, robots.txt, défi, 451 ou llm_refused pendant une tentative : fin du mode (refused) ; llm_auth, llm_quota_exhausted, not_found : ineligible', async () => {
    const cases: [StatusEventInput, RunResult, string, string][] = [
      [{ type: 'run_failed', failureClass: 'auth_required', httpStatus: 401 }, { state: 'failed', failure_class: 'auth_required', retryable: false, error_detail: 'http_401' }, 'action_requise', 'refused'],
      [{ type: 'run_failed', failureClass: 'robots_disallowed' }, { state: 'failed', failure_class: 'robots_disallowed', retryable: false, error_detail: 'robots' }, 'bloquee', 'refused'],
      [{ type: 'run_failed', failureClass: 'blocked_by_protection' }, { state: 'failed', failure_class: 'blocked_by_protection', retryable: false, error_detail: 'challenge' }, 'bloquee', 'refused'],
      [{ type: 'investigation_failed', cause: 'budget_exhausted' }, { state: 'failed', failure_class: 'network', retryable: false, error_detail: 'geo_restriction' }, 'erreur', 'refused'],
      [{ type: 'investigation_failed', cause: 'budget_exhausted' }, { state: 'failed', failure_class: 'llm_refused', retryable: false, error_detail: 'llm_refused' }, 'erreur', 'refused'],
      [{ type: 'investigation_failed', cause: 'budget_exhausted' }, { state: 'failed', failure_class: 'llm_auth', retryable: false, error_detail: 'llm_auth' }, 'erreur', 'ineligible'],
      [{ type: 'investigation_failed', cause: 'budget_exhausted' }, { state: 'failed', failure_class: 'llm_quota_exhausted', retryable: false, error_detail: 'quota' }, 'erreur', 'ineligible'],
      [{ type: 'investigation_failed', cause: 'budget_exhausted' }, { state: 'failed', failure_class: 'not_found', retryable: false, error_detail: 'http_404' }, 'erreur', 'ineligible'],
    ];
    for (const [event, result, status, ended] of cases) {
      const api = await newApi();
      await enable(api);
      await breakApi(api);
      clock += HOUR;
      const { runId } = await tickLaunched(api);
      await settle(api, runId, event, result);
      expect((await statusOf(api)).status).toBe(status);
      const transitions = await transitionsOf(api);
      // 451 : la 21 (retour à erreur), jamais la 2 ; refus : la 4 ou la 3.
      expect(transitions.some((t) => t.startsWith('enquete>erreur:') && !t.endsWith('reinvestigation_failed'))).toBe(false);
      expect(await readPersistenceState(pool, { apiId: api, userId: A })).toMatchObject({ ended, next_at: null });
      expect((await hooks(api, 'api.persistence_attempt')).at(-1)).toMatchObject({ attempt: 1, outcome: ended, ended });
      clock += 5 * DAY;
      expect((await runPersistenceAttempt(pool, ctx, api)).kind).toBe('idle');
      expect(await attemptRuns(api)).toBe(1);
    }
  });

  test('jamais depuis bloquee ni action_requise ; jamais après un 451, une géo-restriction ou not_compilable', async () => {
    for (const status of ['bloquee', 'action_requise'] as const) {
      const api = await newApi({ status });
      expect(await enable(api)).toEqual({ ok: true });
      clock += 10 * DAY;
      expect((await runPersistenceAttempt(pool, ctx, api)).kind).toBe('idle');
      expect(await attemptRuns(api)).toBe(0);
    }
    for (const failure of [{ failureClass: 'network', detail: 'geo_restriction' }, { failureClass: 'extraction', detail: 'not_compilable' }, { failureClass: 'not_found' }] as const) {
      const api = await newApi();
      await enable(api);
      await breakApi(api, failure);
      expect(await readPersistenceState(pool, { apiId: api, userId: A })).toMatchObject({ ended: 'ineligible', next_at: null });
      clock += 2 * DAY;
      expect((await runPersistenceAttempt(pool, ctx, api)).kind).toBe('idle');
      expect(await attemptRuns(api)).toBe(0);
    }
  });

  test('mémoire négative relue avant chaque tentative : un refus connu du domaine arrête le mode sans requête', async () => {
    const api = await newApi();
    await enable(api);
    await breakApi(api);
    clock += HOUR;
    ctx = { ...ctx, negativeMemory: { available: true, priorRefusal: async () => true } };
    expect(await runPersistenceAttempt(pool, ctx, api)).toMatchObject({ kind: 'ended', ended: 'refused', reason: 'prior_refusal' });
    expect(await attemptRuns(api)).toBe(0);
    expect(await statusOf(api)).toMatchObject({ status: 'erreur' });
  });
});
