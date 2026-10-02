// SPDX-License-Identifier: AGPL-3.0-only
// Réconciliation périodique de l'usage (cdc/sym-browser 04d § 4.4, tâche 2.6) : toutes les heures (à valider), la passerelle
// rapproche `usage_records` des journaux usage.wal des nœuds joignables (`reconcileUsage` de @sym-browser/db, sous verrou
// consultatif : une seule passerelle agit). L'écart est rendu à `onReport` (jauge `symb_usage_drift_seconds`) ; un écart
// non nul est signalé à `onDrift` (journal `warn`), après correction.
import { systemClock, type Clock, type TimerHandle } from '@sym-browser/core';
import type { UsageReconciliation } from '@sym-browser/db';

export const USAGE_RECONCILE_INTERVAL_MS = 3_600_000;

export type UsageReconcilerOptions = {
  run: () => Promise<UsageReconciliation>;
  clock?: Clock;
  intervalMs?: number;
  onReport?: (report: UsageReconciliation) => void;
  onDrift?: (report: UsageReconciliation) => void;
  onError?: (error: unknown) => void;
};

export function hasDrift(report: UsageReconciliation): boolean {
  return report.driftSeconds > 0 || report.driftBytes > 0 || report.remainingDriftSeconds > 0 || report.remainingDriftBytes > 0;
}

export function startUsageReconciler(options: UsageReconcilerOptions): { stop: () => void } {
  const clock = options.clock ?? systemClock;
  const intervalMs = options.intervalMs ?? USAGE_RECONCILE_INTERVAL_MS;
  let timer: TimerHandle | undefined;
  let stopped = false;
  let running = false;
  const tick = (): void => {
    if (stopped) return;
    timer = clock.setTimer(tick, intervalMs);
    if (running) return;
    running = true;
    options
      .run()
      .then((report) => {
        options.onReport?.(report);
        if (hasDrift(report)) options.onDrift?.(report);
      })
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        running = false;
      });
  };
  timer = clock.setTimer(tick, intervalMs);
  return {
    stop() {
      stopped = true;
      if (timer) clock.clearTimer(timer);
    },
  };
}
