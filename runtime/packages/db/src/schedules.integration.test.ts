// SPDX-License-Identifier: AGPL-3.0-only
// Planification sur base réelle (tâche 2.5, 08 § 5, T2 R3) : miroir pg-boss reconstruit depuis `schedules`, horloge
// simulée (TestClock de pg-boss : l'heure de Postgres suit), deux workers, 0 doublon, `missed: once`, règles
// (`skip_if_status_in` avec `bloquee`, fenêtre, quota, tunnel, chevauchement), variables datées, rejeu d'un job.
import { randomUUID } from 'node:crypto';
import { RUN_QUEUE, SCHEDULED_RUN_QUEUE, type ScheduledRunJobData } from '@runtime/core';
import pg from 'pg';
import { TestClock } from 'pg-boss';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { migrateUp } from './migrate.js';
import { PgBossJobQueue } from './queue.js';
import { runQueueDefinition } from './runs.js';
import {
  handleScheduledRun,
  mirrorSchedule,
  reconcileSchedules,
  scheduledRunDeferredQueueDefinition,
  scheduledRunQueueDefinition,
  schedulePeriodMs,
  validateSchedule,
  warningDelayMs,
} from './schedules.js';

let tdb: TestDatabase;
let pool: pg.Pool;
/** File sans cron ni horloge simulée : sert aux appels directs de `handleScheduledRun` et à `previewSchedule`. */
let plain: PgBossJobQueue;
const owner = randomUUID();
const other = randomUUID();
const member = randomUUID();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const open: PgBossJobQueue[] = [];

beforeAll(async () => {
  tdb = await createTestDatabase('schedules');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 8 });
  await pool.query(
    "INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_owner@example.test', 'active'), ($2, 'zz_test_other@example.test', 'disabled'), ($3, 'zz_test_member@example.test', 'active')",
    [owner, other, member],
  );
  plain = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
  await plain.start();
  await plain.createQueue(runQueueDefinition());
  await plain.createQueue(scheduledRunQueueDefinition());
  await plain.createQueue(scheduledRunDeferredQueueDefinition());
});

afterEach(async () => {
  for (const q of open.splice(0)) await q.stop({ timeoutMs: 1000 }).catch(() => undefined);
});

afterAll(async () => {
  await plain?.stop({ timeoutMs: 1000 });
  await pool?.end();
  await tdb?.drop();
});

async function newApi(status = 'sain', extra: { requiresTunnel?: boolean; ownerId?: string } = {}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('INSERT INTO apis (slug, owner_id, status, requires) VALUES ($1, $2, $3, $4::jsonb) RETURNING id', [
    `zz_test_${randomUUID().slice(0, 8)}`,
    extra.ownerId ?? owner,
    status,
    JSON.stringify(extra.requiresTunnel ? { tunnel: true } : {}),
  ]);
  return rows[0]!.id;
}

