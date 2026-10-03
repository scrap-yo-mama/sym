// SPDX-License-Identifier: AGPL-3.0-only
// Étape 0 sur base réelle (tâche 1.11, migration 0015) : le rapport d'accès précède tout essai, et un rapport qui arrête
// l'enquête (refus du site, 402) interdit tout essai ensuite ; 402 mène à `action_requise` (transition 3). Migration 0022
// (D-91) : `access_policy.robots` n'est plus exigé ; une politique écrite avant le garde, sans effet.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { AccessReportFirstError, appendInvestigationEvent, listInvestigationEvents, recordAccessReport } from './investigation-events.js';
import { migrateDown, migrateUp } from './migrate.js';
import { withActor } from './rls.js';
import { applyStatusTransition } from './status.js';

const clock = { now: () => new Date() };
let tdb: TestDatabase;
let pool: pg.Pool;
let ownerId: string;
let otherId: string;

const user = async () =>
  (await pool.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [`zz_test_${randomBytes(4).toString('hex')}@example.test`])).rows[0]!.id;

beforeAll(async () => {
  tdb = await createTestDatabase('access_report');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 3 });
  ownerId = await user();
  otherId = await user();
});
afterAll(async () => {
  await pool.end();
  await tdb.drop();
});

async function newInvestigation(): Promise<{ apiId: string; runId: string }> {
  const apiId = (await pool.query<{ id: string }>('INSERT INTO apis (slug, owner_id, status) VALUES ($1, $2, $3) RETURNING id', [`zz_test_${randomBytes(5).toString('hex')}`, ownerId, 'enquete'])).rows[0]!.id;
  const runId = (await pool.query<{ id: string }>("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger) VALUES ($1, $2, $2, 'rest') RETURNING id", [apiId, ownerId])).rows[0]!.id;
  return { apiId, runId };
}

const report = (proceed: boolean, failureClass?: string) => ({
  verdict: proceed ? { proceed: true } : { proceed: false, failure: { failure_class: failureClass, retryable: false, detail: failureClass }, status: 'bloquee' },
});

describe('assert_access_report_first : l’événement access_report précède tout essai (étape 0)', () => {
  test('un essai avant le rapport est refusé par la base ; après un rapport favorable, il passe', async () => {
    const { runId } = await newInvestigation();
    await expect(appendInvestigationEvent(pool, { runId, ownerId, kind: 'attempt.finished', payload: { execution: 'fetch' } })).rejects.toBeInstanceOf(AccessReportFirstError);
    await expect(appendInvestigationEvent(pool, { runId, ownerId, kind: 'reconnaissance.started' })).rejects.toBeInstanceOf(AccessReportFirstError);
    // Les événements de cadre (début d'enquête) peuvent précéder le rapport ; ils ne sont pas des essais.
    expect(await appendInvestigationEvent(pool, { runId, ownerId, kind: 'investigation.started' })).toEqual({ seq: 1 });
    expect(await recordAccessReport(pool, { runId, ownerId, payload: report(true) })).toEqual({ seq: 2 });
    expect(await appendInvestigationEvent(pool, { runId, ownerId, kind: 'attempt.finished', payload: { execution: 'fetch' } })).toEqual({ seq: 3 });
    const events = await listInvestigationEvents(pool, { runId, ownerId });
    expect(events.map((e) => e.kind)).toEqual(['investigation.started', 'access_report', 'attempt.finished']);
    const firstAttempt = events.findIndex((e) => e.kind.startsWith('attempt'));
    const accessReport = events.findIndex((e) => e.kind === 'access_report');
    expect(accessReport).toBeGreaterThanOrEqual(0);
    expect(accessReport).toBeLessThan(firstAttempt);
  });

  test('rapport qui arrête l’enquête (refus du site) : plus aucun essai possible', async () => {
    const { runId } = await newInvestigation();
    await recordAccessReport(pool, { runId, ownerId, payload: report(false, 'forbidden') });
    await expect(appendInvestigationEvent(pool, { runId, ownerId, kind: 'attempt.started' })).rejects.toBeInstanceOf(AccessReportFirstError);
    expect((await listInvestigationEvents(pool, { runId, ownerId })).map((e) => e.kind)).toEqual(['access_report']);
  });

  test('un rapport sans verdict est refusé', async () => {
    const { runId } = await newInvestigation();
    await expect(recordAccessReport(pool, { runId, ownerId, payload: { signals: [] } })).rejects.toBeInstanceOf(AccessReportFirstError);
  });

  test('le récit reste celui du propriétaire (RLS) : un autre utilisateur n’écrit ni ne lit', async () => {
    const { runId } = await newInvestigation();
    await recordAccessReport(pool, { runId, ownerId, payload: report(true) });
    await expect(appendInvestigationEvent(pool, { runId, ownerId: otherId, kind: 'attempt.finished' })).rejects.toThrow(/introuvable/);
    expect(await listInvestigationEvents(pool, { runId, ownerId: otherId })).toEqual([]);
  });
});

