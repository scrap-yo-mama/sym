// SPDX-License-Identifier: AGPL-3.0-only
// Métriques du nœud (cdc/sym-browser 04d § 3.1, tâche 3.7), sans navigateur : slots et sessions du pool, recyclages
// (raisons de 04b § 4), démarrage et durée des sessions (superviseur), RSS de l'arbre de processus par type de Chromium,
// octets et refus de l'egress, enregistrements. Volet nœud de metrics_complete (D7).
import { createBrowserMetrics, createManualClock, createMemorySessionStore, MetricsRegistry } from '@sym-browser/core';
import type { Browser } from 'playwright-core';
import { describe, expect, test } from 'vitest';
import { BrowserPool, PROVISIONAL_CAPACITY, RECYCLE_REASONS, type BrowserLauncher, type LaunchedBrowser } from '../pool/index.js';
import { SessionSupervisor } from '../sessions/supervisor.js';
import { bindNodeMetrics, processTreeRss } from './node-metrics.js';

function value(text: string, series: string): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

function fakePool(pids: Map<string, number>) {
  const launch: BrowserLauncher = async (purpose) => {
    const pid = pids.get(purpose.sessionId ?? 'chaud');
    const fake: LaunchedBrowser = {
      id: `fake-${purpose.sessionId ?? 'chaud'}`,
      pid,
      wsEndpoint: 'ws://127.0.0.1:1/x',
      browser: {} as Browser,
      isConnected: () => true,
      onDisconnected: () => undefined,
      close: async () => undefined,
      kill: async () => undefined,
    };
    return fake;
  };
  return launch;
}

function setup() {
  const registry = new MetricsRegistry();
  const metrics = createBrowserMetrics(registry, 'node', { nodeId: 'node-a' });
  const pids = new Map([
    ['s-dedicated', 4242],
    ['chaud', 5151],
  ]);
  let bridge: ReturnType<typeof bindNodeMetrics> | undefined;
  const pool = new BrowserPool({
    slotsTotal: 3,
    launch: fakePool(pids),
    warmBrowsers: 0,
    constants: PROVISIONAL_CAPACITY,
    sweepIntervalMs: 0,
    onEvent: (event) => bridge?.onPoolEvent(event),
  });
  const rss = new Map([
    [4242, 300_000_000],
    [5151, 200_000_000],
  ]);
  bridge = bindNodeMetrics({ registry, metrics, nodeId: 'node-a', pool, rssOf: (pid) => rss.get(pid) ?? 0 });
  return { registry, metrics, pool, bridge };
}

