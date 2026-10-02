// SPDX-License-Identifier: AGPL-3.0-only
// Journal en mémoire, borné. Ne reçoit jamais de mot de passe : les appelants n'y mettent que l'utilisateur et l'issue.
export interface Journal<T> {
  add(entry: T): void;
  entries(): T[];
  reset(): void;
}

export function createJournal<T>(limit = 10_000, onAdd?: (entry: T) => void): Journal<T> {
  let items: T[] = [];
  return {
    add(entry) {
      onAdd?.(entry);
      items.push(entry);
      if (items.length > limit) items = items.slice(items.length - limit);
    },
    entries: () => [...items],
    reset() {
      items = [];
    },
  };
}

/** `::ffff:10.88.0.11` devient `10.88.0.11`. */
export function normalizeIp(address: string | undefined): string {
  if (address === undefined) return 'unknown';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}
