// SPDX-License-Identifier: AGPL-3.0-only
// Reprise par étape et agent instruit (tâche 2.13, migration 0018, 19 §4, 19b §1) : écritures et lectures comme le
// PROPRIÉTAIRE de l'API (RLS, INV12).
// - vN+1 d'une reprise par étape : courante seulement si les portes V0 à V5 passent ; sinon archivée non courante
//   (`archive_reason = repair_not_validated`), la version courante est gardée ;
// - `instructed_mode` : opt-in explicite, jamais vrai sans étapes instruites confirmées par un humain sur leur empreinte
//   exacte (le déclencheur de 0018 le refuse aussi) ; une confirmation porte l'empreinte des étapes AFFICHÉES ;
// - journal par étape (`run_attempts.step_*`) pour le panneau « Reprises ».
import { canActivateInstructedMode, estimateInstructedRunUsd, instructedStepsSha256, validateInstructedSteps, type InstructedActivation, type InstructedStep, type Network, type StepOutcome, type StrategyCompilable } from '@runtime/core';
import type pg from 'pg';
import { withActor } from './rls.js';

/** vN+1 d'une reprise par étape (`created_by = repair`, `compilable = yes` : rejouée sans LLM). */
export async function saveStepRepairedStrategy(
  pool: pg.Pool,
  args: { apiId: string; ownerId: string; parentVersion: number; network: Network; spec: unknown; patch: unknown[]; validated: boolean; estCostUsd?: number | null },
): Promise<{ version: number; promoted: boolean }> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const locked = await tx.query<{ current_strategy_version: number | null; project_id: string }>('SELECT current_strategy_version, project_id FROM apis WHERE id = $1 AND owner_id = $2 FOR UPDATE', [
      args.apiId,
      args.ownerId,
    ]);
    const current = locked.rows[0];
    if (current === undefined) throw new Error('API introuvable pour le propriétaire');
    const version = (await tx.query<{ v: number }>('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM strategy_versions WHERE api_id = $1', [args.apiId])).rows[0]!.v;
    await tx.query(
      // La source des étapes (intent, pre, post) est reprise de la version parente : `post` est immuable en réparation.
      `INSERT INTO strategy_versions (api_id, version, owner_id, project_id, execution, network, spec, est_cost_usd, created_by, parent_version, patch, compilable, archive_reason, source_steps)
       VALUES ($1, $2, $3, $4, 'hybrid', $5, $6, $7, 'repair', $8, $9::jsonb, 'yes', $10,
               (SELECT source_steps FROM strategy_versions WHERE api_id = $1 AND version = $8))`,
      [args.apiId, version, args.ownerId, current.project_id, args.network, JSON.stringify(args.spec), args.estCostUsd ?? null, args.parentVersion, JSON.stringify(args.patch), args.validated ? null : 'repair_not_validated'],
    );
    const promoted = args.validated && current.current_strategy_version === args.parentVersion;
    // Une version compilée (rejouée sans LLM) devient courante : le mode « agent instruit » n'a plus lieu d'être (2.13).
    if (promoted) await tx.query('UPDATE apis SET current_strategy_version = $2, instructed_mode = false WHERE id = $1', [args.apiId, version]);
    return { version, promoted };
  });
}

/** Une trace E6 n'a pas pu être compilée en E5 : la version est `compilable = no` (seul l'agent instruit la rejoue). */
export async function markStrategyCompilable(pool: pg.Pool, args: { apiId: string; ownerId: string; version: number; compilable: StrategyCompilable }): Promise<void> {
  await withActor(pool, { userId: args.ownerId, role: 'member' }, (tx) => tx.query('UPDATE strategy_versions SET compilable = $3 WHERE api_id = $1 AND version = $2', [args.apiId, args.version, args.compilable]));
}

export type InstructedState = {
  readonly instructed_mode: boolean;
  readonly version: number;
  readonly compilable: StrategyCompilable;
  readonly steps: readonly InstructedStep[] | null;
  readonly sha256: string | null;
  readonly confirmed_by: string | null;
  readonly confirmed_at: string | null;
  /** Coût estimé d'un run instruit, affiché avant chaque lancement (plafond, 19 §4). */
  readonly estimated_run_usd: number | null;
};

type Row = { instructed_mode: boolean; version: number | null; compilable: StrategyCompilable | null; instructed_steps: unknown; instructed_steps_sha256: string | null; instructed_steps_confirmed: { by?: string | null; at?: string | null; sha256?: string } | null };

async function readRow(tx: Pick<pg.ClientBase, 'query'>, apiId: string): Promise<Row | null> {
  const { rows } = await tx.query<Row>(
    `SELECT a.instructed_mode, s.version, s.compilable, s.instructed_steps, s.instructed_steps_sha256, s.instructed_steps_confirmed
       FROM apis a LEFT JOIN strategy_versions s ON s.api_id = a.id AND s.version = a.current_strategy_version
      WHERE a.id = $1`,
    [apiId],
  );
  return rows[0] ?? null;
}

const stepsOf = (raw: unknown): InstructedStep[] | null => {
  if (raw === null || raw === undefined) return null;
  const v = validateInstructedSteps(raw);
  return v.ok ? v.steps : null;
};

