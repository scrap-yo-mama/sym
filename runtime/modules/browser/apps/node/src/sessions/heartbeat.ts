// SPDX-License-Identifier: AGPL-3.0-only
// Battement du nœud (cdc/sym-browser 04b § 5 et § 6, tâche 1.2) : un battement au démarrage puis toutes les `HEARTBEAT_MS`
// (upsert de la ligne `nodes`, `recordHeartbeat` de @sym-browser/db). Le nœud s'isole (sessions locales détruites, BINV3)
// quand il n'a pas pu écrire de battement depuis `lostAfterMs` (la passerelle le déclare alors `down`), et quand un
// battement lui apprend qu'il a été déclaré `down` (`recovered`) : ses sessions sont déjà `failed` raison `node_lost`.
import { systemClock, type Clock, type TimerHandle } from '@sym-browser/core';

export const HEARTBEAT_DEFAULTS = Object.freeze({ intervalMs: 5_000, lostAfterMs: 15_000 });

export type HeartbeatOptions = {
  beat: () => Promise<{ recovered: boolean }>;
  /** Destruction des sessions locales (`SessionSupervisor.isolate`). */
  isolate: () => Promise<void>;
  clock?: Clock;
  intervalMs?: number;
  lostAfterMs?: number;
  onError?: (error: unknown) => void;
};

export function startHeartbeat(options: HeartbeatOptions): { stop: () => void } {
  const clock = options.clock ?? systemClock;
  const intervalMs = options.intervalMs ?? HEARTBEAT_DEFAULTS.intervalMs;
  const lostAfterMs = options.lostAfterMs ?? HEARTBEAT_DEFAULTS.lostAfterMs;
  const onError = options.onError ?? (() => undefined);
  let lastWritten = clock.now();
  let isolated = false;
  let inFlight = false;
  let stopped = false;
  let timer: TimerHandle | undefined;

  const isolate = (): void => {
    void options.isolate().catch(onError);
  };
  const isolateIfLost = (): void => {
    if (!isolated && clock.now() - lastWritten >= lostAfterMs) {
      isolated = true;
      isolate();
    }
  };

  const tick = (): void => {
    if (stopped) return;
    // Cadence fixe : le battement suivant est armé avant d'attendre celui-ci.
    timer = clock.setTimer(tick, intervalMs);
    // Battement précédent encore en cours (base lente ou bloquée) : on ne l'empile pas, mais le délai de perte court.
    isolateIfLost();
    if (inFlight) return;
    inFlight = true;
    options
      .beat()
      .then((result) => {
        lastWritten = clock.now();
        isolated = false;
        if (result.recovered) isolate();
      })
      .catch((error: unknown) => {
        onError(error);
        isolateIfLost();
      })
      .finally(() => {
        inFlight = false;
      });
  };

  tick();
  return {
    stop() {
      stopped = true;
      if (timer) clock.clearTimer(timer);
    },
  };
}
