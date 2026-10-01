// SPDX-License-Identifier: AGPL-3.0-only
// Machine à états pure et déterministe : (état, événement, horloge injectée) -> (état, transitions). Aucune I/O.
import { quietPeriodMs, resetsCleanStreak, STATUS_THRESHOLDS } from './thresholds.js';
import {
  BACKOFF_CLASSES,
  BLOCKING_CLASSES,
  INVESTIGATION_ACTION_CLASSES,
  REPAIR_ACTION_CLASSES,
  type ApiStatusState,
  type DegradedSignal,
  type FailureClass,
  type MachineContext,
  type Status,
  type StatusEventInput,
  type StatusEventRow,
  type StatusStep,
  type TransitionId,
  type TransitionRecord,
} from './types.js';

export function initialStatusState(): ApiStatusState {
  return { status: 'enquete', reason: null, cleanStreak: 0, lastSignalAt: null, previousStatus: null, stale: false };
}

const includes = <T extends string>(list: readonly T[], value: string): value is T => (list as readonly string[]).includes(value);

type Hop = { id: TransitionId; to: Status; reason: string; patch?: Partial<ApiStatusState> };

function apply(state: ApiStatusState, ctx: MachineContext, hops: readonly Hop[]): StatusStep {
  const at = ctx.clock.now();
  let current = state;
  const transitions: TransitionRecord[] = [];
  for (const hop of hops) {
    transitions.push({ transition: hop.id, from: current.status, to: hop.to, reason: hop.reason, at });
    current = { ...current, ...hop.patch, status: hop.to, reason: hop.reason };
  }
  return { ok: true, state: current, transitions };
}

const reject = (state: ApiStatusState, rejected: string): StatusStep => ({ ok: false, state, transitions: [], rejected });
const unchanged = (state: ApiStatusState, patch: Partial<ApiStatusState> = {}): StatusStep => ({
  ok: true,
  state: { ...state, ...patch },
  transitions: [],
});

/**
 * Applique un événement. Un événement sans transition applicable est rejeté (`ok: false`, état inchangé) ;
 * un événement sans effet sur le statut (run propre en `sain`, `rate_limited`) renvoie `ok: true` sans transition.
 * Un refus pendant un rejeu (`sain` ou `warning`) produit deux transitions dans le même run : 10 ou 11, puis 14 ou 15,
 * sans jamais passer par l'agent de réparation.
 */
