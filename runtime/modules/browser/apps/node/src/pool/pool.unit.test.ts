// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.1 (04b § 1 à § 4) : pool de Chromium chauds piloté par un lanceur simulé (aucun processus). Les mêmes règles
// sont rejouées sur de vrais Chromium dans pool.chromium.test.ts (pool_no_orphans, kill_on_close_timeout).
import type { Browser } from 'playwright-core';
import { describe, expect, test } from 'vitest';
import { PROVISIONAL_CAPACITY } from './capacity.js';
import { BrowserPool, CapacityExceededError, PoolClosedError, type BrowserLauncher, type LaunchedBrowser, type PoolEvent, type PoolOptions } from './pool.js';

type Fake = LaunchedBrowser & { n: number; closed: boolean; killed: boolean; crash(): void; purpose: string };

function fakeLauncher(behaviour: { hangOnClose?: (n: number) => boolean; hangOnLaunch?: (n: number) => boolean } = {}) {
  const launched: Fake[] = [];
  const launch: BrowserLauncher = async (purpose) => {
    const n = launched.length;
    let connected = true;
    const listeners: (() => void)[] = [];
    const fake: Fake = {
      n,
      purpose: purpose.role,
      id: `fake-${n}`,
      pid: undefined,
      wsEndpoint: `ws://127.0.0.1:1/${n}`,
      browser: {} as Browser,
      closed: false,
      killed: false,
      isConnected: () => connected,
      onDisconnected: (listener) => void listeners.push(listener),
      close: () => {
        if (behaviour.hangOnClose?.(n) === true) return new Promise<void>(() => undefined);
        fake.closed = true;
        connected = false;
        return Promise.resolve();
      },
      kill: () => {
        fake.killed = true;
        connected = false;
        return Promise.resolve();
      },
      crash: () => {
        connected = false;
        for (const listener of listeners) listener();
      },
    };
    launched.push(fake);
    if (behaviour.hangOnLaunch?.(n) === true) return new Promise<LaunchedBrowser>((resolve) => setTimeout(() => resolve(fake), 50));
    return fake;
  };
  return { launch, launched };
}

