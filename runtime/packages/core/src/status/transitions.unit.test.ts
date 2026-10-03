// SPDX-License-Identifier: AGPL-3.0-only
// assert_status_transitions (INV3, tâche 1.2) : un test nommé par transition de 04 §6, plus règles transverses.
import { describe, expect, test } from 'vitest';
import {
  applyStatusEvent,
  backoffDelayMs,
  computeStale,
  costAnomaly,
  gateRun,
  initialStatusState,
  optionalFieldsMissing,
  quietPeriodMs,
  slowRun,
  toStatusEventRow,
  TRANSITIONS,
  TRANSITION_COUNT,
  volumeAnomaly,
  withStale,
  type ApiStatusState,
  type MachineContext,
  type Status,
  type StatusEventInput,
  type TransitionId,
} from './index.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-01T10:00:00Z');
const ctxAt = (ms: number, schedulePeriodMs: number | null = null): MachineContext => ({ clock: { now: () => new Date(ms) }, schedulePeriodMs });
const ctx = ctxAt(T0);
const st = (status: Status, patch: Partial<ApiStatusState> = {}): ApiStatusState => ({ ...initialStatusState(), status, ...patch });

/** Applique un événement attendu valide et renvoie les transitions sous forme [id, from, to, reason]. */
function run(state: ApiStatusState, event: StatusEventInput, c: MachineContext = ctx) {
  const step = applyStatusEvent(state, event, c);
  if (!step.ok) throw new Error(`événement rejeté : ${step.rejected}`);
  return { state: step.state, path: step.transitions.map((t) => [t.transition, t.from, t.to, t.reason] as const) };
}

