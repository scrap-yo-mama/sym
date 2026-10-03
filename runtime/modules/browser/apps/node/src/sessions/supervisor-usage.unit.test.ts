// SPDX-License-Identifier: AGPL-3.0-only
// Clôture de l'usage par le superviseur (cdc/sym-browser 04d § 4.1, 04c § 3.2 étape 8 ; tâche 2.6, BINV5) : la mesure démarre
// au passage `running`, s'arrête après la destruction, part dans `usage.wal` (fsync) PUIS dans la même écriture que l'état
// final. Quand l'état final ne peut pas être écrit (base injoignable, nœud déjà déclaré perdu), la clôture reste dans le
// journal et est écrite seule ; un nœud isolé clôt ses sessions sans écrire d'état.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManualClock, createMemorySessionStore, type SessionStore, type UsageClosure } from '@sym-browser/core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { PoolLease } from '../pool/index.js';
import { UsageMeter, UsageWal } from '../usage/index.js';
import { SessionSupervisor } from './supervisor.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'symb-sup-usage-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const WALL = Date.UTC(2026, 9, 2, 9, 0, 0);

async function setup(options: { failFinalWrite?: boolean } = {}) {
  const clock = createManualClock(0);
  const memory = createMemorySessionStore({ now: () => clock.now() });
  const log: string[] = [];
  const store: SessionStore = {
    ...memory,
    async transition(input) {
      if (options.failFinalWrite && input.to !== 'running') throw new Error('base injoignable');
      const outcome = await memory.transition(input);
      log.push(`state ${input.to}${input.usage ? ` usage ${input.usage.browserMs}` : ''}`);
      return outcome;
    },
    async recordUsage(closure) {
      log.push(`usage seule ${closure.browserMs}`);
      return memory.recordUsage(closure);
    },
  };
  const leases = new Map<string, AbortController>();
  const pool = {
    async acquire(request: { sessionId: string }) {
      const controller = new AbortController();
      leases.set(request.sessionId, controller);
      return { signal: controller.signal, release: async () => void log.push('destroy') } as unknown as PoolLease;
    },
  };
  const meter = new UsageMeter({ nodeId: 'node-1', monotonic: () => clock.now(), now: () => WALL + clock.now() });
  const wal = await UsageWal.open(join(dir, 'usage.wal'));
  const errors: unknown[] = [];
  const supervisor = new SessionSupervisor({ nodeId: 'node-1', pool, store, clock, usage: { meter, wal }, onError: (e) => errors.push(e) });
  const begin = async (sessionId: string) => {
    memory.create({ sessionId, createdAt: clock.now(), expiresAt: clock.now() + 300_000 });
    expect(await supervisor.start({ sessionId, type: 'dedicated', tenantId: 't', expiresAt: clock.now() + 300_000, maxExpiresAt: clock.now() + 3_600_000, idleTimeoutSeconds: 600 })).toEqual({ ok: true });
  };
  const closure = (sessionId: string, startedAt: number, browserMs: number, bytes: [number, number] = [0, 0]): UsageClosure => ({
    sessionId,
    nodeId: 'node-1',
    startedAt: WALL + startedAt,
    browserMs,
    bytesIn: bytes[0],
    bytesOut: bytes[1],
  });
  return { clock, memory, log, leases, meter, wal, errors, supervisor, begin, closure };
}

describe('clôture de l’usage (tâche 2.6)', () => {
  test('libération : destruction, journal puis état final et usage dans la même écriture', async () => {
    const s = await setup();
    s.clock.advance(500);
    await s.begin('s1');
    s.meter.observe('s1', { epoch: 1, requests: 3, blocked: 0, bytesIn: 4_000, bytesOut: 900, budgetExceeded: false });
    s.clock.advance(12_345);
    await s.supervisor.end('s1', 'released');
    const expected = s.closure('s1', 500, 12_345, [4_000, 900]);
    expect(s.log).toEqual(['state running', 'destroy', 'state ended usage 12345']);
    expect(await s.wal.read()).toEqual([expected]);
    expect(s.memory.usage('s1')).toEqual({ ...expected, source: 'node' });
    expect(s.memory.get('s1')).toMatchObject({ state: 'ended', endReason: 'released' });
  });

  test('plantage de Chromium (bail interrompu) : failed crash, usage clôturé jusqu’à la destruction', async () => {
    const s = await setup();
    await s.begin('s1');
    s.clock.advance(2_001);
    s.leases.get('s1')?.abort('crash');
    await s.supervisor.idle();
    expect(s.memory.get('s1')).toMatchObject({ state: 'failed', endReason: 'crash' });
    expect(s.memory.usage('s1')).toMatchObject({ browserMs: 2_001, source: 'node' });
  });

  test('délai total : timed_out, durée = délai', async () => {
    const s = await setup();
    await s.begin('s1');
    s.clock.advance(300_000);
    await s.supervisor.idle();
    expect(s.memory.get('s1')).toMatchObject({ state: 'timed_out', endReason: 'timeout' });
    expect(s.memory.usage('s1')).toMatchObject({ browserMs: 300_000 });
  });

  test('état final refusé (session déjà failed node_lost en base) : la clôture est écrite seule', async () => {
    const s = await setup();
    await s.begin('s1');
    s.clock.advance(7_000);
    await s.memory.transition({ sessionId: 's1', to: 'failed', reason: 'node_lost' });
    await s.supervisor.end('s1', 'released');
    expect(s.log.slice(-2)).toEqual(['state ended usage 7000', 'usage seule 7000']);
    expect(s.memory.usage('s1')).toMatchObject({ browserMs: 7_000, source: 'node' });
  });

  test('base injoignable à la fin : la clôture reste dans usage.wal (rejouée au redémarrage), erreur signalée', async () => {
    const s = await setup({ failFinalWrite: true });
    await s.begin('s1');
    s.clock.advance(1_000);
    await s.supervisor.end('s1', 'released');
    expect(await s.wal.read()).toEqual([s.closure('s1', 0, 1_000)]);
    expect(s.errors.length).toBeGreaterThan(0);
  });

  test('nœud isolé : sessions détruites, clôtures journalisées et écrites sans état final', async () => {
    const s = await setup();
    await s.begin('s1');
    s.clock.advance(1_500);
    await s.begin('s2');
    s.clock.advance(1_000);
    await s.supervisor.isolate();
    expect((await s.wal.read()).map((c) => [c.sessionId, c.browserMs])).toEqual([
      ['s1', 2_500],
      ['s2', 1_000],
    ]);
    expect(s.memory.get('s1')?.state).toBe('running');
    expect(s.memory.usage('s1')).toMatchObject({ browserMs: 2_500 });
    expect(s.memory.usage('s2')).toMatchObject({ browserMs: 1_000 });
  });

  test('démarrage refusé (session terminée entre-temps) : aucune mesure', async () => {
    const s = await setup();
    s.memory.create({ sessionId: 's1', createdAt: 0, expiresAt: 300_000 });
    await s.memory.transition({ sessionId: 's1', to: 'failed', reason: 'quota' });
    await s.supervisor.start({ sessionId: 's1', type: 'dedicated', tenantId: 't', expiresAt: 300_000, maxExpiresAt: 3_600_000, idleTimeoutSeconds: 60 });
    expect(s.meter.live()).toEqual([]);
    expect(await s.wal.read()).toEqual([]);
  });
});
