// Cycle de vie d'un run (04b § 1, 03 § Services « Flux d'un run », 14 § 1) : transitions permises, états terminaux,
// politique de reprise après la perte d'un worker (T2 R4). Fonctions pures, sans I/O.
import type { RunState } from '../model/enums.js';

/** États actifs : un worker tient (ou va tenir) le run. Le balayeur ne regarde qu'eux. */
export const ACTIVE_RUN_STATES = ['queued', 'running', 'waiting_tunnel'] as const satisfies readonly RunState[];
export type ActiveRunState = (typeof ACTIVE_RUN_STATES)[number];

/** États posés à la création sans job (planification, 2.5) : le run est tracé mais n'entre jamais en file. */
export const SKIPPED_RUN_STATES = [
  'skipped_tunnel_offline',
  'skipped_window',
  'skipped_quota',
  'skipped_status',
  'skipped_overlap',
] as const satisfies readonly RunState[];
export type SkippedRunState = (typeof SKIPPED_RUN_STATES)[number];

export const TERMINAL_RUN_STATES = ['succeeded', 'failed', 'cancelled', ...SKIPPED_RUN_STATES] as const satisfies readonly RunState[];
export type TerminalRunState = (typeof TERMINAL_RUN_STATES)[number];

/**
 * Transitions permises. `running → queued` et `waiting_tunnel → queued` : remise en file (balayeur après la perte du
 * worker, ou arrêt SIGTERM au-delà du délai). `queued → failed` : job perdu et reprise épuisée.
 */
const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['succeeded', 'failed', 'cancelled', 'waiting_tunnel', 'queued'],
  waiting_tunnel: ['running', 'succeeded', 'failed', 'cancelled', 'queued', 'skipped_tunnel_offline'],
  succeeded: [],
  failed: [],
  cancelled: [],
  skipped_tunnel_offline: [],
  skipped_window: [],
  skipped_quota: [],
  skipped_status: [],
  skipped_overlap: [],
};

export function isTerminalRunState(state: RunState): state is TerminalRunState {
  return (TERMINAL_RUN_STATES as readonly RunState[]).includes(state);
}

export function isSkippedRunState(state: RunState): state is SkippedRunState {
  return (SKIPPED_RUN_STATES as readonly RunState[]).includes(state);
}

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Nombre de remises en file autorisées après la perte d'un worker (T2 R4) : 1 pour une API en lecture, **0** si
 * `allow_write_actions` (rejouer une écriture est dangereux). Au-delà, le run passe `failed` (`transient`, `worker_lost`).
 */
export function maxRunRequeues(api: { allow_write_actions: boolean }): number {
  return api.allow_write_actions ? 0 : 1;
}

/** Code d'erreur stable d'un run abandonné par son worker (balayeur) ou coupé par l'arrêt (SIGTERM). */
export const RUN_LOST_DETAIL = 'worker_lost';
export const RUN_SHUTDOWN_DETAIL = 'worker_shutdown';
