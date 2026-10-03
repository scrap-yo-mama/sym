// SPDX-License-Identifier: AGPL-3.0-only
// Arrêt gracieux et drainage du nœud (cdc/sym-browser 04b § 9, 04 § 5, tâche 2.7), sur le vrai superviseur (1.2) et le vrai
// pool (1.1) avec un lanceur simulé (aucun processus) et une horloge manuelle :
//   drain_refuses_new_sessions : dès le drainage, `start` répond `draining` sans toucher au pool ;
//   drain_waits_then_node_shutdown : les sessions qui finissent seules pendant la grâce gardent leur raison ; à l'échéance,
//     les restantes passent `ended` raison `node_shutdown` ; ordre : `draining` écrit, sessions finies, pool fermé, battement
//     arrêté, `down` écrit en dernier ;
//   drain_early_when_empty : la dernière session finie avant l'échéance termine le drainage sans attendre la grâce.
import { createManualClock, createMemorySessionStore, type ManualClock, type MemorySessionStore } from '@sym-browser/core';
import type { Browser } from 'playwright-core';
import { describe, expect, test } from 'vitest';
import { BrowserPool, PROVISIONAL_CAPACITY, type BrowserLauncher, type LaunchedBrowser } from '../pool/index.js';
import { SessionSupervisor } from '../sessions/supervisor.js';
import { NodeDrain } from './drain.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function harness(clock: ManualClock = createManualClock(1_000_000)) {
  const log: string[] = [];
  const launch: BrowserLauncher = async (purpose) => {
    let connected = true;
    const fake: LaunchedBrowser = {
      id: `fake-${purpose.sessionId ?? 'chaud'}`,
      pid: undefined,
      wsEndpoint: 'ws://127.0.0.1:1/x',
      browser: {} as Browser,
      isConnected: () => connected,
      onDisconnected: () => undefined,
      close: async () => void (connected = false),
      kill: async () => void (connected = false),
    };
    return fake;
  };
  const pool = new BrowserPool({ slotsTotal: 16, launch, warmBrowsers: 0, constants: PROVISIONAL_CAPACITY, sweepIntervalMs: 0 });
  let acquired = 0;
  const store: MemorySessionStore = createMemorySessionStore({ now: () => clock.now() });
  const supervisor = new SessionSupervisor({
    nodeId: 'node-2-7',
    clock,
    store,
    pool: {
      async acquire(request) {
        acquired += 1;
        return pool.acquire(request);
      },
    },
  });
  const drain = new NodeDrain({
    supervisor,
    graceMs: 270_000,
    clock,
    setState: async (state) => void log.push(`state ${state}`),
    closePool: async () => {
      log.push(`pool closed (${supervisor.active().length} sessions)`);
      await pool.close();
    },
    stopHeartbeat: () => void log.push('heartbeat stopped'),
  });
  const start = async (sessionId: string, type: 'shared' | 'dedicated' = 'dedicated') => {
    const now = clock.now();
    if (store.get(sessionId) === undefined) store.create({ sessionId, createdAt: now, expiresAt: now + 3_600_000, maxDurationSeconds: 3600 });
    return supervisor.start({ sessionId, type, tenantId: 'A', expiresAt: now + 3_600_000, maxExpiresAt: now + 3_600_000, idleTimeoutSeconds: 3600 });
  };
  return { clock, log, pool, store, supervisor, drain, start, acquired: () => acquired };
}

describe('drain_refuses_new_sessions (04b § 9, étape 1)', () => {
  test('Given un nœud en drainage / When nouvelle session / Then refus `draining`, aucun bail pris', async () => {
    const h = harness();
    expect(await h.start('s-1')).toEqual({ ok: true });
    const draining = h.drain.drain();
    expect(h.drain.draining).toBe(true);
    expect(h.supervisor.draining).toBe(true);
    const before = h.acquired();
    expect(await h.start('s-new')).toEqual({ ok: false, code: 'draining' });
    expect(h.acquired()).toBe(before);
    expect(h.store.get('s-new')?.state).toBe('pending');
    h.clock.advance(270_000);
    await draining;
  });
});

