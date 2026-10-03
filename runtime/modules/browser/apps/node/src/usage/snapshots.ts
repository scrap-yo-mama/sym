// SPDX-License-Identifier: AGPL-3.0-only
// Instantanés d'usage (cdc/sym-browser 04c § 1.5, 04d § 4.1 et § 4.2 ; tâche 2.6) : toutes les 10 s (à valider), les mesures
// en cours du nœud sont poussées à la base. Elles servent au contrôle des minutes en cours de session et, si le nœud est
// perdu, de « dernière mesure reçue » pour clore ses sessions (`source: reconstructed`).
import { systemClock, type Clock, type TimerHandle, type UsageClosure } from '@sym-browser/core';
import type { UsageMeter } from './meter.js';

export const USAGE_SNAPSHOT_INTERVAL_MS = 10_000;

export type UsageSnapshotsOptions = {
  meter: Pick<UsageMeter, 'live'>;
  /** Écriture des instantanés (`recordUsageSnapshots` de @sym-browser/db). */
  write: (snapshots: UsageClosure[]) => Promise<void>;
  clock?: Clock;
  intervalMs?: number;
  onError?: (error: unknown) => void;
};

export function startUsageSnapshots(options: UsageSnapshotsOptions): { stop: () => void } {
  const clock = options.clock ?? systemClock;
  const intervalMs = options.intervalMs ?? USAGE_SNAPSHOT_INTERVAL_MS;
  const onError = options.onError ?? (() => undefined);
  let timer: TimerHandle | undefined;
  let stopped = false;
  let inFlight = false;
  const tick = (): void => {
    if (stopped) return;
    timer = clock.setTimer(tick, intervalMs);
    const live = options.meter.live();
    // Base lente : l'écriture précédente n'est pas doublée, l'instantané suivant la remplace.
    if (live.length === 0 || inFlight) return;
    inFlight = true;
    options
      .write(live)
      .catch(onError)
      .finally(() => {
        inFlight = false;
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
