// SPDX-License-Identifier: AGPL-3.0-only
// Files de la planification (T2 R4) et fréquence minimale du produit.

/** File unique des déclenchements (`key` pg-boss = `schedules.id`, jamais vide). */
export const SCHEDULED_RUN_QUEUE = 'scheduled-run';

/**
 * Charge d'un déclenchement : l'identifiant seul. Les règles sont relues en base (source de vérité), jamais copiées.
 * `deferred` : rang du report (`overlap: queue`), absent au premier passage.
 */
export type ScheduledRunJobData = { schedule_id: string; deferred?: number };

/** Fréquence minimale : 1 minute (08 § 5). */
export const MIN_SCHEDULE_PERIOD_MS = 60_000;