export function applyStatusEvent(state: ApiStatusState, event: StatusEventInput, ctx: MachineContext): StatusStep {
  const now = ctx.clock.now().getTime();
  const { status } = state;

  switch (event.type) {
    case 'investigation_succeeded':
      if (status !== 'enquete') return reject(state, 'not_investigating');
      return apply(state, ctx, [{ id: 1, to: 'sain', reason: 'strategy_conform', patch: { cleanStreak: 0, previousStatus: null } }]);

    case 'investigation_failed':
      if (status !== 'enquete') return reject(state, 'not_investigating');
      if (event.cause === 'budget_exhausted' && state.previousStatus !== null) {
        // 21 : ré-enquête d'une API existante sans stratégie conforme, ancienne version gardée.
        return apply(state, ctx, [{ id: 21, to: state.previousStatus, reason: 'reinvestigation_failed', patch: { previousStatus: null } }]);
      }
      return apply(state, ctx, [
        {
          id: 2,
          to: 'erreur',
          reason: event.cause === 'robots_unreachable' ? 'robots_unreachable' : 'investigation_budget_exhausted',
          patch: { previousStatus: null },
        },
      ]);

    case 'run_failed':
      return onRunFailed(state, event.failureClass, event.httpStatus, ctx, now);

    case 'run_succeeded':
      return onRunSucceeded(state, event.signals, ctx, now);

    case 'version_rollback':
      if (status === 'sain') return apply(state, ctx, [{ id: 7, to: 'warning', reason: 'version_rollback', patch: signalPatch(now, true) }]);
      if (status === 'warning') return apply(state, ctx, [{ id: 8, to: 'warning', reason: 'version_rollback', patch: signalPatch(now, true) }]);
      return reject(state, 'status_not_runnable');

    case 'repair_succeeded':
      if (status !== 'reparation') return reject(state, 'not_repairing');
      return apply(state, ctx, [{ id: 12, to: 'warning', reason: 'repaired', patch: signalPatch(now, true) }]);

    case 'repair_failed':
      if (status !== 'reparation') return reject(state, 'not_repairing');
      return apply(state, ctx, [
        { id: 13, to: 'erreur', reason: event.cause === 'repeated_patch' ? 'repair_repeated_patch' : 'repair_budget_exhausted' },
      ]);

    case 'reinvestigate': {
      const reason = event.trigger === 'manual' ? 'reinvestigate_manual' : event.trigger === 'schema_changed' ? 'output_schema_changed' : 'force_investigate';
      if (status === 'sain' || status === 'warning') {
        return apply(state, ctx, [{ id: status === 'sain' ? 19 : 20, to: 'enquete', reason, patch: { previousStatus: status } }]);
      }
      if (status === 'erreur' && (event.trigger === 'manual' || event.trigger === 'force_investigate')) {
        return apply(state, ctx, [{ id: 16, to: 'enquete', reason, patch: { previousStatus: null } }]);
      }
      // 18 : uniquement une ré-enquête manuelle. Jamais automatique, jamais déclenchée par un changement de schéma ou `force`.
      if (status === 'bloquee' && event.trigger === 'manual') {
        return apply(state, ctx, [{ id: 18, to: 'enquete', reason, patch: { previousStatus: null } }]);
      }
      return reject(state, status === 'bloquee' ? 'bloquee_manual_only' : 'status_not_reinvestigable');
    }

    case 'backoff_elapsed':
      if (status !== 'erreur') return reject(state, 'not_in_error');
      if (!includes(BACKOFF_CLASSES, event.failureClass)) return reject(state, 'backoff_class_not_allowed');
      if (!Number.isInteger(event.attempt) || event.attempt < 0 || event.attempt >= STATUS_THRESHOLDS.backoffDelaysMs.length) {
        return reject(state, 'backoff_exhausted');
      }
      return apply(state, ctx, [{ id: 16, to: 'enquete', reason: 'backoff', patch: { previousStatus: null } }]);

    case 'user_acted':
      if (status !== 'action_requise') return reject(state, 'no_action_required');
      return apply(state, ctx, [{ id: 17, to: 'enquete', reason: 'user_acted', patch: { previousStatus: null } }]);
  }
}

function signalPatch(now: number, resetStreak: boolean): Partial<ApiStatusState> {
  return resetStreak ? { cleanStreak: 0, lastSignalAt: now } : { lastSignalAt: now };
}

function onRunFailed(
  state: ApiStatusState,
  cls: FailureClass,
  httpStatus: number | undefined,
  ctx: MachineContext,
  now: number,
): StatusStep {
  // Garde INV6 : un 401, un 403 ou un 429 n'est jamais un échec réseau (04 §7).
  if (cls === 'network' && (httpStatus === 401 || httpStatus === 403 || httpStatus === 429)) {
    return reject(state, 'network_class_forbidden_for_http_status');
  }
  const { status } = state;
  const blocking = includes(BLOCKING_CLASSES, cls);
  const repairAction = includes(REPAIR_ACTION_CLASSES, cls);

  if (status === 'enquete') {
    if (includes(INVESTIGATION_ACTION_CLASSES, cls)) return apply(state, ctx, [{ id: 3, to: 'action_requise', reason: cls, patch: { previousStatus: null } }]);
    if (blocking) return apply(state, ctx, [{ id: 4, to: 'bloquee', reason: cls, patch: { previousStatus: null } }]);
    return reject(state, 'class_not_applicable');
  }
  if (status === 'reparation') {
    // Garde de classification : refus décidé dans le même run, sans agent de réparation.
    if (blocking) return apply(state, ctx, [{ id: 15, to: 'bloquee', reason: cls }]);
    if (repairAction) return apply(state, ctx, [{ id: 14, to: 'action_requise', reason: cls }]);
    return reject(state, 'class_not_applicable');
  }
  if (status !== 'sain' && status !== 'warning') return reject(state, 'status_not_runnable');

  if (cls === 'transient') {
    return apply(state, ctx, [{ id: status === 'sain' ? 6 : 8, to: 'warning', reason: 'unavailable', patch: signalPatch(now, true) }]);
  }
  if (cls === 'extraction' || cls === 'code_error' || cls === 'network' || cls === 'not_found' || blocking || repairAction) {
    const into: Hop = { id: status === 'sain' ? 10 : 11, to: 'reparation', reason: cls, patch: signalPatch(now, true) };
    if (blocking) return apply(state, ctx, [into, { id: 15, to: 'bloquee', reason: cls }]);
    if (repairAction) return apply(state, ctx, [into, { id: 14, to: 'action_requise', reason: cls }]);
    return apply(state, ctx, [into]);
  }
  // rate_limited (ralentir, disjoncteur), llm_*, tunnel_offline, proxy_not_configured, robots_unreachable (abstention) :
  // aucune transition dans les 21.
  return unchanged(state);
}

