// Horloge pilotable : gelée à EPOCH_MS après chaque reset, ne bouge que sur commande (POST /__control).
export const EPOCH_MS = Date.UTC(2026, 0, 1);

export interface Clock {
  now(): number;
  iso(): string;
  set(ms: number): void;
  advance(ms: number): void;
  reset(): void;
}

export function createClock(): Clock {
  let current = EPOCH_MS;
  return {
    now: () => current,
    iso: () => new Date(current).toISOString(),
    set: (ms) => {
      current = ms;
    },
    advance: (ms) => {
      current += ms;
    },
    reset: () => {
      current = EPOCH_MS;
    },
  };
}
