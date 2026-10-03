// SPDX-License-Identifier: AGPL-3.0-only
// Horloge injectable des délais de session : le système en production, une horloge manuelle dans les tests (déterministe,
// sans attente réelle). Dates en millisecondes depuis l'époque Unix.
export type TimerHandle = { readonly id: number };

export type Clock = {
  now(): number;
  setTimer(callback: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
};

const handles = new Map<number, NodeJS.Timeout>();
let nextId = 1;

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(callback, delayMs) {
    const id = nextId++;
    const timer = setTimeout(() => {
      handles.delete(id);
      callback();
    }, Math.max(0, delayMs));
    // Un délai de session ne retient pas le processus : l'arrêt du nœud ferme les sessions lui-même.
    timer.unref();
    handles.set(id, timer);
    return { id };
  },
  clearTimer(handle) {
    clearTimeout(handles.get(handle.id));
    handles.delete(handle.id);
  },
};

export type ManualClock = Clock & {
  /** Avance l'horloge et déclenche, dans l'ordre de leur échéance, les minuteries arrivées à terme. */
  advance(ms: number): void;
};

export function createManualClock(start = 0): ManualClock {
  let now = start;
  let sequence = 0;
  const timers = new Map<number, { at: number; seq: number; callback: () => void }>();
  return {
    now: () => now,
    setTimer(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, delayMs), seq: sequence++, callback });
      return { id };
    },
    clearTimer(handle) {
      timers.delete(handle.id);
    },
    advance(ms) {
      const target = now + Math.max(0, ms);
      for (;;) {
        let next: [number, { at: number; seq: number; callback: () => void }] | undefined;
        for (const entry of timers) if (entry[1].at <= target && (!next || entry[1].at < next[1].at || (entry[1].at === next[1].at && entry[1].seq < next[1].seq))) next = entry;
        if (!next) break;
        timers.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].callback();
      }
      now = target;
    },
  };
}