function onRunSucceeded(state: ApiStatusState, signals: readonly DegradedSignal[], ctx: MachineContext, now: number): StatusStep {
  const { status } = state;
  if (status !== 'sain' && status !== 'warning') return reject(state, 'status_not_runnable');
  if (signals.length === 0) {
    if (status === 'sain') return unchanged(state);
    const streak = state.cleanStreak + 1;
    const quiet = state.lastSignalAt === null || now - state.lastSignalAt >= quietPeriodMs(ctx.schedulePeriodMs);
    if (streak >= STATUS_THRESHOLDS.cleanStreakK) {
      return apply(state, ctx, [{ id: 9, to: 'sain', reason: 'clean_streak', patch: { cleanStreak: 0 } }]);
    }
    if (quiet) return apply(state, ctx, [{ id: 9, to: 'sain', reason: 'quiet_period', patch: { cleanStreak: 0 } }]);
    return unchanged(state, { cleanStreak: streak });
  }
  const reset = resetsCleanStreak(signals);
  const patch = signalPatch(now, reset);
  return apply(state, ctx, [{ id: status === 'sain' ? 5 : 8, to: 'warning', reason: signals[0] ?? '', patch }]);
}

/** Ligne `status_events` d'une transition : (from_status, to_status, reason, run_id, at). */
export function toStatusEventRow(transition: TransitionRecord, runId: string | null): StatusEventRow {
  return { from_status: transition.from, to_status: transition.to, reason: transition.reason, run_id: runId, at: transition.at };
}

export type RunGate =
  | { kind: 'run' }
  /** `erreur` : réponse immédiate `api_error` avec la dernière raison, aucun essai. Exception : `force_investigate`. */
  | { kind: 'api_error'; reason: string | null }
  /** `bloquee` : aucun run planifié (`skip_if_status_in` contient `bloquee`). */
  | { kind: 'skipped_status' }
  /** `robots_disallowed` : 0 requête sur le chemin (INV11). */
  | { kind: 'refused'; reason: 'robots_disallowed' };

export function gateRun(state: ApiStatusState, opts: { trigger: 'schedule' | 'on_demand'; forceInvestigate?: boolean }): RunGate {
  if (state.status === 'erreur' && opts.forceInvestigate !== true) return { kind: 'api_error', reason: state.reason };
  if (state.status === 'bloquee') {
    if (state.reason === 'robots_disallowed') return { kind: 'refused', reason: 'robots_disallowed' };
    if (opts.trigger === 'schedule') return { kind: 'skipped_status' };
  }
  return { kind: 'run' };
}

export type StaleInput = {
  /** Epoch ms de la dernière exécution, `null` si aucune. */
  lastRunAt: number | null;
  canaryFailing: boolean;
  /** Une casse confirmée n'est pas de l'obsolescence : la machine a déjà réagi. */
  breakConfirmed: boolean;
};

/** Drapeau `stale` (pas un état) : ne produit jamais de transition et ne touche jamais au statut. */
export function computeStale(input: StaleInput, ctx: MachineContext): boolean {
  const now = ctx.clock.now().getTime();
  const inactive = input.lastRunAt !== null && now - input.lastRunAt >= quietPeriodMs(ctx.schedulePeriodMs);
  return inactive || (input.canaryFailing && !input.breakConfirmed);
}

export function withStale(state: ApiStatusState, input: StaleInput, ctx: MachineContext): ApiStatusState {
  return { ...state, stale: computeStale(input, ctx) };
}