// Revue de 1.11 : la garde « jusque dans la base » ne couvrait que l'insertion. Le récit est en ajout seul : ni le kind,
// ni le seq, ni le run d'un événement ne changent ; un rapport qui arrête l'enquête ne devient jamais favorable ; aucune
// suppression directe (le récit part avec son run, ON DELETE CASCADE). La purge (charges vidées, 17 §6) et l'effacement
// d'un sujet (valeurs remplacées) restent possibles.
describe('assert_access_report_first : récit en ajout seul (UPDATE et DELETE gardés)', () => {
  const actor = () => ({ userId: ownerId, role: 'member' as const });
  const asApp = (sql: string, params: unknown[]) => withActor(pool, actor(), (tx) => tx.query(sql, params));
  const APPEND_ONLY = { constraint: 'investigation_events_append_only' };

  test('rapport défavorable : jamais rendu favorable, jamais supprimé ; kind et seq figés', async () => {
    const { runId } = await newInvestigation();
    await recordAccessReport(pool, { runId, ownerId, payload: report(false, 'blocked_by_protection') });
    await expect(asApp(`UPDATE investigation_events SET payload = jsonb_set(payload, '{verdict,proceed}', 'true') WHERE run_id = $1`, [runId])).rejects.toMatchObject(APPEND_ONLY);
    await expect(asApp(`UPDATE investigation_events SET payload = '{"verdict":{"proceed":true}}' WHERE run_id = $1`, [runId])).rejects.toMatchObject(APPEND_ONLY);
    await expect(asApp('DELETE FROM investigation_events WHERE run_id = $1', [runId])).rejects.toMatchObject(APPEND_ONLY);
    await expect(asApp("UPDATE investigation_events SET kind = 'note' WHERE run_id = $1", [runId])).rejects.toMatchObject(APPEND_ONLY);
    await expect(asApp('UPDATE investigation_events SET seq = seq + 10 WHERE run_id = $1', [runId])).rejects.toMatchObject(APPEND_ONLY);
    // Même hors runtime_app (propriétaire du schéma) : la garde est un déclencheur.
    await expect(pool.query('DELETE FROM investigation_events WHERE run_id = $1', [runId])).rejects.toMatchObject(APPEND_ONLY);
    await expect(appendInvestigationEvent(pool, { runId, ownerId, kind: 'attempt.started' })).rejects.toBeInstanceOf(AccessReportFirstError);
  });

  test('un événement de cadre n’est pas renommé en essai après coup', async () => {
    const { runId } = await newInvestigation();
    await appendInvestigationEvent(pool, { runId, ownerId, kind: 'investigation.started' });
    await expect(asApp("UPDATE investigation_events SET kind = 'attempt.finished' WHERE run_id = $1", [runId])).rejects.toMatchObject(APPEND_ONLY);
  });

  test('purge des charges et effacement d’un sujet possibles ; le récit part avec son run', async () => {
    const { runId } = await newInvestigation();
    await recordAccessReport(pool, { runId, ownerId, payload: report(true) });
    await appendInvestigationEvent(pool, { runId, ownerId, kind: 'attempt.finished', payload: { sample: 'alice@example.test' } });
    await asApp(`UPDATE investigation_events SET payload = jsonb_set(payload, '{sample}', '"[erased]"') WHERE run_id = $1 AND kind = 'attempt.finished'`, [runId]);
    await pool.query("UPDATE investigation_events SET payload = '{}'::jsonb WHERE run_id = $1", [runId]);
    // Rapport vidé par la purge : plus de verdict, donc plus aucun essai.
    await expect(appendInvestigationEvent(pool, { runId, ownerId, kind: 'attempt.started' })).rejects.toBeInstanceOf(AccessReportFirstError);
    await asApp('DELETE FROM runs WHERE id = $1', [runId]);
    expect((await pool.query('SELECT count(*)::int AS n FROM investigation_events WHERE run_id = $1', [runId])).rows[0]).toEqual({ n: 0 });
  });
});