describe('assert_status_transitions', () => {
  test('transition_01_enquete_to_sain', () => {
    const r = run(st('enquete'), { type: 'investigation_succeeded' });
    expect(r.path).toEqual([[1, 'enquete', 'sain', 'strategy_conform']]);
    expect(r.state.status).toBe('sain');
  });

  test('transition_02_enquete_to_erreur', () => {
    expect(run(st('enquete'), { type: 'investigation_failed', cause: 'budget_exhausted' }).path).toEqual([
      [2, 'enquete', 'erreur', 'investigation_budget_exhausted'],
    ]);
    expect(run(st('enquete'), { type: 'investigation_failed', cause: 'robots_unreachable' }).path).toEqual([
      [2, 'enquete', 'erreur', 'robots_unreachable'],
    ]);
  });

  test('transition_03_enquete_to_action_requise', () => {
    for (const cls of ['auth_required', 'payment_required', 'account_limit'] as const) {
      expect(run(st('enquete'), { type: 'run_failed', failureClass: cls }).path).toEqual([[3, 'enquete', 'action_requise', cls]]);
    }
    // Proxy requis non configuré, tunnel hors ligne : codes de raison, pas des failure_class.
    for (const reason of ['proxy_not_configured', 'tunnel_offline'] as const) {
      expect(run(st('enquete'), { type: 'run_stopped', reason }).path).toEqual([[3, 'enquete', 'action_requise', reason]]);
    }
  });

  test('transition_04_enquete_to_bloquee', () => {
    for (const cls of ['blocked_by_protection', 'forbidden', 'robots_disallowed'] as const) {
      expect(run(st('enquete'), { type: 'run_failed', failureClass: cls }).path).toEqual([[4, 'enquete', 'bloquee', cls]]);
    }
  });

  test('transition_05_sain_to_warning_degraded', () => {
    const r = run(st('sain'), { type: 'run_succeeded', signals: ['escalated', 'retried'] });
    expect(r.path).toEqual([[5, 'sain', 'warning', 'escalated']]);
    expect(r.state.cleanStreak).toBe(0);
    expect(r.state.lastSignalAt).toBe(T0);
  });

  test('transition_06_sain_to_warning_unavailable', () => {
    expect(run(st('sain'), { type: 'run_failed', failureClass: 'transient' }).path).toEqual([[6, 'sain', 'warning', 'unavailable']]);
  });

  test('transition_07_sain_to_warning_version_rollback', () => {
    expect(run(st('sain'), { type: 'version_rollback' }).path).toEqual([[7, 'sain', 'warning', 'version_rollback']]);
  });

  test('transition_08_warning_to_warning', () => {
    const base = st('warning', { cleanStreak: 2 });
    for (const [event, reason] of [
      [{ type: 'run_succeeded', signals: ['volume_anomaly'] }, 'volume_anomaly'],
      [{ type: 'run_failed', failureClass: 'transient' }, 'unavailable'],
      [{ type: 'version_rollback' }, 'version_rollback'],
    ] as const) {
      const r = run(base, event);
      expect(r.path).toEqual([[8, 'warning', 'warning', reason]]);
      expect(r.state.cleanStreak).toBe(0);
    }
  });

  test('transition_09_warning_to_sain', () => {
    // Branche K : 2 runs propres déjà, le troisième repasse en sain.
    const byStreak = run(st('warning', { cleanStreak: 2, lastSignalAt: T0 }), { type: 'run_succeeded', signals: [] });
    expect(byStreak.path).toEqual([[9, 'warning', 'sain', 'clean_streak']]);
    expect(byStreak.state.cleanStreak).toBe(0);
    // Branche délai : API hebdomadaire, D = 21 j ; à 8 j elle reste warning, à 22 j elle repasse en sain.
    const week = 7 * DAY;
    const at8 = run(st('warning', { lastSignalAt: T0 }), { type: 'run_succeeded', signals: [] }, ctxAt(T0 + 8 * DAY, week));
    expect(at8.path).toEqual([]);
    expect(at8.state).toMatchObject({ status: 'warning', cleanStreak: 1 });
    const at22 = run(st('warning', { lastSignalAt: T0 }), { type: 'run_succeeded', signals: [] }, ctxAt(T0 + 22 * DAY, week));
    expect(at22.path).toEqual([[9, 'warning', 'sain', 'quiet_period']]);
  });

  test('transition_10_sain_to_reparation', () => {
    for (const cls of ['extraction', 'code_error'] as const) {
      expect(run(st('sain'), { type: 'run_failed', failureClass: cls }).path).toEqual([[10, 'sain', 'reparation', cls]]);
    }
  });

  test('transition_11_warning_to_reparation', () => {
    expect(run(st('warning'), { type: 'run_failed', failureClass: 'extraction' }).path).toEqual([[11, 'warning', 'reparation', 'extraction']]);
  });

  test('transition_12_reparation_to_warning', () => {
    const r = run(st('reparation'), { type: 'repair_succeeded' });
    expect(r.path).toEqual([[12, 'reparation', 'warning', 'repaired']]);
    expect(r.state.cleanStreak).toBe(0);
  });

  test('transition_13_reparation_to_erreur', () => {
    expect(run(st('reparation'), { type: 'repair_failed', cause: 'budget_exhausted' }).path).toEqual([
      [13, 'reparation', 'erreur', 'repair_budget_exhausted'],
    ]);
    expect(run(st('reparation'), { type: 'repair_failed', cause: 'repeated_patch' }).path).toEqual([
      [13, 'reparation', 'erreur', 'repair_repeated_patch'],
    ]);
  });

  test('transition_14_reparation_to_action_requise', () => {
    for (const cls of ['auth_required', 'payment_required', 'account_limit'] as const) {
      expect(run(st('reparation'), { type: 'run_failed', failureClass: cls }).path).toEqual([[14, 'reparation', 'action_requise', cls]]);
    }
    // Défi en tunnel : code de raison, pas une failure_class.
    expect(run(st('reparation'), { type: 'run_stopped', reason: 'challenge_in_tunnel' }).path).toEqual([
      [14, 'reparation', 'action_requise', 'challenge_in_tunnel'],
    ]);
  });

  test('transition_15_reparation_to_bloquee', () => {
    for (const cls of ['blocked_by_protection', 'forbidden', 'robots_disallowed'] as const) {
      expect(run(st('reparation'), { type: 'run_failed', failureClass: cls }).path).toEqual([[15, 'reparation', 'bloquee', cls]]);
    }
  });

  test('transition_16_erreur_to_enquete', () => {
    for (const cls of ['extraction', 'code_error', 'network', 'robots_unreachable'] as const) {
      expect(run(st('erreur'), { type: 'backoff_elapsed', failureClass: cls, attempt: 0 }).path).toEqual([[16, 'erreur', 'enquete', 'backoff']]);
    }
    expect(run(st('erreur'), { type: 'reinvestigate', trigger: 'manual' }).path).toEqual([[16, 'erreur', 'enquete', 'reinvestigate_manual']]);
    // Le backoff est réservé à quatre classes et s'arrête après 1 h, 6 h, 24 h.
    for (const cls of ['forbidden', 'blocked_by_protection', 'auth_required', 'transient'] as const) {
      expect(applyStatusEvent(st('erreur'), { type: 'backoff_elapsed', failureClass: cls, attempt: 0 }, ctx).ok).toBe(false);
    }
    expect(applyStatusEvent(st('erreur'), { type: 'backoff_elapsed', failureClass: 'extraction', attempt: 3 }, ctx).ok).toBe(false);
  });

  test('transition_17_action_requise_to_enquete', () => {
    expect(run(st('action_requise'), { type: 'user_acted' }).path).toEqual([[17, 'action_requise', 'enquete', 'user_acted']]);
  });

  test('transition_18_bloquee_to_enquete_manual_only', () => {
    expect(run(st('bloquee'), { type: 'reinvestigate', trigger: 'manual' }).path).toEqual([
      [18, 'bloquee', 'enquete', 'reinvestigate_manual'],
    ]);
    // Jamais automatique : ni backoff, ni changement de schéma, ni `force`, ni action de l'utilisateur.
    const events: StatusEventInput[] = [
      { type: 'backoff_elapsed', failureClass: 'extraction', attempt: 0 },
      { type: 'reinvestigate', trigger: 'schema_changed' },
      { type: 'reinvestigate', trigger: 'force_investigate' },
      { type: 'reinvestigate', trigger: 'rules_changed' },
      { type: 'user_acted' },
    ];
    for (const event of events) {
      const step = applyStatusEvent(st('bloquee', { reason: 'forbidden' }), event, ctx);
      expect(step.ok).toBe(false);
      expect(step.state.status).toBe('bloquee');
    }
  });

  test('transition_19_sain_to_enquete', () => {
    for (const [trigger, reason] of [
      ['manual', 'reinvestigate_manual'],
      ['schema_changed', 'output_schema_changed'],
      ['force_investigate', 'force_investigate'],
      ['rules_changed', 'rules_changed'],
    ] as const) {
      const r = run(st('sain'), { type: 'reinvestigate', trigger });
      expect(r.path).toEqual([[19, 'sain', 'enquete', reason]]);
      expect(r.state.previousStatus).toBe('sain');
    }
  });

  test('transition_20_warning_to_enquete', () => {
    const r = run(st('warning', { cleanStreak: 1 }), { type: 'reinvestigate', trigger: 'schema_changed' });
    expect(r.path).toEqual([[20, 'warning', 'enquete', 'output_schema_changed']]);
    expect(r.state).toMatchObject({ previousStatus: 'warning', cleanStreak: 1 });
  });

  test('transition_21_enquete_to_previous_status', () => {
    for (const previous of ['sain', 'warning'] as const) {
      const reinvestigating = run(st(previous, { cleanStreak: 1, lastSignalAt: T0 }), { type: 'reinvestigate', trigger: 'manual' }).state;
      const r = run(reinvestigating, { type: 'investigation_failed', cause: 'budget_exhausted' });
      expect(r.path).toEqual([[21, 'enquete', previous, 'reinvestigation_failed']]);
      expect(r.state).toMatchObject({ status: previous, previousStatus: null, cleanStreak: 1, lastSignalAt: T0 });
    }
    // Sans statut précédent (première enquête, ou depuis erreur / action / blocage) : transition 2.
    expect(run(st('enquete'), { type: 'investigation_failed', cause: 'budget_exhausted' }).path[0]?.[0]).toBe(2);
    const fromError = run(run(st('erreur'), { type: 'reinvestigate', trigger: 'manual' }).state, { type: 'investigation_failed', cause: 'budget_exhausted' });
    expect(fromError.path[0]?.[0]).toBe(2);
  });

  test('la table compte exactement 21 transitions, numérotées 1 à 21, avec des raisons en codes stables', () => {
    expect(TRANSITIONS).toHaveLength(TRANSITION_COUNT);
    expect(TRANSITIONS.map((t) => t.id)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
    for (const t of TRANSITIONS) for (const reason of t.reasons) expect(reason).toMatch(/^[a-z_]+$/);
  });

  test('refus pendant un rejeu : 10 ou 11 puis 14 ou 15 dans le même run, journalisé avec sa classe', () => {
    expect(run(st('sain'), { type: 'run_failed', failureClass: 'blocked_by_protection' }).path).toEqual([
      [10, 'sain', 'reparation', 'blocked_by_protection'],
      [15, 'reparation', 'bloquee', 'blocked_by_protection'],
    ]);
    expect(run(st('warning'), { type: 'run_failed', failureClass: 'forbidden' }).path).toEqual([
      [11, 'warning', 'reparation', 'forbidden'],
      [15, 'reparation', 'bloquee', 'forbidden'],
    ]);
    expect(run(st('sain'), { type: 'run_failed', failureClass: 'robots_disallowed' }).path.map((p) => p[0])).toEqual([10, 15]);
    expect(run(st('warning'), { type: 'run_failed', failureClass: 'auth_required' }).path).toEqual([
      [11, 'warning', 'reparation', 'auth_required'],
      [14, 'reparation', 'action_requise', 'auth_required'],
    ]);
    expect(run(st('sain'), { type: 'run_stopped', reason: 'challenge_in_tunnel' }).path.map((p) => p[0])).toEqual([10, 14]);
  });

  test('un 401, un 403 ou un 429 ne produit jamais la classe network', () => {
    for (const httpStatus of [401, 403, 429]) {
      const step = applyStatusEvent(st('sain'), { type: 'run_failed', failureClass: 'network', httpStatus }, ctx);
      expect(step).toMatchObject({ ok: false, rejected: 'network_class_forbidden_for_http_status' });
    }
    expect(applyStatusEvent(st('sain'), { type: 'run_failed', failureClass: 'network', httpStatus: 451 }, ctx).ok).toBe(true);
  });

  test('aucun effet sur le statut : rate_limited, llm_*, budgets de run, tunnel déconnecté, run propre en sain', () => {
    const events: StatusEventInput[] = [
      ...(['rate_limited', 'llm_refused', 'run_budget_exceeded', 'budget_exceeded'] as const).map(
        (failureClass) => ({ type: 'run_failed', failureClass }) as const,
      ),
      { type: 'run_stopped', reason: 'tunnel_offline' },
      { type: 'run_stopped', reason: 'proxy_not_configured' },
    ];
    for (const event of events) {
      const step = applyStatusEvent(st('sain'), event, ctx);
      expect(step).toMatchObject({ ok: true, transitions: [] });
      expect(step.state.status).toBe('sain');
    }
    expect(run(st('sain'), { type: 'run_succeeded', signals: [] }).path).toEqual([]);
  });

  test('slow seul ne remet pas clean_streak à 0 ; tout autre signal le remet à 0', () => {
    expect(run(st('warning', { cleanStreak: 2 }), { type: 'run_succeeded', signals: ['slow'] }).state.cleanStreak).toBe(2);
    expect(run(st('warning', { cleanStreak: 2 }), { type: 'run_succeeded', signals: ['slow', 'retried'] }).state.cleanStreak).toBe(0);
  });

  test('le 404 et les classes à réparation passent par reparation ; not_found aussi', () => {
    expect(run(st('sain'), { type: 'run_failed', failureClass: 'not_found' }).path).toEqual([[10, 'sain', 'reparation', 'not_found']]);
  });

  test('événement d\'un mauvais état : rejeté, état inchangé', () => {
    const before = st('sain');
    const step = applyStatusEvent(before, { type: 'repair_succeeded' }, ctx);
    expect(step).toMatchObject({ ok: false, rejected: 'not_repairing', transitions: [] });
    expect(step.state).toBe(before);
  });

  test('toStatusEventRow : from_status, to_status, reason, run_id, at', () => {
    const step = applyStatusEvent(st('sain'), { type: 'version_rollback' }, ctx);
    expect(step.transitions.map((t) => toStatusEventRow(t, 'run-1'))).toEqual([
      { from_status: 'sain', to_status: 'warning', reason: 'version_rollback', run_id: 'run-1', at: new Date(T0) },
    ]);
  });

  test('erreur répond api_error sans essai, sauf force_investigate ; bloquee ne tourne pas en planifié ; robots_disallowed : 0 requête', () => {
    const erreur = st('erreur', { reason: 'repair_budget_exhausted' });
    expect(gateRun(erreur, { trigger: 'on_demand' })).toEqual({ kind: 'api_error', reason: 'repair_budget_exhausted' });
    expect(gateRun(erreur, { trigger: 'on_demand', forceInvestigate: true })).toEqual({ kind: 'run' });
    expect(gateRun(st('bloquee', { reason: 'forbidden' }), { trigger: 'schedule' })).toEqual({ kind: 'skipped_status' });
    expect(gateRun(st('bloquee', { reason: 'robots_disallowed' }), { trigger: 'on_demand', forceInvestigate: true })).toEqual({
      kind: 'refused',
      reason: 'robots_disallowed',
    });
    expect(gateRun(st('sain'), { trigger: 'schedule' })).toEqual({ kind: 'run' });
  });
});

describe('drapeau stale : jamais une transition', () => {
  test('inactif depuis D : stale vrai, statut et compteurs inchangés', () => {
    const before = st('warning', { cleanStreak: 1, reason: 'retried', lastSignalAt: T0 });
    const c = ctxAt(T0 + 30 * DAY);
    expect(computeStale({ lastRunAt: T0, canaryFailing: false, breakConfirmed: false }, c)).toBe(true);
    const after = withStale(before, { lastRunAt: T0, canaryFailing: false, breakConfirmed: false }, c);
    expect(after).toEqual({ ...before, stale: true });
  });

  test('canari en échec sans casse confirmée : stale ; casse confirmée : pas stale', () => {
    expect(computeStale({ lastRunAt: T0, canaryFailing: true, breakConfirmed: false }, ctx)).toBe(true);
    expect(computeStale({ lastRunAt: T0, canaryFailing: true, breakConfirmed: true }, ctx)).toBe(false);
  });

  test('actif et sans canari en échec : pas stale', () => {
    expect(computeStale({ lastRunAt: T0 - DAY, canaryFailing: false, breakConfirmed: false }, ctx)).toBe(false);
  });
});

describe('seuils', () => {
  test('D = max(7 j, 3 × période)', () => {
    expect(quietPeriodMs(null)).toBe(7 * DAY);
    expect(quietPeriodMs(DAY)).toBe(7 * DAY);
    expect(quietPeriodMs(7 * DAY)).toBe(21 * DAY);
  });

  test('optional_fields_missing : chute d\'au moins 20 points', () => {
    expect(optionalFieldsMissing(90, 71)).toBe(false);
    expect(optionalFieldsMissing(90, 70)).toBe(true);
  });

  test('volume_anomaly : moins de 50 % de la médiane après 5 runs', () => {
    expect(volumeAnomaly(49, 100, 5)).toBe(true);
    expect(volumeAnomaly(50, 100, 5)).toBe(false);
    expect(volumeAnomaly(10, 100, 4)).toBe(false);
  });

  test('slow : > 3 × médiane et > 30 s d\'écart, sur 2 runs consécutifs', () => {
    expect(slowRun([200_000, 200_000], 50_000)).toBe(true);
    expect(slowRun([10_000, 200_000], 50_000)).toBe(false);
    expect(slowRun([200_000], 50_000)).toBe(false);
    expect(slowRun([20_000, 20_000], 5_000)).toBe(false);
  });

  test('cost_anomaly : > 3 × coût médian', () => {
    expect(costAnomaly(0.031, 0.01)).toBe(true);
    expect(costAnomaly(0.03, 0.01)).toBe(false);
  });

  test('tentative de persistance (D-49, 2.16) : 16 puis 1 ou 21, 4 ou 3 sur un refus, aucune transition nouvelle', () => {
    const attempt = (cls: 'extraction' | 'code_error' | 'network' | 'robots_unreachable' = 'extraction') => run(st('erreur', { reason: 'repair_budget_exhausted' }), { type: 'persistence_attempt', failureClass: cls });
    for (const cls of ['extraction', 'code_error', 'network', 'robots_unreachable'] as const) {
      expect(attempt(cls).path).toEqual([[16, 'erreur', 'enquete', 'persistence_attempt']]);
    }
    expect(attempt().state.previousStatus).toBe('erreur');
    // Échec (budget d'enquête épuisé, robots.txt injoignable, 451) : 21, retour à `erreur`, jamais la 2.
    for (const cause of ['budget_exhausted', 'robots_unreachable'] as const) {
      const failed = run(attempt().state, { type: 'investigation_failed', cause });
      expect(failed.path).toEqual([[21, 'enquete', 'erreur', 'reinvestigation_failed']]);
      expect(failed.state).toMatchObject({ status: 'erreur', previousStatus: null });
    }
    expect(run(attempt().state, { type: 'investigation_succeeded' }).path).toEqual([[1, 'enquete', 'sain', 'strategy_conform']]);
    expect(run(attempt().state, { type: 'run_failed', failureClass: 'forbidden', httpStatus: 403 }).path).toEqual([[4, 'enquete', 'bloquee', 'forbidden']]);
    expect(run(attempt().state, { type: 'run_failed', failureClass: 'auth_required', httpStatus: 401 }).path).toEqual([[3, 'enquete', 'action_requise', 'auth_required']]);
    // Jamais depuis `bloquee`, `action_requise`, ni hors `erreur` ; jamais pour une classe hors de la transition 16.
    for (const status of ['bloquee', 'action_requise', 'sain', 'warning', 'reparation', 'enquete'] as const) {
      expect(applyStatusEvent(st(status), { type: 'persistence_attempt', failureClass: 'extraction' }, ctx).ok).toBe(false);
    }
    for (const cls of ['forbidden', 'blocked_by_protection', 'robots_disallowed', 'auth_required', 'not_found', 'llm_refused', 'transient'] as const) {
      expect(applyStatusEvent(st('erreur'), { type: 'persistence_attempt', failureClass: cls }, ctx).ok).toBe(false);
    }
    // 16 garde ses raisons : la tentative en est une de plus, la table reste à 21 transitions (22 avec 3.14).
    expect(TRANSITIONS.find((t) => t.id === 16)?.reasons).toContain('persistence_attempt');
    expect(TRANSITIONS).toHaveLength(21);
  });

  test('backoff 1 h, 6 h, 24 h avec jitter ±20 %, puis arrêt', () => {
    expect(backoffDelayMs(0, () => 0.5)).toBe(3_600_000);
    expect(backoffDelayMs(1, () => 0)).toBe(Math.round(6 * 3_600_000 * 0.8));
    expect(backoffDelayMs(2, () => 1)).toBe(Math.round(24 * 3_600_000 * 1.2));
    expect(backoffDelayMs(3, () => 0.5)).toBeNull();
  });
});

// Garde de typage : les ids de transition couvrent exactement 1..21.
const _ids: TransitionId[] = TRANSITIONS.map((t) => t.id);
void _ids;