function makePool(overrides: Partial<PoolOptions> = {}, launcher = fakeLauncher()) {
  const events: PoolEvent[] = [];
  const pool = new BrowserPool({
    slotsTotal: 4,
    launch: launcher.launch,
    warmBrowsers: 1,
    constants: PROVISIONAL_CAPACITY,
    sweepIntervalMs: 0,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return { pool, events, launched: launcher.launched };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('pool de Chromium chauds (04b § 1)', () => {
  test('préchauffage : WARM_BROWSERS Chromium lancés au démarrage, relancés après usage', async () => {
    const { pool, launched } = makePool({ warmBrowsers: 2 });
    await pool.start();
    expect(launched).toHaveLength(2);
    expect(pool.stats().browsers).toEqual({ warm: 2, shared: 0, dedicated: 0 });
    const lease = await pool.acquire({ sessionId: 's1', type: 'shared', tenantId: 'A' });
    expect(lease.browserId).toBe('fake-0');
    await pool.whenIdle();
    expect(pool.stats().browsers).toEqual({ warm: 2, shared: 1, dedicated: 0 });
    await pool.close();
  });

  test('un Chromium chaud est réservé à un client : contextes du même client jusqu’à CONTEXTS_PER_BROWSER, jamais un autre client', async () => {
    const { pool } = makePool({ slotsTotal: 8, constants: { ...PROVISIONAL_CAPACITY, contextsPerBrowser: 2 } });
    await pool.start();
    const a1 = await pool.acquire({ sessionId: 'a1', type: 'shared', tenantId: 'A' });
    const a2 = await pool.acquire({ sessionId: 'a2', type: 'shared', tenantId: 'A' });
    const a3 = await pool.acquire({ sessionId: 'a3', type: 'shared', tenantId: 'A' });
    const b1 = await pool.acquire({ sessionId: 'b1', type: 'shared', tenantId: 'B' });
    expect(a2.browserId).toBe(a1.browserId);
    expect(a3.browserId).not.toBe(a1.browserId);
    expect([a1.browserId, a3.browserId]).not.toContain(b1.browserId);
    await pool.close();
  });

  test('BINV1 entre clients : le Chromium qui a servi A est détruit à sa dernière session, B reçoit un Chromium neuf', async () => {
    const { pool, launched, events } = makePool();
    await pool.start();
    const a = await pool.acquire({ sessionId: 'a', type: 'shared', tenantId: 'A' });
    await a.release();
    const b = await pool.acquire({ sessionId: 'b', type: 'shared', tenantId: 'B' });
    expect(b.browserId).not.toBe(a.browserId);
    expect(launched.find((f) => f.id === a.browserId)?.closed).toBe(true);
    expect(events).toContainEqual({ kind: 'release', browserId: a.browserId });
    await pool.close();
  });

  test('session dedicated : un Chromium à elle seule, lancé à la demande, détruit à la fin', async () => {
    const { pool, launched } = makePool({ warmBrowsers: 0 });
    await pool.start();
    const d = await pool.acquire({ sessionId: 'd', type: 'dedicated', tenantId: 'A' });
    expect(launched).toHaveLength(1);
    expect(launched[0]!.purpose).toBe('dedicated');
    expect(pool.stats().browsers).toEqual({ warm: 0, shared: 0, dedicated: 1 });
    await d.release();
    expect(launched[0]!.closed).toBe(true);
    expect(pool.stats().browsers.dedicated).toBe(0);
    await pool.close();
  });
});

describe('slots par type de session (04b § 3)', () => {
  test('capacité épuisée : refus immédiat (la file appartient à la passerelle, tâche 2.4), slot rendu à la libération', async () => {
    const { pool } = makePool({ slotsTotal: 2, warmBrowsers: 0 });
    await pool.start();
    const d1 = await pool.acquire({ sessionId: 'd1', type: 'dedicated', tenantId: 'A' });
    await pool.acquire({ sessionId: 's1', type: 'shared', tenantId: 'A' });
    expect(pool.stats()).toMatchObject({ slotsTotal: 2, slotsFree: 0, sessions: { shared: 1, dedicated: 1 } });
    await expect(pool.acquire({ sessionId: 'd2', type: 'dedicated', tenantId: 'B' })).rejects.toThrow(CapacityExceededError);
    await d1.release();
    expect(pool.stats().slotsFree).toBe(1);
    await pool.acquire({ sessionId: 'd2', type: 'dedicated', tenantId: 'B' });
    await pool.close();
  });

  test('poids fractionnaire : shared à 0,25 slot loge 4 sessions par slot, dedicated en prend un entier', async () => {
    const constants = { ...PROVISIONAL_CAPACITY, weights: { dedicated: 1, shared: 0.25 }, contextsPerBrowser: 8 };
    const { pool } = makePool({ slotsTotal: 2, constants });
    await pool.start();
    for (let i = 0; i < 4; i += 1) await pool.acquire({ sessionId: `s${i}`, type: 'shared', tenantId: 'A' });
    expect(pool.freeFor('shared')).toBe(4);
    expect(pool.freeFor('dedicated')).toBe(1);
    await pool.acquire({ sessionId: 'd', type: 'dedicated', tenantId: 'A' });
    expect(pool.freeFor('dedicated')).toBe(0);
    await expect(pool.acquire({ sessionId: 's9', type: 'shared', tenantId: 'A' })).rejects.toThrow(CapacityExceededError);
    await pool.close();
  });

  test('un lancement raté rend le slot réservé', async () => {
    const { pool } = makePool({ slotsTotal: 1, warmBrowsers: 0, launch: () => Promise.reject(new Error('lancement impossible')) });
    await pool.start();
    await expect(pool.acquire({ sessionId: 'd', type: 'dedicated', tenantId: 'A' })).rejects.toThrow('lancement impossible');
    expect(pool.stats().slotsFree).toBe(1);
    await pool.close();
  });
});

describe('recyclage, chien de garde, kill forcé (04b § 4)', () => {
  test('par usage : après RECYCLE_AFTER_SESSIONS sessions servies, plus de nouvelle session sur ce Chromium, recyclé à sa dernière session', async () => {
    const { pool, events } = makePool({ slotsTotal: 8, recycleAfterSessions: 2 });
    await pool.start();
    const a1 = await pool.acquire({ sessionId: 'a1', type: 'shared', tenantId: 'A' });
    const a2 = await pool.acquire({ sessionId: 'a2', type: 'shared', tenantId: 'A' });
    const a3 = await pool.acquire({ sessionId: 'a3', type: 'shared', tenantId: 'A' });
    expect(a2.browserId).toBe(a1.browserId);
    expect(a3.browserId).not.toBe(a1.browserId);
    await a1.release();
    expect(events.filter((e) => e.kind === 'recycle')).toEqual([]);
    await a2.release();
    expect(events).toContainEqual({ kind: 'recycle', browserId: a1.browserId, reason: 'runs' });
    expect(pool.stats().recycles.runs).toBe(1);
    await pool.close();
  });

  test('par âge : un Chromium chaud plus vieux que RECYCLE_AFTER_MS est recyclé avant de servir', async () => {
    let now = 1_000;
    const { pool, events } = makePool({ recycleAfterMs: 60_000, now: () => now });
    await pool.start();
    now += 60_000;
    const lease = await pool.acquire({ sessionId: 's', type: 'shared', tenantId: 'A' });
    expect(events).toContainEqual({ kind: 'recycle', browserId: 'fake-0', reason: 'age' });
    expect(lease.browserId).not.toBe('fake-0');
    await pool.close();
  });

  test('recycle_memory : un Chromium à 90 % de la limite est recyclé raison memory quand sa dernière session se termine (P5)', async () => {
    let high = false;
    const { pool, events } = makePool({ memoryHigh: () => high });
    await pool.start();
    const a1 = await pool.acquire({ sessionId: 'a1', type: 'shared', tenantId: 'A' });
    const a2 = await pool.acquire({ sessionId: 'a2', type: 'shared', tenantId: 'A' });
    high = true;
    await a1.release();
    // Une session en cours va jusqu'à sa fin : aucun recyclage tant que a2 vit.
    expect(events.filter((e) => e.kind === 'recycle')).toEqual([]);
    await a2.release();
    expect(events).toContainEqual({ kind: 'recycle', browserId: a1.browserId, reason: 'memory' });
    expect(pool.stats().recycles.memory).toBe(1);
    await pool.close();
  });

  test('kill_on_close_timeout : un Chromium qui ne se ferme pas est tué au délai dur et son slot libéré (P6)', async () => {
    const launcher = fakeLauncher({ hangOnClose: () => true });
    const { pool, events, launched } = makePool({ slotsTotal: 1, warmBrowsers: 0, closeTimeoutMs: 30 }, launcher);
    await pool.start();
    const d = await pool.acquire({ sessionId: 'd', type: 'dedicated', tenantId: 'A' });
    expect(pool.stats().slotsFree).toBe(0);
    const started = Date.now();
    await d.release();
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(launched[0]!.killed).toBe(true);
    expect(events).toContainEqual({ kind: 'kill', browserId: 'fake-0', reason: 'close_timeout' });
    expect(pool.stats()).toMatchObject({ slotsFree: 1, recycles: { close_timeout: 1 } });
    await pool.close();
  });

  test('Chromium déconnecté : ses sessions échouent raison crash, processus tué, slots libérés', async () => {
    const { pool, launched, events } = makePool({ slotsTotal: 2 });
    await pool.start();
    const a1 = await pool.acquire({ sessionId: 'a1', type: 'shared', tenantId: 'A' });
    const a2 = await pool.acquire({ sessionId: 'a2', type: 'shared', tenantId: 'A' });
    launched[0]!.crash();
    await pool.whenIdle();
    expect(a1.signal.aborted && a1.signal.reason).toBe('crash');
    expect(a2.signal.reason).toBe('crash');
    expect(launched[0]!.killed).toBe(true);
    expect(events).toContainEqual({ kind: 'recycle', browserId: 'fake-0', reason: 'disconnected' });
    expect(pool.stats().slotsFree).toBe(2);
    await a1.release(); // idempotent : déjà libérée
    expect(pool.stats().slotsFree).toBe(2);
    await pool.close();
  });

  test('chien de garde de session : au-delà du délai, la session est fermée (signal timed_out) et son Chromium dédié arrêté', async () => {
    const { pool, launched, events } = makePool({ warmBrowsers: 0 });
    await pool.start();
    const d = await pool.acquire({ sessionId: 'd', type: 'dedicated', tenantId: 'A', watchdogMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await pool.whenIdle();
    expect(d.signal.reason).toBe('timed_out');
    expect(events).toContainEqual({ kind: 'watchdog', target: 'session', sessionId: 'd' });
    expect(launched[0]!.closed).toBe(true);
    expect(pool.stats().slotsFree).toBe(4);
    await pool.close();
  });

  test('chien de garde de lancement : un Chromium qui ne répond pas dans le délai est tué et relancé', async () => {
    const launcher = fakeLauncher({ hangOnLaunch: (n) => n === 0 });
    const { pool, events, launched } = makePool({ warmBrowsers: 0, launchTimeoutMs: 10 }, launcher);
    await pool.start();
    const d = await pool.acquire({ sessionId: 'd', type: 'dedicated', tenantId: 'A' });
    expect(d.browserId).toBe('fake-1');
    expect(events).toContainEqual({ kind: 'watchdog', target: 'launch' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(launched[0]!.killed).toBe(true);
    await pool.close();
  });

  test('arrêt : sessions interrompues (shutdown), chaque Chromium recyclé raison shutdown, nouvelles demandes refusées', async () => {
    const { pool, events } = makePool({ warmBrowsers: 1 });
    await pool.start();
    const s = await pool.acquire({ sessionId: 's', type: 'shared', tenantId: 'A' });
    const d = await pool.acquire({ sessionId: 'd', type: 'dedicated', tenantId: 'A' });
    await settle();
    await pool.close();
    expect(s.signal.reason).toBe('shutdown');
    expect(d.signal.reason).toBe('shutdown');
    expect(pool.stats().recycles.shutdown).toBe(3);
    expect(pool.stats().browsers).toEqual({ warm: 0, shared: 0, dedicated: 0 });
    expect(events.filter((e) => e.kind === 'launch')).toHaveLength(3);
    await expect(pool.acquire({ sessionId: 'x', type: 'shared', tenantId: 'A' })).rejects.toThrow(PoolClosedError);
  });

  test('balayage : appelé au démarrage puis périodiquement', async () => {
    let sweeps = 0;
    const { pool } = makePool({ sweep: () => void (sweeps += 1), sweepIntervalMs: 10 });
    await pool.start();
    expect(sweeps).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(sweeps).toBeGreaterThanOrEqual(3);
    await pool.close();
    const after = sweeps;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sweeps).toBe(after + 0);
  });
});