describe('classes du module d’accès → statut (transitions existantes, toujours 21) ; D-91 : valeurs historiques lisibles', () => {
  test('payment_required → action_requise (transition 3)', async () => {
    const b = await newInvestigation();
    expect((await applyStatusTransition(pool, { apiId: b.apiId, runId: b.runId, event: { type: 'run_failed', failureClass: 'payment_required', httpStatus: 402 }, clock })).ok).toBe(true);
    expect((await pool.query('SELECT status FROM apis WHERE id = $1', [b.apiId])).rows[0]).toMatchObject({ status: 'action_requise' });
  });

  test('migration 0022 : access_policy sans robots par défaut, ancienne clé gardée telle quelle, contrainte retirée', async () => {
    const { apiId } = await newInvestigation();
    const { rows } = await pool.query<{ access_policy: Record<string, unknown> }>('SELECT access_policy FROM apis WHERE id = $1', [apiId]);
    expect(rows[0]!.access_policy).toEqual({ on_ai_signal: 'warn', intended_use: 'context', prefer_official: true, payment: { mode: 'never' } });
    await pool.query(`UPDATE apis SET access_policy = access_policy || '{"robots": "respect"}' WHERE id = $1`, [apiId]);
    expect((await pool.query<{ r: string }>(`SELECT access_policy ->> 'robots' AS r FROM apis WHERE id = $1`, [apiId])).rows[0]!.r).toBe('respect');
    const { rowCount } = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname = 'apis_access_policy_robots'`);
    expect(rowCount).toBe(0);
  });

  test('valeurs historiques robots_disallowed et robots_unreachable : toujours admises en base (lignes anciennes lisibles)', async () => {
    const { runId } = await newInvestigation();
    await pool.query("UPDATE runs SET state = 'failed', failure_class = 'robots_disallowed' WHERE id = $1", [runId]);
    await pool.query("INSERT INTO run_attempts (run_id, seq, owner_id, execution, network, result_class) VALUES ($1, 1, $2, 'fetch', 'direct', 'robots_unreachable')", [runId, ownerId]);
    expect((await pool.query<{ failure_class: string }>('SELECT failure_class FROM runs WHERE id = $1', [runId])).rows[0]!.failure_class).toBe('robots_disallowed');
  });

  test('migration 0022 : aller-retour down/up, contrainte et défaut de 0021 rétablis puis retirés, sans réécrire de donnée', async () => {
    const { apiId } = await newInvestigation();
    const constraints = async () => (await pool.query("SELECT 1 FROM pg_constraint WHERE conname = 'apis_access_policy_robots'")).rowCount;
    expect(await constraints()).toBe(0);
    await migrateDown({ connectionString: tdb.url, steps: 1 });
    expect(await constraints()).toBe(1);
    expect((await pool.query<{ r: string }>("SELECT access_policy ->> 'robots' AS r FROM apis WHERE id = $1", [apiId])).rows[0]!.r).toBe('respect');
    await migrateUp({ connectionString: tdb.url });
    expect(await constraints()).toBe(0);
    expect((await pool.query<{ r: string | null }>("SELECT access_policy ->> 'robots' AS r FROM apis WHERE id = $1", [apiId])).rows[0]!.r).toBe('respect');
  });
});