/** État du mode « agent instruit » de l'API (version courante), lu comme le propriétaire ; `null` : API invisible. */
export async function readInstructedState(pool: pg.Pool, args: { apiId: string; ownerId: string }): Promise<InstructedState | null> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const r = await readRow(tx, args.apiId);
    if (r === null || r.version === null) return null;
    const steps = stepsOf(r.instructed_steps);
    return {
      instructed_mode: r.instructed_mode,
      version: r.version,
      compilable: r.compilable ?? 'unknown',
      steps,
      sha256: r.instructed_steps_sha256,
      confirmed_by: r.instructed_steps_confirmed?.by ?? null,
      confirmed_at: r.instructed_steps_confirmed?.at ?? null,
      estimated_run_usd: steps === null ? null : estimateInstructedRunUsd(steps),
    };
  });
}

/**
 * Confirmation HUMAINE des étapes instruites (console ou élicitation : l'appelant l'a vérifié) : `sha256` est l'empreinte
 * des étapes affichées ; une empreinte différente de celle des étapes stockées est refusée (étapes changées entre-temps).
 */
export async function confirmInstructedSteps(
  pool: pg.Pool,
  args: { apiId: string; ownerId: string; userId: string; version: number; sha256: string },
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'no_instructed_steps' | 'sha_mismatch' }> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const { rows } = await tx.query<{ instructed_steps: unknown; instructed_steps_sha256: string | null }>(
      'SELECT s.instructed_steps, s.instructed_steps_sha256 FROM strategy_versions s JOIN apis a ON a.id = s.api_id WHERE s.api_id = $1 AND s.version = $2 AND a.owner_id = $3 FOR UPDATE OF s',
      [args.apiId, args.version, args.ownerId],
    );
    const row = rows[0];
    if (row === undefined) return { ok: false, reason: 'not_found' };
    const steps = stepsOf(row.instructed_steps);
    if (steps === null || steps.length === 0) return { ok: false, reason: 'no_instructed_steps' };
    const actual = instructedStepsSha256(steps);
    if (row.instructed_steps_sha256 !== actual || args.sha256 !== actual) return { ok: false, reason: 'sha_mismatch' };
    await tx.query('UPDATE strategy_versions SET instructed_steps_confirmed = $3::jsonb WHERE api_id = $1 AND version = $2', [
      args.apiId,
      args.version,
      JSON.stringify({ by: args.userId, at: new Date().toISOString(), sha256: actual }),
    ]);
    return { ok: true };
  });
}

/** Active ou désactive le mode ; l'activation exige `canActivateInstructedMode` (sinon `instructed_mode` reste faux). */
export async function setInstructedMode(
  pool: pg.Pool,
  args: { apiId: string; ownerId: string; enabled: boolean },
): Promise<{ ok: true } | { ok: false; reason: Exclude<InstructedActivation, { ok: true }>['reason'] | 'not_found' }> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const owned = await tx.query('SELECT 1 FROM apis WHERE id = $1 AND owner_id = $2 FOR UPDATE', [args.apiId, args.ownerId]);
    if (owned.rowCount !== 1) return { ok: false, reason: 'not_found' };
    if (!args.enabled) {
      await tx.query('UPDATE apis SET instructed_mode = false WHERE id = $1', [args.apiId]);
      return { ok: true };
    }
    const r = await readRow(tx, args.apiId);
    if (r === null || r.version === null) return { ok: false, reason: 'not_found' };
    const c = r.instructed_steps_confirmed;
    const decision = canActivateInstructedMode({
      compilable: r.compilable ?? 'unknown',
      steps: stepsOf(r.instructed_steps),
      confirmation: c === null ? null : { by: c.by ?? null, at: c.at ?? null, sha256: c.sha256 ?? '' },
    });
    if (!decision.ok) return decision;
    await tx.query('UPDATE apis SET instructed_mode = true WHERE id = $1', [args.apiId]);
    return { ok: true };
  });
}

export type StepAttemptRow = {
  readonly seq: number;
  readonly step_id: string;
  readonly step_level: number | null;
  readonly step_outcome: StepOutcome;
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly cost_usd: number | null;
};

/** Journal par étape d'un run (panneau « Reprises »), lu comme le propriétaire du run. */
export async function readStepAttempts(pool: pg.Pool, args: { runId: string; ownerId: string }): Promise<StepAttemptRow[]> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const { rows } = await tx.query<{ seq: number; step_id: string; step_level: number | null; step_outcome: StepOutcome; tokens_in: string; tokens_out: string; cost_usd: string | null }>(
      'SELECT seq, step_id, step_level, step_outcome, tokens_in, tokens_out, cost_usd FROM run_attempts WHERE run_id = $1 AND step_id IS NOT NULL ORDER BY seq',
      [args.runId],
    );
    return rows.map((r) => ({ seq: r.seq, step_id: r.step_id, step_level: r.step_level, step_outcome: r.step_outcome, tokens_in: Number(r.tokens_in), tokens_out: Number(r.tokens_out), cost_usd: r.cost_usd === null ? null : Number(r.cost_usd) }));
  });
}

/** Runs réussis d'une version (agent instruit : tentative de compilation après K runs réussis, 19 §4). */
export async function countSucceededRuns(pool: pg.Pool, args: { apiId: string; ownerId: string; version: number }): Promise<number> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const { rows } = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM runs WHERE api_id = $1 AND strategy_version = $2 AND state = 'succeeded'", [args.apiId, args.version]);
    return rows[0]?.n ?? 0;
  });
}
