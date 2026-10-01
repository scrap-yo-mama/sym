// SPDX-License-Identifier: AGPL-3.0-only
// Magasin de cadence en mémoire (tests de l'étage S, sans PostgreSQL) : mêmes règles que `domain_pacing_state` (1.9)
// pour ce qui est observé ici : créneaux espacés de `min_delay_ms` par domaine, un 429 ou un 5xx allonge la cadence
// (à sens unique), `Retry-After` repousse le prochain créneau, refus `max_wait` au-delà de l'attente admise.
import type { OutcomeResult, PacingStore } from '@runtime/core';

export function memoryPacingStore(now: () => number = Date.now): PacingStore {
  const state = new Map<string, { next: number; penaltyUntil: number; adaptive: number }>();
  const of = (domain: string) => {
    let s = state.get(domain);
    if (s === undefined) {
      s = { next: 0, penaltyUntil: 0, adaptive: 0 };
      state.set(domain, s);
    }
    return s;
  };
  return {
    reserve(request) {
      const t = now();
      const s = of(request.domain);
      const slot = Math.max(t, s.next, s.penaltyUntil);
      if (slot - t > request.maxWaitMs) return Promise.resolve({ granted: false, reason: 'max_wait', dbNow: new Date(t), retryAt: new Date(slot) });
      s.next = slot + request.minDelayMs + request.jitterMs + s.adaptive;
      return Promise.resolve({ granted: true, slot: new Date(slot), dbNow: new Date(t), probe: false });
    },
    record(domain, outcome) {
      const s = of(domain);
      if (outcome.kind !== 'ok') {
        s.adaptive = Math.max(s.adaptive * 2, 250);
        if (outcome.retryAfterMs !== undefined) s.penaltyUntil = Math.max(s.penaltyUntil, now() + outcome.retryAfterMs);
      }
      const result: OutcomeResult = {
        circuit: 'closed',
        opened: false,
        consecutiveFailures: 0,
        penaltyUntil: s.penaltyUntil > 0 ? new Date(s.penaltyUntil) : null,
        adaptiveDelayMs: s.adaptive,
      };
      return Promise.resolve(result);
    },
  };
}
