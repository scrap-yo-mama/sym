// SPDX-License-Identifier: AGPL-3.0-only
// Facturation (cdc/sym-browser 04d § 4.1, tâche 2.6, BINV5) et clôture dans le magasin de sessions en mémoire (modèle de
// référence de la base : clôture avec l'état final, clôture seule idempotente, valeur reconstruite remplacée par la mesure).
import { describe, expect, test } from 'vitest';
import { createMemorySessionStore } from '../session/index.js';
import { billedSeconds, type UsageClosure } from './index.js';

describe('billedSeconds', () => {
  test('ceil(ms / 1000), 0 pour 0, entier positif attendu', () => {
    expect([0, 1, 999, 1000, 1001, 61_001].map(billedSeconds)).toEqual([0, 1, 1, 1, 2, 62]);
    expect(() => billedSeconds(-1)).toThrow(RangeError);
    expect(() => billedSeconds(1.5)).toThrow(RangeError);
  });
});

describe('magasin en mémoire', () => {
  const closure = (browserMs: number): UsageClosure => ({ sessionId: 's1', nodeId: 'n', startedAt: 1_000, browserMs, bytesIn: 1, bytesOut: 2 });

  test('clôture avec l’état final ; transition refusée : rien n’est clôturé', async () => {
    const store = createMemorySessionStore();
    store.create({ sessionId: 's1', createdAt: 0, expiresAt: 10_000 });
    await store.transition({ sessionId: 's1', to: 'running', reason: null, nodeId: 'n' });
    await store.transition({ sessionId: 's1', to: 'failed', reason: 'node_lost' });
    expect(await store.transition({ sessionId: 's1', to: 'ended', reason: 'released', usage: closure(5) })).toMatchObject({ ok: false });
    expect(store.usage('s1')).toBeUndefined();
    expect(await store.recordUsage(closure(5))).toBe('inserted');
    expect(await store.recordUsage(closure(5))).toBe('unchanged');
    expect(await store.recordUsage(closure(9))).toBe('unchanged');
    expect(store.usage('s1')).toEqual({ ...closure(5), source: 'node' });
    expect(await store.recordUsage({ ...closure(1), sessionId: 'inconnue' })).toBe('not_found');
  });

  test('transition acceptée : usage écrit avec l’état final', async () => {
    const store = createMemorySessionStore();
    store.create({ sessionId: 's1', createdAt: 0, expiresAt: 10_000 });
    await store.transition({ sessionId: 's1', to: 'running', reason: null, nodeId: 'n' });
    expect(await store.transition({ sessionId: 's1', to: 'ended', reason: 'released', usage: closure(1_234) })).toMatchObject({ ok: true });
    expect(store.usage('s1')).toEqual({ ...closure(1_234), source: 'node' });
  });
});