describe('drain_waits_then_node_shutdown (04b § 9, étapes 2 à 4)', () => {
  test('Given 10 sessions / When drainage / Then libérées pendant la grâce : `released` ; restantes à l’échéance : `node_shutdown`, puis `down`', async () => {
    const h = harness();
    const ids = Array.from({ length: 10 }, (_, i) => `s-${i}`);
    for (const [i, id] of ids.entries()) expect(await h.start(id, i % 2 === 0 ? 'dedicated' : 'shared')).toEqual({ ok: true });
    const draining = h.drain.drain();
    await flush();
    expect(h.log).toEqual(['state draining']);
    // Deux clients libèrent leur session pendant la grâce : raison d'origine conservée.
    await h.supervisor.end('s-0', 'released');
    await h.supervisor.end('s-1', 'released');
    h.clock.advance(269_999);
    await flush();
    expect(h.supervisor.active()).toHaveLength(8);
    expect(h.log).toEqual(['state draining']);
    h.clock.advance(1);
    const report = await draining;
    for (const id of ids.slice(0, 2)) expect(h.store.get(id)).toMatchObject({ state: 'ended', endReason: 'released' });
    for (const id of ids.slice(2)) expect(h.store.get(id)).toMatchObject({ state: 'ended', endReason: 'node_shutdown' });
    expect(report.endedOnShutdown.sort()).toEqual(ids.slice(2).sort());
    expect(h.supervisor.active()).toEqual([]);
    expect(h.pool.stats().sessions).toEqual({ shared: 0, dedicated: 0 });
    expect(h.log).toEqual(['state draining', 'pool closed (0 sessions)', 'heartbeat stopped', 'state down']);
  });

  test('drain est idempotent : un second SIGTERM rend le même drainage', async () => {
    const h = harness();
    await h.start('s-1');
    const first = h.drain.drain();
    const second = h.drain.drain();
    expect(second).toBe(first);
    h.clock.advance(270_000);
    await first;
    expect(h.log.filter((line) => line === 'state down')).toHaveLength(1);
  });

  test('une écriture d’état refusée (base injoignable) n’empêche ni la fin des sessions ni l’arrêt', async () => {
    const clock = createManualClock(0);
    const h = harness(clock);
    await h.start('s-1');
    const errors: unknown[] = [];
    const drain = new NodeDrain({
      supervisor: h.supervisor,
      graceMs: 1_000,
      clock,
      setState: async () => {
        throw new Error('base injoignable');
      },
      closePool: () => h.pool.close(),
      onError: (error) => errors.push(error),
    });
    const draining = drain.drain();
    await flush();
    clock.advance(1_000);
    await draining;
    expect(h.store.get('s-1')).toMatchObject({ state: 'ended', endReason: 'node_shutdown' });
    expect(errors).toHaveLength(2);
  });
});

describe('drain_early_when_empty (04b § 5 : draining → down à la dernière session finie)', () => {
  test('Given la dernière session libérée pendant la grâce / Then `down` sans attendre l’échéance, aucune fin `node_shutdown`', async () => {
    const h = harness();
    await h.start('s-1');
    const draining = h.drain.drain();
    await flush();
    await h.supervisor.end('s-1', 'released');
    const report = await draining;
    expect(report.endedOnShutdown).toEqual([]);
    expect(h.store.get('s-1')).toMatchObject({ state: 'ended', endReason: 'released' });
    expect(h.log.at(-1)).toBe('state down');
  });

  test('Given aucun session / Then drainage immédiat', async () => {
    const h = harness();
    const report = await h.drain.drain();
    expect(report.endedOnShutdown).toEqual([]);
    expect(h.log).toEqual(['state draining', 'pool closed (0 sessions)', 'heartbeat stopped', 'state down']);
  });
});
