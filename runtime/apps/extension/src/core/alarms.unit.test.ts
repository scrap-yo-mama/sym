// SPDX-License-Identifier: AGPL-3.0-only
// Alarme de resynchronisation (07 § 2) : créée une seule fois. La recréer à chaque réveil du service worker remettrait
// son délai à zéro, et la resynchronisation horaire ne partirait jamais si le worker se réveille plus d'une fois par heure.
import { describe, expect, test } from 'vitest';
import { ensurePeriodicAlarm } from './alarms.ts';

function fakeAlarms() {
  const alarms = new Map<string, { name: string; periodInMinutes: number }>();
  const created: string[] = [];
  return {
    created,
    api: {
      get: async (name: string) => alarms.get(name),
      create: async (name: string, info: { periodInMinutes: number }) => {
        created.push(name);
        alarms.set(name, { name, ...info });
      },
    },
  };
}

describe('alarme de resynchronisation', () => {
  test('créée au premier démarrage, jamais remplacée aux réveils suivants du service worker', async () => {
    const a = fakeAlarms();
    expect(await ensurePeriodicAlarm(a.api, 'zz_test_resync', 60)).toBe(true);
    for (let wake = 0; wake < 5; wake += 1) expect(await ensurePeriodicAlarm(a.api, 'zz_test_resync', 60)).toBe(false);
    expect(a.created).toEqual(['zz_test_resync']);
  });
});
