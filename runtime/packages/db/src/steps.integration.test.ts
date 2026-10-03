// SPDX-License-Identifier: AGPL-3.0-only
// Reprise par étape et agent instruit (tâche 2.13, migration 0023, 19b §1) sur base réelle : journal par étape dans
// `run_attempts`, vN+1 non validée archivée non courante, `instructed_mode` jamais vrai sans étapes instruites confirmées
// par un humain (code ET déclencheur), propriétaire seul (RLS).
import { randomUUID } from 'node:crypto';
import { instructedStepsSha256, validateInstructedSteps } from '@runtime/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { loadMigrations, migrateDown, migrateUp } from './migrate.js';
import { withActor } from './rls.js';
import { recordAttempt } from './runs.js';
import { confirmInstructedSteps, readInstructedState, readStepAttempts, saveStepRepairedStrategy, setInstructedMode } from './steps.js';

const A = randomUUID();
const B = randomUUID();
let tdb: TestDatabase;
let pool: pg.Pool;

const STEPS = (() => {
  const v = validateInstructedSteps([
    { id: 'i1', intent: 'Ouvrir la liste des offres', post: [{ kind: 'element_present', role: 'heading', name: 'Offres' }] },
    { id: 'i2', intent: 'Lire chaque offre', post: [] },
  ]);
  if (!v.ok) throw new Error('étapes');
  return v.steps;
})();

async function newApi(slug: string, opts: { compilable?: 'yes' | 'unknown' | 'no'; instructed?: boolean } = {}): Promise<string> {
  const id = (await pool.query<{ id: string }>("INSERT INTO apis (slug, owner_id, output_schema) VALUES ($1, $2, '{}'::jsonb) RETURNING id", [slug, A])).rows[0]!.id;
  await pool.query(
    `INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, created_by, compilable, instructed_steps, instructed_steps_sha256)
     VALUES ($1, 1, $2, 'agent', 'direct', '{}'::jsonb, 'investigation', $3, $4::jsonb, $5)`,
    [id, A, opts.compilable ?? 'no', opts.instructed === false ? null : JSON.stringify(STEPS), opts.instructed === false ? null : instructedStepsSha256(STEPS)],
  );
  await pool.query('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [id]);
  return id;
}

beforeAll(async () => {
  tdb = await createTestDatabase('steps');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 4 });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_steps_a@example.test', 'active'), ($2, 'zz_test_steps_b@example.test', 'active')", [A, B]);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await tdb?.drop();
});

describe('migration 0023 (reprise par étape, agent instruit)', () => {
  test('défauts : instructed_mode faux, compilable inconnu, colonnes d’étape nulles', async () => {
    const api = (await pool.query<{ id: string }>("INSERT INTO apis (slug, owner_id, output_schema) VALUES ('zz_test_defaults', $1, '{}'::jsonb) RETURNING id", [A])).rows[0]!.id;
    const { rows } = await pool.query<{ instructed_mode: boolean }>('SELECT instructed_mode FROM apis WHERE id = $1', [api]);
    expect(rows[0]!.instructed_mode).toBe(false);
    await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, created_by) VALUES ($1, 1, $2, 'hybrid', 'direct', 'investigation')", [api, A]);
    const sv = await pool.query<{ compilable: string; archive_reason: string | null }>('SELECT compilable, archive_reason FROM strategy_versions WHERE api_id = $1', [api]);
    expect(sv.rows[0]).toEqual({ compilable: 'unknown', archive_reason: null });
    await expect(pool.query("UPDATE strategy_versions SET compilable = 'peut-être' WHERE api_id = $1", [api])).rejects.toThrow();
  });

  test('down puis up : la migration se défait proprement', async () => {
    const other = await createTestDatabase('steps_down');
    try {
      await migrateUp({ connectionString: other.url });
      // Jusqu'à step_repair inclus (les migrations suivantes, 0024_i18n de 3.20 comprise, se défont d'abord).
      const target = loadMigrations().find((m) => m.name === 'step_repair')!.version;
      await migrateDown({ connectionString: other.url, steps: loadMigrations().filter((m) => m.version >= target).length });
      const c = new pg.Client({ connectionString: other.url });
      await c.connect();
      const { rows } = await c.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'apis' AND column_name = 'instructed_mode'");
      await c.end();
      expect(rows).toHaveLength(0);
      await migrateUp({ connectionString: other.url });
    } finally {
      await other.drop();
    }
  });
});