describe('métriques du nœud', () => {
  test('slots, sessions running par type et RSS par type de Chromium, lus à chaque collecte', async () => {
    const { registry, pool } = setup();
    let text = await registry.render();
    expect(value(text, 'symb_slots_total{node="node-a"}')).toBe(3);
    expect(value(text, 'symb_slots_free{node="node-a"}')).toBe(3);
    const dedicated = await pool.acquire({ sessionId: 's-dedicated', type: 'dedicated', tenantId: 't-1' });
    const shared = await pool.acquire({ sessionId: 's-shared', type: 'shared', tenantId: 't-1' });
    text = await registry.render();
    expect(value(text, 'symb_slots_free{node="node-a"}')).toBe(pool.stats().slotsFree);
    expect(pool.stats().slotsFree).toBeLessThan(3);
    expect(value(text, 'symb_sessions{state="running",type="dedicated"}')).toBe(1);
    expect(value(text, 'symb_sessions{state="running",type="shared"}')).toBe(1);
    expect(value(text, 'symb_browser_rss_bytes{kind="dedicated",node="node-a"}')).toBe(300_000_000);
    expect(value(text, 'symb_browser_rss_bytes{kind="shared",node="node-a"}')).toBe(200_000_000);
    await dedicated.release();
    await shared.release();
    await pool.close();
    text = await registry.render();
    expect(value(text, 'symb_sessions{state="running",type="dedicated"}')).toBe(0);
    expect(value(text, 'symb_browser_rss_bytes{kind="dedicated",node="node-a"}')).toBe(0);
  });

  test('recyclages : raisons du pool = étiquettes de la spec ; chaque événement compté', async () => {
    const { registry, bridge } = setup();
    for (const reason of RECYCLE_REASONS) bridge.onPoolEvent({ kind: 'recycle', browserId: 'b', reason });
    bridge.onPoolEvent({ kind: 'recycle', browserId: 'b', reason: 'memory' });
    bridge.onPoolEvent({ kind: 'launch', browserId: 'b', role: 'warm' });
    const text = await registry.render();
    for (const reason of RECYCLE_REASONS) expect(value(text, `symb_recycles_total{reason="${reason}"}`), reason).toBe(reason === 'memory' ? 2 : 1);
  });

  test('démarrage et durée des sessions par le superviseur (type, raison de fin)', async () => {
    const { registry, metrics, pool, bridge } = setup();
    const clock = createManualClock(1_000_000);
    const store = createMemorySessionStore({ now: () => clock.now() });
    const supervisor = new SessionSupervisor({ nodeId: 'node-a', pool, store, clock, onLifecycle: (event) => bridge.onSessionEvent(event) });
    store.create({ sessionId: 's-shared', createdAt: clock.now(), expiresAt: clock.now() + 600_000 });
    expect((await supervisor.start({ sessionId: 's-shared', type: 'shared', tenantId: 't-1', expiresAt: clock.now() + 600_000, maxExpiresAt: clock.now() + 600_000, idleTimeoutSeconds: 300 })).ok).toBe(true);
    clock.advance(42_000);
    await supervisor.end('s-shared', 'released');
    const text = await registry.render();
    expect(value(text, 'symb_session_start_seconds_count{type="shared"}')).toBe(1);
    expect(value(text, 'symb_session_duration_seconds_count{reason="released",type="shared"}')).toBe(1);
    expect(value(text, 'symb_session_duration_seconds_sum{reason="released",type="shared"}')).toBe(42);
    expect(value(text, 'symb_session_duration_seconds_bucket{reason="released",type="shared",le="30"}')).toBe(0);
    expect(value(text, 'symb_session_duration_seconds_bucket{reason="released",type="shared",le="60"}')).toBe(1);
    expect(metrics.sessionDurationSeconds).toBeDefined();
    await pool.close();
  });

  test('egress : octets entrants et sortants par écarts de compteurs (époques comprises), refus par motif', async () => {
    const { registry, bridge } = setup();
    const meter = bridge.egressMeter();
    const counters = (bytesIn: number, bytesOut: number, epoch = 1) => ({ epoch, requests: 1, blocked: 0, bytesIn, bytesOut, budgetExceeded: false });
    meter.onCounters(counters(100, 10));
    meter.onCounters(counters(250, 30));
    meter.onCounters(counters(5, 1, 2)); // nouvelle époque : compteurs repartis de zéro
    meter.onEvent({ type: 'egress.blocked', data: { host: 'x.test', reason: 'domain_not_allowed', count: 3 } });
    meter.onEvent({ type: 'egress.blocked', data: { host: 'y.test', reason: 'address_not_public', count: 1 } });
    meter.onEvent({ type: 'egress.budget_exceeded', data: { budgetBytes: 1, bytesIn: 1, bytesOut: 0, action: 'cut' } });
    const text = await registry.render();
    expect(value(text, 'symb_egress_bytes_total{direction="in"}')).toBe(255);
    expect(value(text, 'symb_egress_bytes_total{direction="out"}')).toBe(31);
    expect(value(text, 'symb_egress_blocked_total{reason="domain_not_allowed"}')).toBe(3);
    expect(value(text, 'symb_egress_blocked_total{reason="address_not_public"}')).toBe(1);
  });

  test('enregistrements comptés par type', async () => {
    const { registry, bridge } = setup();
    bridge.recordingProduced('trace');
    bridge.recordingProduced('video');
    bridge.recordingProduced('video');
    const text = await registry.render();
    expect(value(text, 'symb_recordings_total{type="trace"}')).toBe(1);
    expect(value(text, 'symb_recordings_total{type="video"}')).toBe(2);
    expect(value(text, 'symb_recordings_total{type="har"}')).toBe(0);
  });

  test('processTreeRss : somme des RSS du groupe de processus (pages × taille), processus zombies exclus', () => {
    const table = [
      { pid: 10, pgid: 10, state: 'S' },
      { pid: 11, pgid: 10, state: 'S' },
      { pid: 12, pgid: 10, state: 'Z' },
      { pid: 20, pgid: 20, state: 'S' },
    ];
    const statm: Record<number, string> = { 10: '1000 100 0 0 0 0 0', 11: '1000 50 0 0 0 0 0', 12: '0 999 0 0 0 0 0', 20: '1 7 0' };
    expect(processTreeRss(10, { table: () => table, statm: (pid) => statm[pid], pageSize: 4096 })).toBe(150 * 4096);
    expect(processTreeRss(99, { table: () => table, statm: (pid) => statm[pid], pageSize: 4096 })).toBe(0);
  });
});
