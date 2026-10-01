// SPDX-License-Identifier: AGPL-3.0-only
// INV3 sur base réelle : la transition et la ligne `status_events` sont écrites dans la même transaction.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { migrateUp } from './migrate.js';
import { applyStatusTransition, refreshStale } from './status.js';

const T0 = Date.parse('2026-10-01T10:00:00Z');
const clock = (ms = T0) => ({ now: () => new Date(ms) });

let tdb: TestDatabase;
let pool: pg.Pool;
let ownerId: string;

beforeAll(async () => {
  tdb = await createTestDatabase('status');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 3 });
  ownerId = (await pool.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [`zz_test_${randomBytes(4).toString('hex')}@example.test`])).rows[0]!.id;
});
afterAll(async () => {
  await pool.end();
  await tdb.drop();
});

async function newApi(status = 'enquete', extra: { cleanStreak?: number } = {}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO apis (slug, owner_id, status, clean_streak) VALUES ($1, $2, $3, $4) RETURNING id',
    [`zz_test_${randomBytes(5).toString('hex')}`, ownerId, status, extra.cleanStreak ?? 0],
  );
  return rows[0]!.id;
}
async function newRun(apiId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO runs (api_id, owner_id, api_owner_id, trigger) VALUES ($1, $2, $2, 'rest') RETURNING id",
    [apiId, ownerId],
  );
  return rows[0]!.id;
}
const api = async (id: string) =>
  (await pool.query<{ status: string; status_reason: string | null; clean_streak: number; last_signal_at: Date | null; stale: boolean }>(
    'SELECT status, status_reason, clean_streak, last_signal_at, stale FROM apis WHERE id = $1',
    [id],
  )).rows[0]!;
const events = async (id: string) =>
  (await pool.query<{ from_status: string | null; to_status: string; reason: string | null; run_id: string | null; at: Date }>(
    'SELECT from_status, to_status, reason, run_id, at FROM status_events WHERE api_id = $1 ORDER BY id',
    [id],
  )).rows;