async function newSchedule(
  apiId: string,
  over: { cron?: string; timezone?: string; rules?: unknown; overlap?: string; onMissed?: string; enabled?: boolean; input?: unknown; ownerId?: string } = {},
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO schedules (api_id, owner_id, cron, timezone, input, rules, overlap, on_missed, enabled)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9) RETURNING id`,
    [apiId, over.ownerId ?? owner, over.cron ?? '* * * * *', over.timezone ?? 'UTC', JSON.stringify(over.input ?? {}), JSON.stringify(over.rules ?? {}), over.overlap ?? 'skip', over.onMissed ?? 'skip', over.enabled ?? true],
  );
  return rows[0]!.id;
}

const fire = (scheduleId: string, at: string, over: { deferred?: number; jobId?: string; occurredAt?: string; occurrenceAt?: string } = {}) =>
  handleScheduledRun({
    pool,
    queue: plain,
    now: () => new Date(at),
    jobId: over.jobId ?? randomUUID(),
    ...(over.occurredAt ? { occurredAt: new Date(over.occurredAt) } : {}),
    data: {
      schedule_id: scheduleId,
      ...(over.deferred ? { deferred: over.deferred } : {}),
      ...(over.occurrenceAt ? { occurrence_at: over.occurrenceAt } : {}),
    } satisfies ScheduledRunJobData,
  });

type RunRow = { id: string; state: string; trigger: string; scheduled_at: Date; schedule_job_id: string | null; input: unknown; error_detail: string | null; job_id: string | null };
const runsOf = async (scheduleId: string): Promise<RunRow[]> =>
  (await pool.query<RunRow>('SELECT id, state, trigger, scheduled_at, schedule_job_id, input, error_detail, job_id FROM runs WHERE schedule_id = $1 ORDER BY scheduled_at, created_at', [scheduleId])).rows;
const complete = (runId: string) => pool.query("UPDATE runs SET state = 'succeeded', finished_at = now() WHERE id = $1", [runId]);
const minuteOf = (d: Date) => d.toISOString().slice(0, 16);

/** Fait avancer l'horloge simulée par pas, en laissant les E/S se terminer entre deux pas. */
async function advance(clock: TestClock, totalMs: number, stepMs = 2000): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await clock.tick(stepMs);
    await sleep(25);
  }
  await sleep(300);
}

/**
 * Base dédiée aux tests d'horloge simulée : le cron de pg-boss garde en base l'heure de son dernier passage ; un test qui
 * repart d'une heure antérieure sur la même base attendrait la fin du temps déjà simulé.
 */
type Env = { tdb: TestDatabase; pool: pg.Pool; plain: PgBossJobQueue; close: () => Promise<void> };
async function freshEnv(): Promise<Env> {
  const t = await createTestDatabase('schedclock');
  await migrateUp({ connectionString: t.url });
  const p = new pg.Pool({ connectionString: t.url, max: 8 });
  await p.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_owner@example.test', 'active')", [owner]);
  const pl = new PgBossJobQueue({ connectionString: t.url, max: 2, supervise: false });
  await pl.start();
  await pl.createQueue(runQueueDefinition());
  await pl.createQueue(scheduledRunQueueDefinition());
  await pl.createQueue(scheduledRunDeferredQueueDefinition());
  const env: Env = {
    tdb: t,
    pool: p,
    plain: pl,
    close: async () => {
      for (const q of open.splice(0)) await q.stop({ timeoutMs: 1000 }).catch(() => undefined);
      await pl.stop({ timeoutMs: 1000 }).catch(() => undefined);
      await p.end();
      await t.drop();
    },
  };
  return env;
}

async function envApiAndSchedule(env: Env, over: { cron: string; onMissed?: string }): Promise<string> {
  const api = (await env.pool.query<{ id: string }>("INSERT INTO apis (slug, owner_id, status) VALUES ($1, $2, 'sain') RETURNING id", [`zz_test_${randomUUID().slice(0, 8)}`, owner])).rows[0]!.id;
  const { rows } = await env.pool.query<{ id: string }>(
    "INSERT INTO schedules (api_id, owner_id, cron, overlap, on_missed) VALUES ($1, $2, $3, 'allow', $4) RETURNING id",
    [api, owner, over.cron, over.onMissed ?? 'skip'],
  );
  return rows[0]!.id;
}

const runsIn = async (env: Env, scheduleId: string): Promise<RunRow[]> =>
  (await env.pool.query<RunRow>('SELECT id, state, trigger, scheduled_at, schedule_job_id, input, error_detail, job_id FROM runs WHERE schedule_id = $1 ORDER BY scheduled_at, created_at', [scheduleId])).rows;

/** Un worker : file pg-boss avec cron actif sur l'horloge simulée, gestionnaire de `scheduled-run`. Démarrés l'un après l'autre. */
async function startScheduler(env: Env, clock: TestClock, name: string): Promise<PgBossJobQueue> {
  const q = new PgBossJobQueue({ connectionString: env.tdb.url, max: 3, schedule: true, clock, application_name: name, supervise: false });
  open.push(q);
  await q.start();
  await q.createQueue(runQueueDefinition());
  await q.createQueue(scheduledRunQueueDefinition());
  await q.createQueue(scheduledRunDeferredQueueDefinition());
  await q.work<ScheduledRunJobData>(SCHEDULED_RUN_QUEUE, { concurrency: 2, pollingIntervalSeconds: 0.5 }, async (job) => {
    await handleScheduledRun({ pool: env.pool, queue: q, now: () => new Date(clock.now()), jobId: job.id, data: job.data });
  });
  return q;
}

async function resetSchedules(): Promise<void> {
  await pool.query('DELETE FROM runs WHERE schedule_id IS NOT NULL');
  await pool.query('DELETE FROM schedules');
  for (const key of await plain.scheduledKeys(SCHEDULED_RUN_QUEUE)) await plain.unschedule(SCHEDULED_RUN_QUEUE, key);
}

describe('validation', () => {
  const ok = (spec: Parameters<typeof validateSchedule>[1]) => {
    const r = validateSchedule(plain, spec, new Date('2026-10-01T10:00:00Z'));
    if (!r.ok) throw new Error(r.errors.join('; '));
    return r.schedule;
  };
  const errors = (spec: Parameters<typeof validateSchedule>[1]) => {
    const r = validateSchedule(plain, spec, new Date('2026-10-01T10:00:00Z'));
    return r.ok ? '' : r.errors.join(' | ');
  };

  test('cron à 5 champs, fuseau IANA ; prochaines occurrences calculées sans base', () => {
    const s = ok({ cron: '*/15 * * * *', timezone: 'Europe/Paris' });
    expect(s.next.map((d) => d.toISOString())).toEqual(['2026-10-01T10:15:00.000Z', '2026-10-01T10:30:00.000Z', '2026-10-01T10:45:00.000Z', '2026-10-01T11:00:00.000Z', '2026-10-01T11:15:00.000Z']);
  });

  test('fréquence minimale 1 minute : secondes et RRULE refusées', () => {
    expect(errors({ cron: '*/10 * * * * *' })).toContain('5 champs');
    expect(errors({ cron: 'FREQ=SECONDLY;INTERVAL=5' })).toContain('5 champs');
    expect(errors({ cron: '* * * * *' })).toBe('');
  });

  test('cron ou fuseau invalide, règle inconnue, bloquee retirée, overlap inconnu', () => {
    expect(errors({ cron: '99 * * * *' })).toContain('invalide');
    expect(errors({ cron: '0 * * * *', timezone: 'Mars/Olympus' })).toContain('invalide');
    expect(errors({ cron: '0 * * * *', rules: { skip_if_status_in: ['erreur'] } })).toContain('bloquee');
    expect(errors({ cron: '0 * * * *', rules: { foo: 1 } })).toContain('règle inconnue');
    expect(errors({ cron: '0 * * * *', overlap: 'maybe' as never })).toContain('overlap');
  });

  test('missed par défaut : once si les occurrences sont espacées d\'au moins 1 h, skip sinon', () => {
    expect(ok({ cron: '0 * * * *' }).onMissed).toBe('once');
    expect(ok({ cron: '0 6 * * *' }).onMissed).toBe('once');
    expect(ok({ cron: '*/5 * * * *' }).onMissed).toBe('skip');
    expect(ok({ cron: '*/5 * * * *', onMissed: 'once' }).onMissed).toBe('once');
  });

  test('heures d\'été et d\'hiver (fuseau de la planification) : une occurrence par jour, ni sautée ni doublée', () => {
    const iso = (cron: string, tz: string, from: string, count: number) => plain.previewSchedule(cron, { timezone: tz, count, from: new Date(from) }).map((d) => d.toISOString());
    // Passage à l'heure d'été (29/03/2026, 02:30 n'existe pas à Paris) : l'occurrence n'est pas perdue, elle est décalée (03:30 locale).
    expect(iso('30 2 * * *', 'Europe/Paris', '2026-03-27T12:00:00Z', 4)).toEqual(['2026-03-28T01:30:00.000Z', '2026-03-29T01:30:00.000Z', '2026-03-30T00:30:00.000Z', '2026-03-31T00:30:00.000Z']);
    // Retour à l'heure d'hiver (25/10/2026, 02:30 existe deux fois) : une seule occurrence, pas deux.
    expect(iso('30 2 * * *', 'Europe/Paris', '2026-10-23T12:00:00Z', 4)).toEqual(['2026-10-24T00:30:00.000Z', '2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z', '2026-10-27T01:30:00.000Z']);
    // Cron à pas régulier : l'écart reste de 30 minutes réelles à travers le changement d'heure.
    const slots = iso('*/30 * * * *', 'Europe/Paris', '2026-10-25T00:00:00Z', 8).map((d) => Date.parse(d));
    expect(new Set(slots.slice(1).map((t, i) => t - (slots[i] as number)))).toEqual(new Set([1_800_000]));
  });

  test('période d\'une API et D = max(7 j, 3 × période)', async () => {
    const api = await newApi();
    await newSchedule(api, { cron: '0 8 * * 1' }); // hebdomadaire
    const from = new Date('2026-10-01T10:00:00Z');
    expect(schedulePeriodMs(plain, [{ cron: '0 8 * * 1', timezone: 'UTC', enabled: true }], from)).toBe(7 * 86_400_000);
    expect(await warningDelayMs(pool, plain, api, from)).toBe(21 * 86_400_000);
    expect(await warningDelayMs(pool, plain, await newApi(), from)).toBe(7 * 86_400_000);
    expect(schedulePeriodMs(plain, [{ cron: '* * * * *', timezone: 'UTC', enabled: false }], from)).toBeNull();
  });
});

describe('miroir pg-boss : `schedules` est la source de vérité', () => {
  test('reconstruction : lignes actives planifiées, clés orphelines et désactivées retirées', async () => {
    await resetSchedules();
    const api = await newApi();
    const active = await newSchedule(api, { cron: '0 * * * *' });
    const disabled = await newSchedule(api, { cron: '0 * * * *', enabled: false });
    const ownerDisabled = await newSchedule(await newApi('sain', { ownerId: other }), { cron: '0 * * * *', ownerId: other });
    // Orphelin : planifié dans pg-boss, absent de la table.
    const orphan = randomUUID();
    await plain.schedule(SCHEDULED_RUN_QUEUE, orphan, '0 * * * *', { schedule_id: orphan }, { timezone: 'UTC', missed: 'skip' });
    await plain.schedule(SCHEDULED_RUN_QUEUE, disabled, '0 * * * *', { schedule_id: disabled }, { timezone: 'UTC', missed: 'skip' });

    const result = await reconcileSchedules(pool, plain);
    expect(result.scheduled).toEqual([active]);
    expect([...result.unscheduled].sort()).toEqual([orphan, disabled].sort());
    expect(await plain.scheduledKeys(SCHEDULED_RUN_QUEUE)).toEqual([active]);
    expect(await plain.scheduledKeys(SCHEDULED_RUN_QUEUE)).not.toContain(ownerDisabled);

    // Idempotente.
    const again = await reconcileSchedules(pool, plain);
    expect(again.unscheduled).toEqual([]);
    expect(await plain.scheduledKeys(SCHEDULED_RUN_QUEUE)).toEqual([active]);
  });

  test('plusieurs planifications par API : chacune sa clé, aucune n\'écrase l\'autre', async () => {
    await resetSchedules();
    const api = await newApi();
    const a = await newSchedule(api, { cron: '0 6 * * *' });
    const b = await newSchedule(api, { cron: '30 18 * * *', timezone: 'Europe/Paris' });
    await reconcileSchedules(pool, plain);
    expect([...(await plain.scheduledKeys(SCHEDULED_RUN_QUEUE))].sort()).toEqual([a, b].sort());
  });

  test('désactivation puis suppression : le miroir suit au prochain alignement, le job orphelin est neutralisé', async () => {
    await resetSchedules();
    const api = await newApi();
    const id = await newSchedule(api, { cron: '0 * * * *' });
    await mirrorSchedule(plain, { id, cron: '0 * * * *', timezone: 'UTC', on_missed: 'skip', enabled: true });
    expect(await plain.scheduledKeys(SCHEDULED_RUN_QUEUE)).toEqual([id]);
    await mirrorSchedule(plain, { id, cron: '0 * * * *', timezone: 'UTC', on_missed: 'skip', enabled: false });
    expect(await plain.scheduledKeys(SCHEDULED_RUN_QUEUE)).toEqual([]);
    // Ligne supprimée alors qu'un job était déjà parti : le gestionnaire ne crée rien et retire le miroir.
    await mirrorSchedule(plain, { id, cron: '0 * * * *', timezone: 'UTC', on_missed: 'skip', enabled: true });
    await pool.query('DELETE FROM schedules WHERE id = $1', [id]);
    expect(await fire(id, '2026-10-01T10:00:00Z')).toEqual({ outcome: 'ignored', reason: 'schedule_missing' });
    expect(await plain.scheduledKeys(SCHEDULED_RUN_QUEUE)).toEqual([]);
  });
});

describe('horloge simulée, deux workers : 0 doublon', () => {
  let env: Env | undefined;
  afterEach(async () => {
    await env?.close();
    env = undefined;
  });

  test('3 déclenchements, 0 doublon avec 2 workers (cron chaque minute)', async () => {
    env = await freshEnv();
    const id = await envApiAndSchedule(env, { cron: '* * * * *' });
    await env.pool.query("UPDATE schedules SET input = '{\"since\": \"{{yesterday}}\", \"until\": \"{{today}}\"}'::jsonb WHERE id = $1", [id]);
    const clock = new TestClock('2026-10-01T10:00:20Z');
    await startScheduler(env, clock, 'zz_test_w1');
    await startScheduler(env, clock, 'zz_test_w2');
    await mirrorSchedule(env.plain, { id, cron: '* * * * *', timezone: 'UTC', on_missed: 'skip', enabled: true });

    await advance(clock, 2 * 60_000 + 40_000); // jusqu'à 10:03:00 (exclu) : occurrences 10:00, 10:01, 10:02
    const runs = await runsIn(env, id);
    expect(runs.map((r) => minuteOf(r.scheduled_at))).toEqual(['2026-10-01T10:00', '2026-10-01T10:01', '2026-10-01T10:02']);
    expect(new Set(runs.map((r) => r.schedule_job_id)).size).toBe(3);
    expect(runs.every((r) => r.trigger === 'schedule' && r.state === 'queued' && r.job_id !== null)).toBe(true);
    // Variables datées résolues à l'instant du déclenchement, dans le fuseau de la planification.
    expect(runs[0]!.input).toEqual({ since: '2026-09-30', until: '2026-10-01' });
  }, 60_000);

  test('assert_schedule_single_source : deux workers, une planification à la minute, 10 minutes : une occurrence par minute', async () => {
    env = await freshEnv();
    const id = await envApiAndSchedule(env, { cron: '* * * * *' });
    const clock = new TestClock('2026-10-01T10:00:20Z');
    await startScheduler(env, clock, 'zz_test_w1');
    await startScheduler(env, clock, 'zz_test_w2');
    await mirrorSchedule(env.plain, { id, cron: '* * * * *', timezone: 'UTC', on_missed: 'skip', enabled: true });

    await advance(clock, 10 * 60_000 + 30_000); // 10:00:20 → 10:10:50
    const minutes = (await runsIn(env, id)).map((r) => minuteOf(r.scheduled_at));
    const expected = Array.from({ length: 11 }, (_, i) => `2026-10-01T10:${String(i).padStart(2, '0')}`);
    expect(minutes).toEqual(expected);
    expect(new Set(minutes).size).toBe(minutes.length);
  }, 120_000);

  test('missed: once rattrape UNE occurrence après un redéploiement ; skip n\'en rattrape aucune', async () => {
    env = await freshEnv();
    const once = await envApiAndSchedule(env, { cron: '*/5 * * * *', onMissed: 'once' });
    const skip = await envApiAndSchedule(env, { cron: '*/5 * * * *', onMissed: 'skip' });
    // Jour simulé APRÈS l'heure réelle d'installation (rattrapage borné par elle) : une date figée échouait passé 10:42 UTC ce jour-là.
    const day = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const clock = new TestClock(`${day}T10:01:10Z`);
    const first = await startScheduler(env, clock, 'zz_test_before');
    for (const [sid, m] of [[once, 'once'], [skip, 'skip']] as const) {
      await mirrorSchedule(env.plain, { id: sid, cron: '*/5 * * * *', timezone: 'UTC', on_missed: m, enabled: true });
    }
    await advance(clock, 40_000); // quelques passages du cron, aucune occurrence due (10:00 est à 70 s, la prochaine est 10:05)
    // Le premier passage d'une base neuve rattrape l'écart depuis l'installation (heure réelle) : on compte donc des écarts.
    const before = (await runsIn(env, once)).length;
    expect(before).toBeLessThanOrEqual(1);
    expect(await runsIn(env, skip)).toHaveLength(0);

    // Redéploiement : le worker s'arrête, 42 minutes passent, un nouveau worker démarre.
    await first.stop({ timeoutMs: 1000 });
    await clock.setTime(`${day}T10:42:30Z`);
    await startScheduler(env, clock, 'zz_test_after');
    await advance(clock, 30_000);

    expect((await runsIn(env, once)).length - before).toBe(1); // une seule, pas huit
    expect(await runsIn(env, skip)).toHaveLength(0);
  }, 60_000);
});

describe('règles', () => {
  test('assert_schedule_skips_bloquee : une API bloquee n\'est jamais sollicitée, 48 h durant, aucune ré-enquête', async () => {
    await resetSchedules();
    const api = await newApi('bloquee');
    await pool.query("INSERT INTO status_events (api_id, owner_id, from_status, to_status, reason) VALUES ($1, $2, 'sain', 'bloquee', 'blocked_by_protection')", [api, owner]);
    const id = await newSchedule(api, { cron: '*/15 * * * *', overlap: 'allow' });
    const events = (await pool.query('SELECT count(*)::int AS n FROM status_events WHERE api_id = $1', [api])).rows[0].n as number;

    const start = Date.parse('2026-10-01T00:00:00Z');
    for (let step = 0; step < 48 * 4; step++) {
      const outcome = await fire(id, new Date(start + step * 15 * 60_000).toISOString());
      expect(outcome).toMatchObject({ outcome: 'skipped', state: 'skipped_status', reason: 'status_bloquee' });
    }
    const runs = await runsOf(id);
    expect(runs).toHaveLength(192);
    expect(runs.every((r) => r.state === 'skipped_status')).toBe(true);
    // Rien n'a été mis en file, rien n'a changé : statut, historique, aucun run actif ni enquête.
    expect(runs.every((r) => r.job_id === null)).toBe(true);
    expect((await pool.query('SELECT status FROM apis WHERE id = $1', [api])).rows[0].status).toBe('bloquee');
    expect((await pool.query('SELECT count(*)::int AS n FROM status_events WHERE api_id = $1', [api])).rows[0].n).toBe(events);
    expect((await pool.query("SELECT count(*)::int AS n FROM runs WHERE api_id = $1 AND state IN ('queued', 'running')", [api])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM investigation_events e JOIN runs r ON r.id = e.run_id WHERE r.api_id = $1', [api])).rows[0].n).toBe(0);
  });

  test('bloquee sautée même si la ligne est écrite hors du service (règles vides ou illisibles)', async () => {
    await resetSchedules();
    const api = await newApi('bloquee');
    const forged = await newSchedule(api, { rules: { skip_if_status_in: [] } });
    const garbage = await newSchedule(api, { rules: { unknown_rule: true, window: 'maintenant' } });
    expect(await fire(forged, '2026-10-01T10:00:00Z')).toMatchObject({ outcome: 'skipped', state: 'skipped_status' });
    expect(await fire(garbage, '2026-10-01T10:00:00Z')).toMatchObject({ outcome: 'skipped', state: 'skipped_status' });
  });

  test('statuts par défaut sautés (erreur, action_requise), sain et warning exécutés ; liste étendue respectée', async () => {
    await resetSchedules();
    for (const [status, expected] of [['erreur', 'skipped_status'], ['action_requise', 'skipped_status'], ['sain', 'queued'], ['warning', 'queued']] as const) {
      const id = await newSchedule(await newApi(status));
      const outcome = await fire(id, '2026-10-01T10:00:00Z');
      expect((await runsOf(id))[0]!.state, status).toBe(expected);
      expect(outcome.outcome).toBe(expected === 'queued' ? 'run' : 'skipped');
    }
    const custom = await newSchedule(await newApi('warning'), { rules: { skip_if_status_in: ['bloquee', 'warning'] } });
    expect(await fire(custom, '2026-10-01T10:00:00Z')).toMatchObject({ state: 'skipped_status' });
  });

  test('désactivée ou propriétaire désactivé : aucun run tracé', async () => {
    await resetSchedules();
    const off = await newSchedule(await newApi(), { enabled: false });
    expect(await fire(off, '2026-10-01T10:00:00Z')).toEqual({ outcome: 'ignored', reason: 'disabled' });
    const ownerOff = await newSchedule(await newApi('sain', { ownerId: other }), { ownerId: other });
    expect(await fire(ownerOff, '2026-10-01T10:00:00Z')).toEqual({ outcome: 'ignored', reason: 'owner_inactive' });
    expect(await runsOf(off)).toHaveLength(0);
    expect(await runsOf(ownerOff)).toHaveLength(0);
  });

  test('overlap: skip → run ignoré avec raison ; allow → les deux ; le run terminé libère la planification', async () => {
    await resetSchedules();
    const skip = await newSchedule(await newApi(), { overlap: 'skip' });
    const first = await fire(skip, '2026-10-01T10:00:00Z');
    expect(first.outcome).toBe('run');
    expect(await fire(skip, '2026-10-01T10:01:00Z')).toMatchObject({ outcome: 'skipped', state: 'skipped_overlap', reason: 'previous_run_active' });
    await complete((first as { runId: string }).runId);
    expect((await fire(skip, '2026-10-01T10:02:00Z')).outcome).toBe('run');
    expect((await runsOf(skip)).map((r) => r.state)).toEqual(['succeeded', 'skipped_overlap', 'queued']);

    const allow = await newSchedule(await newApi(), { overlap: 'allow' });
    expect((await fire(allow, '2026-10-01T10:00:00Z')).outcome).toBe('run');
    expect((await fire(allow, '2026-10-01T10:01:00Z')).outcome).toBe('run');
  });

  test('overlap: queue → une occurrence attend, la suivante est ignorée, l\'attente aboutit quand le run se termine', async () => {
    await resetSchedules();
    const id = await newSchedule(await newApi(), { overlap: 'queue' });
    const first = (await fire(id, '2026-10-01T10:00:00Z')) as { runId: string };
    expect(await fire(id, '2026-10-01T10:01:00Z')).toEqual({ outcome: 'deferred', deferred: 1 });
    // Un seul report en attente par planification.
    expect(await fire(id, '2026-10-01T10:02:00Z')).toMatchObject({ outcome: 'skipped', state: 'skipped_overlap', reason: 'overlap_queue_full' });
    // Le report se représente encore tant que le run tourne : il ne crée rien (et se remet en file).
    expect(await fire(id, '2026-10-01T10:01:30Z', { deferred: 1 })).toMatchObject({ outcome: 'skipped', reason: 'overlap_queue_full' });
    await complete(first.runId);
    expect((await fire(id, '2026-10-01T10:02:30Z', { deferred: 2 })).outcome).toBe('run');
    // Trop d'attente : abandon.
    const stuck = await newSchedule(await newApi(), { overlap: 'queue' });
    await fire(stuck, '2026-10-01T10:00:00Z');
    expect(await fire(stuck, '2026-10-01T12:00:00Z', { deferred: 120 })).toMatchObject({ outcome: 'skipped', reason: 'deferred_too_long' });
  });

  test('fenêtre horaire dans le fuseau de la planification', async () => {
    await resetSchedules();
    const id = await newSchedule(await newApi(), { timezone: 'Europe/Paris', overlap: 'allow', rules: { window: { start: '08:00', end: '12:00' } } });
    // 07:30Z = 09:30 à Paris (UTC+2) : dans la fenêtre ; 10:30Z = 12:30 à Paris : hors fenêtre.
    expect((await fire(id, '2026-10-01T07:30:00Z')).outcome).toBe('run');
    expect(await fire(id, '2026-10-01T10:30:00Z')).toMatchObject({ outcome: 'skipped', state: 'skipped_window' });
  });

  test('quota journalier : compté sur le jour du fuseau, les runs ignorés ne comptent pas', async () => {
    await resetSchedules();
    const id = await newSchedule(await newApi(), { timezone: 'Europe/Paris', overlap: 'allow', rules: { max_runs_per_day: 2 } });
    // Jour de Paris du 02/10 : 02/10 00:00 à 24:00 heure de Paris = 01/10 22:00Z → 02/10 22:00Z.
    expect((await fire(id, '2026-10-01T22:30:00Z')).outcome).toBe('run'); // 00:30 le 02/10 à Paris
    expect((await fire(id, '2026-10-02T10:00:00Z')).outcome).toBe('run');
    expect(await fire(id, '2026-10-02T12:00:00Z')).toMatchObject({ outcome: 'skipped', state: 'skipped_quota' });
    expect(await fire(id, '2026-10-02T21:59:00Z')).toMatchObject({ outcome: 'skipped', state: 'skipped_quota' });
    // 22:00Z le 02/10 = 00:00 le 03/10 à Paris : nouveau jour, nouveau quota ; les `skipped_quota` n'ont rien consommé.
    expect((await fire(id, '2026-10-02T22:00:00Z')).outcome).toBe('run');
    expect((await fire(id, '2026-10-02T23:00:00Z')).outcome).toBe('run');
    expect(await fire(id, '2026-10-03T08:00:00Z')).toMatchObject({ state: 'skipped_quota' });
  });

  test('tunnel : only_if_tunnel_online ou requires.tunnel + extension hors ligne → skipped_tunnel_offline, statut inchangé', async () => {
    await resetSchedules();
    const apiRule = await newApi();
    const byRule = await newSchedule(apiRule, { rules: { only_if_tunnel_online: true }, overlap: 'allow' });
    const apiReq = await newApi('sain', { requiresTunnel: true });
    const byRequires = await newSchedule(apiReq, { overlap: 'allow' });
    const plainApi = await newSchedule(await newApi(), { overlap: 'allow' });
    const at = '2026-10-01T10:00:00Z';
    expect(await fire(byRule, at)).toMatchObject({ state: 'skipped_tunnel_offline' });
    expect(await fire(byRequires, at)).toMatchObject({ state: 'skipped_tunnel_offline' });
    expect((await fire(plainApi, at)).outcome).toBe('run');
    expect((await pool.query('SELECT status FROM apis WHERE id = $1', [apiRule])).rows[0].status).toBe('sain');
    expect((await pool.query('SELECT count(*)::int AS n FROM status_events WHERE api_id = $1', [apiRule])).rows[0].n).toBe(0);

    // Extension connectée (dernier signe de vie récent) : le run part ; périmé (> 60 s) : de nouveau ignoré.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tunnels (owner_id, device_id, token_hash, expires_at, last_seen_at)
       VALUES ($1, 'zz_test_device', $2, '2026-12-31T00:00:00Z', '2026-10-01T09:59:30Z') RETURNING id`,
      [owner, `zz_test_${randomUUID()}`],
    );
    expect((await fire(byRule, at)).outcome).toBe('run');
    expect(await fire(byRule, '2026-10-01T10:05:00Z')).toMatchObject({ state: 'skipped_tunnel_offline' });
    await pool.query("UPDATE tunnels SET last_seen_at = '2026-10-01T10:04:50Z', revoked_at = '2026-10-01T10:04:55Z' WHERE id = $1", [rows[0]!.id]);
    expect(await fire(byRule, '2026-10-01T10:05:00Z')).toMatchObject({ state: 'skipped_tunnel_offline' });
  });

  test('assert_schedule_tunnel_owner_bound : only_if_tunnel_online lit le tunnel du propriétaire de la planification (et du run), jamais celui du propriétaire de l\'API (INV5, INV12)', async () => {
    await resetSchedules();
    await pool.query("UPDATE tunnels SET revoked_at = '2026-10-01T00:00:00Z' WHERE revoked_at IS NULL");
    // API d'instance de `owner`, planifiée par `member` avec only_if_tunnel_online.
    const shared = await newApi();
    await pool.query("UPDATE apis SET visibility = 'instance' WHERE id = $1", [shared]);
    const theirs = await newSchedule(shared, { ownerId: member, rules: { only_if_tunnel_online: true }, overlap: 'allow' });
    const tunnel = async (ownerId: string) =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO tunnels (owner_id, device_id, token_hash, expires_at, last_seen_at)
           VALUES ($1, 'zz_test_device', $2, '2026-12-31T00:00:00Z', '2026-10-01T09:59:30Z') RETURNING id`,
          [ownerId, `zz_test_${randomUUID()}`],
        )
      ).rows[0]!.id;
    const at = '2026-10-01T10:00:00Z';
    // Extension du propriétaire de l'API connectée, celle du membre non : ignoré (aucun oracle sur l'activité d'un autre).
    const ownerTunnel = await tunnel(owner);
    expect(await fire(theirs, at)).toMatchObject({ outcome: 'skipped', state: 'skipped_tunnel_offline' });
    // Extension du membre connectée, celle du propriétaire de l'API coupée : le run part, pour le membre.
    await pool.query("UPDATE tunnels SET revoked_at = '2026-10-01T09:59:40Z' WHERE id = $1", [ownerTunnel]);
    const memberTunnel = await tunnel(member);
    expect((await fire(theirs, at)).outcome).toBe('run');
    const runs = await pool.query<{ owner_id: string; state: string }>('SELECT owner_id, state FROM runs WHERE schedule_id = $1 ORDER BY created_at', [theirs]);
    expect(runs.rows).toEqual([
      { owner_id: member, state: 'skipped_tunnel_offline' },
      { owner_id: member, state: 'queued' },
    ]);
    await pool.query("UPDATE tunnels SET revoked_at = '2026-10-01T10:00:00Z' WHERE id = $1", [memberTunnel]);
  });

  test('INV5 / INV12 : un déclenchement n\'élargit jamais l\'accès (API devenue privée ou à session : rien ne part)', async () => {
    await resetSchedules();
    const publicApi = await newApi();
    await pool.query("UPDATE apis SET visibility = 'instance' WHERE id = $1", [publicApi]);
    const theirs = await newSchedule(publicApi, { ownerId: member, overlap: 'allow' });
    // API d'instance sans session : le membre peut la planifier et la lancer.
    expect((await fire(theirs, '2026-10-01T10:00:00Z')).outcome).toBe('run');
    // Le propriétaire de l'API la remet en privé : la planification du membre ne déclenche plus rien.
    await pool.query("UPDATE apis SET visibility = 'private' WHERE id = $1", [publicApi]);
    expect(await fire(theirs, '2026-10-01T10:01:00Z')).toEqual({ outcome: 'ignored', reason: 'api_not_accessible' });
    // API d'instance qui exige une session : jamais pour un autre que son propriétaire (contrainte `apis_session_private`).
    const privateApi = await newApi();
    const foreign = await newSchedule(privateApi, { ownerId: member, overlap: 'allow' });
    expect(await fire(foreign, '2026-10-01T10:00:00Z')).toEqual({ outcome: 'ignored', reason: 'api_not_accessible' });
    // Le propriétaire de l'API garde la sienne, session comprise.
    await pool.query("UPDATE apis SET requires_session = true WHERE id = $1", [privateApi]);
    const mine = await newSchedule(privateApi, { overlap: 'allow' });
    expect((await fire(mine, '2026-10-01T10:00:00Z')).outcome).toBe('run');
    expect(await runsOf(foreign)).toHaveLength(0);
  });

  test('rejeu du même job : un seul run (aucun doublon, même après une reprise de pg-boss)', async () => {
    await resetSchedules();
    const id = await newSchedule(await newApi(), { overlap: 'allow' });
    const jobId = randomUUID();
    expect((await fire(id, '2026-10-01T10:00:00Z', { jobId })).outcome).toBe('run');
    expect(await fire(id, '2026-10-01T10:00:05Z', { jobId })).toEqual({ outcome: 'duplicate' });
    expect(await runsOf(id)).toHaveLength(1);
  });

  test('deux déclenchements simultanés de la même planification sont sérialisés (verrou de ligne)', async () => {
    await resetSchedules();
    const id = await newSchedule(await newApi(), { overlap: 'skip' });
    const outcomes = await Promise.all([fire(id, '2026-10-01T10:00:00Z'), fire(id, '2026-10-01T10:00:00Z'), fire(id, '2026-10-01T10:00:00Z')]);
    expect(outcomes.filter((o) => o.outcome === 'run')).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === 'skipped')).toHaveLength(2);
  });

  test('occurrence traitée en retard : `scheduled_at`, `{{today}}` et le quota suivent l\'occurrence, pas l\'heure du traitement', async () => {
    await resetSchedules();
    const id = await newSchedule(await newApi(), { cron: '59 23 * * *', overlap: 'allow', rules: { max_runs_per_day: 1 }, input: { day: '{{today}}', prev: '{{yesterday}}' } });
    // Occurrence du 09/03 à 23:59, émise par le cron à 23:59:00.4, traitée à 00:00:30 le 10/03 (file en retard).
    const late = (await fire(id, '2026-03-10T00:00:30Z', { occurredAt: '2026-03-09T23:59:00.400Z' })) as { outcome: string; runId: string };
    expect(late.outcome).toBe('run');
    const [run] = await runsOf(id);
    expect(run!.scheduled_at).toEqual(new Date('2026-03-09T23:59:00Z'));
    expect(run!.input).toEqual({ day: '2026-03-09', prev: '2026-03-08' });
    // Le run du 09/03 compte pour le 09/03 : l'occurrence du 10/03 a encore son quota.
    expect((await fire(id, '2026-03-10T23:59:02Z', { occurredAt: '2026-03-10T23:59:00.300Z' })).outcome).toBe('run');
    expect((await runsOf(id)).map((r) => (r.input as { day: string }).day)).toEqual(['2026-03-09', '2026-03-10']);
  });

  test('missed: once : rattrapage et occurrence courante émis ensemble : chacun son occurrence, le rattrapage garde son jour', async () => {
    await resetSchedules();
    const id = await newSchedule(await newApi(), { cron: '0 9 * * *', overlap: 'allow', onMissed: 'once', input: { day: '{{today}}' } });
    // Redéploiement le 12/03 à 09:00 : le cron émet l'occurrence manquée du 11/03 et celle du 12/03 dans le même passage.
    await fire(id, '2026-03-12T09:00:05Z', { occurredAt: '2026-03-12T09:00:01Z' });
    await fire(id, '2026-03-12T09:00:06Z', { occurredAt: '2026-03-12T09:00:01Z' });
    const runs = await runsOf(id);
    expect(runs.map((r) => r.scheduled_at.toISOString())).toEqual(['2026-03-11T09:00:00.000Z', '2026-03-12T09:00:00.000Z']);
    expect(runs.map((r) => (r.input as { day: string }).day)).toEqual(['2026-03-11', '2026-03-12']);
  });

  test('report (overlap: queue) : le job remis à plus tard porte son occurrence, le run garde l\'heure d\'origine', async () => {
    await resetSchedules();
    const id = await newSchedule(await newApi(), { overlap: 'queue', input: { day: '{{today}}' } });
    const first = (await fire(id, '2026-03-09T23:58:00Z')) as { runId: string };
    expect(await fire(id, '2026-03-09T23:59:00Z', { occurredAt: '2026-03-09T23:59:00.100Z' })).toEqual({ outcome: 'deferred', deferred: 1 });
    const deferred = (await pool.query<{ data: ScheduledRunJobData }>("SELECT data FROM pgboss.job WHERE name = 'scheduled-run-deferred' AND data->>'schedule_id' = $1", [id])).rows;
    expect(deferred.map((j) => j.data.occurrence_at)).toEqual(['2026-03-09T23:59:00.000Z']);
    await complete(first.runId);
    // Le report aboutit après minuit : le run garde l'occurrence du 09/03.
    expect((await fire(id, '2026-03-10T00:00:30Z', { deferred: 1, occurrenceAt: '2026-03-09T23:59:00.000Z' })).outcome).toBe('run');
    const last = (await runsOf(id)).at(-1)!;
    expect(last.scheduled_at).toEqual(new Date('2026-03-09T23:59:00Z'));
    expect(last.input).toEqual({ day: '2026-03-09' });
  });

  test('le run planifié appartient au propriétaire de la planification et porte son origine', async () => {
    await resetSchedules();
    const api = await newApi();
    const id = await newSchedule(api, { overlap: 'allow' });
    const out = (await fire(id, '2026-10-01T10:00:00Z')) as { runId: string };
    const row = (await pool.query('SELECT owner_id, api_owner_id, trigger, schedule_id, scheduled_at FROM runs WHERE id = $1', [out.runId])).rows[0];
    expect(row).toMatchObject({ owner_id: owner, api_owner_id: owner, trigger: 'schedule', schedule_id: id });
    expect(row.scheduled_at).toEqual(new Date('2026-10-01T10:00:00Z'));
    expect(RUN_QUEUE).toBe('run');
  });
});