describe('assert_instructed_mode_explicit (base)', () => {
  test('activer l’agent instruit sans confirmer les étapes laisse instructed_mode: false (code et déclencheur)', async () => {
    const api = await newApi('zz_test_instructed_unconfirmed');
    expect(await setInstructedMode(pool, { apiId: api, ownerId: A, enabled: true })).toEqual({ ok: false, reason: 'instructed_steps_unconfirmed' });
    expect((await readInstructedState(pool, { apiId: api, ownerId: A }))?.instructed_mode).toBe(false);
    // Contourner le code : le déclencheur refuse encore.
    await expect(withActor(pool, { userId: A, role: 'member' }, (tx) => tx.query('UPDATE apis SET instructed_mode = true WHERE id = $1', [api]))).rejects.toThrow(/instructed_mode/);
  });

  test('confirmation humaine avec l’empreinte des étapes affichées, puis activation ; empreinte périmée refusée', async () => {
    const api = await newApi('zz_test_instructed_confirmed');
    expect(await confirmInstructedSteps(pool, { apiId: api, ownerId: A, userId: A, version: 1, sha256: 'f'.repeat(64) })).toEqual({ ok: false, reason: 'sha_mismatch' });
    expect(await confirmInstructedSteps(pool, { apiId: api, ownerId: A, userId: A, version: 1, sha256: instructedStepsSha256(STEPS) })).toEqual({ ok: true });
    expect(await setInstructedMode(pool, { apiId: api, ownerId: A, enabled: true })).toEqual({ ok: true });
    const state = await readInstructedState(pool, { apiId: api, ownerId: A });
    expect(state).toMatchObject({ instructed_mode: true, compilable: 'no', confirmed_by: A });
    expect(state?.estimated_run_usd).toBeCloseTo(0.04, 6);
    // Les étapes changent (refine, réparation) : la confirmation ne vaut plus, le mode retombe.
    const changed = [...STEPS, { id: 'i3', intent: 'Nouvelle étape', post: [] }];
    await pool.query('UPDATE strategy_versions SET instructed_steps = $2::jsonb, instructed_steps_sha256 = $3 WHERE api_id = $1 AND version = 1', [api, JSON.stringify(changed), instructedStepsSha256(changed)]);
    expect((await readInstructedState(pool, { apiId: api, ownerId: A }))?.instructed_mode).toBe(false);
    expect(await setInstructedMode(pool, { apiId: api, ownerId: A, enabled: false })).toEqual({ ok: true });
    // Étapes changées SANS changer l'empreinte (écriture directe) : la confirmation tombe aussi.
    await confirmInstructedSteps(pool, { apiId: api, ownerId: A, userId: A, version: 1, sha256: instructedStepsSha256(changed) });
    expect(await setInstructedMode(pool, { apiId: api, ownerId: A, enabled: true })).toEqual({ ok: true });
    await pool.query("UPDATE strategy_versions SET instructed_steps = '[{\"id\":\"i9\",\"intent\":\"Autre\",\"post\":[]}]'::jsonb WHERE api_id = $1 AND version = 1", [api]);
    const after = await readInstructedState(pool, { apiId: api, ownerId: A });
    expect(after).toMatchObject({ instructed_mode: false, confirmed_by: null });
  });

  test('API compilable : le mode ne s’active pas ; B ne touche pas l’API de A', async () => {
    const api = await newApi('zz_test_instructed_compilable', { compilable: 'yes' });
    await confirmInstructedSteps(pool, { apiId: api, ownerId: A, userId: A, version: 1, sha256: instructedStepsSha256(STEPS) });
    expect(await setInstructedMode(pool, { apiId: api, ownerId: A, enabled: true })).toEqual({ ok: false, reason: 'compilable' });
    const mine = await newApi('zz_test_instructed_owner');
    expect(await confirmInstructedSteps(pool, { apiId: mine, ownerId: B, userId: B, version: 1, sha256: instructedStepsSha256(STEPS) })).toEqual({ ok: false, reason: 'not_found' });
    expect(await setInstructedMode(pool, { apiId: mine, ownerId: B, enabled: true })).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('vN+1 de reprise et journal par étape', () => {
  test('repair_not_validated : vN+1 archivée non courante, courante inchangée ; validée : courante', async () => {
    const api = await newApi('zz_test_step_versions', { compilable: 'yes', instructed: false });
    const archived = await saveStepRepairedStrategy(pool, { apiId: api, ownerId: A, parentVersion: 1, network: 'direct', spec: { kind: 'steps' }, patch: [{ op: 'replace', path: '/steps/2/target', value: {} }], validated: false });
    expect(archived).toEqual({ version: 2, promoted: false });
    const v2 = await pool.query<{ archive_reason: string; created_by: string; compilable: string }>('SELECT archive_reason, created_by, compilable FROM strategy_versions WHERE api_id = $1 AND version = 2', [api]);
    expect(v2.rows[0]).toEqual({ archive_reason: 'repair_not_validated', created_by: 'repair', compilable: 'yes' });
    expect((await pool.query<{ v: number }>('SELECT current_strategy_version AS v FROM apis WHERE id = $1', [api])).rows[0]!.v).toBe(1);
    const promoted = await saveStepRepairedStrategy(pool, { apiId: api, ownerId: A, parentVersion: 1, network: 'direct', spec: { kind: 'steps' }, patch: [], validated: true });
    expect(promoted).toEqual({ version: 3, promoted: true });
  });

  test('run_attempts : step_id, step_level, step_outcome, jetons et coût par étape ; valeurs fermées', async () => {
    const api = await newApi('zz_test_step_attempts', { compilable: 'yes', instructed: false });
    const jobId = randomUUID();
    const runId = (
      await pool.query<{ id: string }>("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, job_id, strategy_version) VALUES ($1, $2, $2, 'rest', 'running', $3, 1) RETURNING id", [api, A, jobId])
    ).rows[0]!.id;
    const run = { runId };
    const claimed = { jobId };
    await recordAttempt(pool, run.runId, claimed!.jobId, { execution: 'hybrid', network: 'direct', est_cost_usd: 0, result: 'ok', ms: 10, llm_usd: 0.004, tokens: { in: 120, out: 30 }, step: { id: 's3', level: 2, outcome: 'agent_repaired' } });
    await recordAttempt(pool, run.runId, claimed!.jobId, { execution: 'hybrid', network: 'direct', est_cost_usd: 0, result: 'extraction', ms: 10, step: { id: 's5', level: 1, outcome: 'failed' } });
    const steps = await readStepAttempts(pool, { runId: run.runId, ownerId: A });
    expect(steps).toEqual([
      { seq: 1, step_id: 's3', step_level: 2, step_outcome: 'agent_repaired', tokens_in: 120, tokens_out: 30, cost_usd: 0.004 },
      { seq: 2, step_id: 's5', step_level: 1, step_outcome: 'failed', tokens_in: 0, tokens_out: 0, cost_usd: 0 },
    ]);
    expect(await readStepAttempts(pool, { runId: run.runId, ownerId: B })).toEqual([]);
    await expect(pool.query("UPDATE run_attempts SET step_outcome = 'magic' WHERE run_id = $1", [run.runId])).rejects.toThrow();
    await expect(pool.query('UPDATE run_attempts SET step_level = 4 WHERE run_id = $1', [run.runId])).rejects.toThrow();
  });
});