describe('status_events : même transaction que apis.status (INV3)', () => {
  test('transition 1 : apis et status_events écrits ensemble, avec run_id et at', async () => {
    const id = await newApi();
    const runId = await newRun(id);
    const res = await applyStatusTransition(pool, { apiId: id, runId, event: { type: 'investigation_succeeded' }, clock: clock() });
    expect(res.ok).toBe(true);
    expect(await api(id)).toMatchObject({ status: 'sain', status_reason: 'strategy_conform', clean_streak: 0 });
    expect(await events(id)).toEqual([{ from_status: 'enquete', to_status: 'sain', reason: 'strategy_conform', run_id: runId, at: new Date(T0) }]);
  });

  test('refus pendant un rejeu : deux lignes (10 puis 15) dans l’ordre, statut final bloquee', async () => {
    const id = await newApi('sain');
    const runId = await newRun(id);
    await applyStatusTransition(pool, { apiId: id, runId, event: { type: 'run_failed', failureClass: 'forbidden' }, clock: clock() });
    expect(await api(id)).toMatchObject({ status: 'bloquee', status_reason: 'forbidden' });
    expect((await events(id)).map((e) => [e.from_status, e.to_status, e.reason])).toEqual([
      ['sain', 'reparation', 'forbidden'],
      ['reparation', 'bloquee', 'forbidden'],
    ]);
  });

  test('atomicité : si l’insertion de status_events échoue, apis est inchangée', async () => {
    const id = await newApi('sain');
    await expect(
      applyStatusTransition(pool, { apiId: id, runId: randomUUID(), event: { type: 'version_rollback' }, clock: clock() }),
    ).rejects.toThrow(/status_events_run_id_fkey|violates foreign key/);
    expect(await api(id)).toMatchObject({ status: 'sain', status_reason: null, last_signal_at: null });
    expect(await events(id)).toEqual([]);
  });

  test('événement rejeté ou sans transition : aucune écriture', async () => {
    const id = await newApi('sain');
    const rejected = await applyStatusTransition(pool, { apiId: id, event: { type: 'repair_succeeded' }, clock: clock() });
    expect(rejected).toMatchObject({ ok: false, rejected: 'not_repairing' });
    const clean = await applyStatusTransition(pool, { apiId: id, event: { type: 'run_succeeded', signals: [] }, clock: clock() });
    expect(clean).toMatchObject({ ok: true, transitions: [] });
    expect(await events(id)).toEqual([]);
    expect(await api(id)).toMatchObject({ status: 'sain' });
  });

  test('warning : clean_streak persisté sans ligne tant que le statut ne change pas, puis 9 à K = 3', async () => {
    const id = await newApi('warning', { cleanStreak: 0 });
    await pool.query('UPDATE apis SET last_signal_at = $2 WHERE id = $1', [id, new Date(T0)]);
    for (const expected of [1, 2]) {
      await applyStatusTransition(pool, { apiId: id, event: { type: 'run_succeeded', signals: [] }, clock: clock(T0 + 1000) });
      expect(await api(id)).toMatchObject({ status: 'warning', clean_streak: expected });
    }
    expect(await events(id)).toEqual([]);
    await applyStatusTransition(pool, { apiId: id, event: { type: 'run_succeeded', signals: [] }, clock: clock(T0 + 2000) });
    expect(await api(id)).toMatchObject({ status: 'sain', clean_streak: 0 });
    expect((await events(id)).map((e) => [e.from_status, e.to_status, e.reason])).toEqual([['warning', 'sain', 'clean_streak']]);
  });

  test('transition 21 : previous_status relu dans status_events, ancienne version gardée', async () => {
    const id = await newApi('warning');
    await applyStatusTransition(pool, { apiId: id, event: { type: 'reinvestigate', trigger: 'schema_changed' }, clock: clock() });
    expect(await api(id)).toMatchObject({ status: 'enquete', status_reason: 'output_schema_changed' });
    await applyStatusTransition(pool, { apiId: id, event: { type: 'investigation_failed', cause: 'budget_exhausted' }, clock: clock(T0 + 1) });
    expect(await api(id)).toMatchObject({ status: 'warning', status_reason: 'reinvestigation_failed' });
    expect((await events(id)).map((e) => [e.from_status, e.to_status, e.reason])).toEqual([
      ['warning', 'enquete', 'output_schema_changed'],
      ['enquete', 'warning', 'reinvestigation_failed'],
    ]);
  });

  test('sans statut précédent conforme (depuis erreur) : enquête sans résultat -> erreur (2), pas 21', async () => {
    const id = await newApi('erreur');
    await applyStatusTransition(pool, { apiId: id, event: { type: 'reinvestigate', trigger: 'manual' }, clock: clock() });
    await applyStatusTransition(pool, { apiId: id, event: { type: 'investigation_failed', cause: 'budget_exhausted' }, clock: clock(T0 + 1) });
    expect(await api(id)).toMatchObject({ status: 'erreur', status_reason: 'investigation_budget_exhausted' });
  });

  test('stale : drapeau mis à jour sans ligne status_events ni changement de statut', async () => {
    const id = await newApi('warning');
    const stale = await refreshStale(pool, id, { lastRunAt: T0, canaryFailing: false, breakConfirmed: false }, clock(T0 + 30 * 86_400_000));
    expect(stale).toBe(true);
    expect(await api(id)).toMatchObject({ status: 'warning', stale: true });
    expect(await events(id)).toEqual([]);
  });

  test('deux événements concurrents sur la même API : sérialisés par la ligne verrouillée', async () => {
    const id = await newApi('sain');
    const results = await Promise.all([
      applyStatusTransition(pool, { apiId: id, event: { type: 'run_failed', failureClass: 'transient' }, clock: clock() }),
      applyStatusTransition(pool, { apiId: id, event: { type: 'run_failed', failureClass: 'transient' }, clock: clock() }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await events(id)).map((e) => [e.from_status, e.to_status])).toEqual([['sain', 'warning'], ['warning', 'warning']]);
  });
});
