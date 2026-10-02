// SPDX-License-Identifier: AGPL-3.0-only
// Superviseur des sessions du nœud (tâche 1.2) : démarrage sur le pool (interface de la tâche 1.1), délais total et
// d'inactivité, prolongation, fins (libération, plantage, arrêt du nœud), isolement du nœud perdu.
//   state_machine_model (A5) : commandes aléatoires (fast-check) ; le journal des transitions reste dans la table de 04 § 5.
//   idle_timeout_precision (A4) : horloge réelle, `timed_out` raison `idle` à ± 1 s du dernier message.
//   assert_session_teardown (BINV3, volet 1.2) : toute fin détruit la session sur le pool, une seule fois, AVANT l'état
//   final en base (04c § 3.2 : l'état public change à la dernière étape).
import { checkTransition, createManualClock, createMemorySessionStore, systemClock, type Clock, type SessionState } from '@sym-browser/core';
import type { EndReason } from '@sym/contracts/browser';
import fc from 'fast-check';
import type { Browser } from 'playwright-core';
import { describe, expect, test } from 'vitest';
import { BrowserPool, PROVISIONAL_CAPACITY, type BrowserLauncher, type LaunchedBrowser } from '../pool/index.js';
import { SessionSupervisor } from './supervisor.js';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Vrai pool de la tâche 1.1 (`BrowserPool`) sur un lanceur simulé (aucun processus), comme ses propres tests unitaires.
 * Chaque `acquire` et chaque `release` du bail sont journalisés dans le journal commun au magasin, pour vérifier l'ordre.
 */
function poolHarness(log: string[], options: { failOpen?: Set<string> } = {}) {
  const browsers = new Map<string, { crash: () => void }>();
  const launch: BrowserLauncher = async (purpose) => {
    const sessionId = purpose.sessionId ?? 'chaud';
    if (options.failOpen?.has(sessionId)) throw new Error('Chromium ne démarre pas');
    let connected = true;
    const listeners: (() => void)[] = [];
    const fake: LaunchedBrowser = {
      id: `fake-${sessionId}`,
      pid: undefined,
      wsEndpoint: 'ws://127.0.0.1:1/x',
      browser: {} as Browser,
      isConnected: () => connected,
      onDisconnected: (listener) => void listeners.push(listener),
      close: async () => void (connected = false),
      kill: async () => void (connected = false),
    };
    browsers.set(sessionId, {
      crash: () => {
        connected = false;
        for (const listener of listeners) listener();
      },
    });
    return fake;
  };
  const pool = new BrowserPool({ slotsTotal: 8, launch, warmBrowsers: 0, constants: PROVISIONAL_CAPACITY, sweepIntervalMs: 0 });
  const destroyed = new Map<string, number>();
  const watchdogs = new Map<string, number | undefined>();
  const tracked: Pick<BrowserPool, 'acquire'> = {
    async acquire(request) {
      log.push(`open ${request.sessionId}`);
      watchdogs.set(request.sessionId, request.watchdogMs);
      const lease = await pool.acquire(request);
      let counted = false;
      return {
        ...lease,
        release: () => {
          if (!counted) {
            counted = true;
            log.push(`destroy ${request.sessionId}`);
            destroyed.set(request.sessionId, (destroyed.get(request.sessionId) ?? 0) + 1);
          }
          return lease.release();
        },
      };
    },
  };
  return { pool, tracked, destroyed, watchdogs, crash: (sessionId: string) => browsers.get(sessionId)?.crash() };
}

function setup(options: { clock?: Clock; failOpen?: Set<string>; failDestroy?: Set<string>; watchdogGraceMs?: number } = {}) {
  const clock = options.clock ?? createManualClock(0);
  const log: string[] = [];
  const store = createMemorySessionStore({ now: () => clock.now() });
  const tracked = {
    ...store,
    async transition(input: Parameters<typeof store.transition>[0]) {
      const outcome = await store.transition(input);
      if (outcome.ok) log.push(`state ${input.sessionId} ${outcome.state}${outcome.endReason ? ` ${outcome.endReason}` : ''}`);
      return outcome;
    },
  };
  const harness = poolHarness(log, options);
  const pool = {
    ...harness,
    // Destruction en erreur simulée au niveau du bail.
    tracked: options.failDestroy
      ? {
          async acquire(request: Parameters<BrowserPool['acquire']>[0]) {
            const lease = await harness.tracked.acquire(request);
            return { ...lease, release: async () => {
              await lease.release();
              if (options.failDestroy?.has(request.sessionId)) throw new Error('destruction incomplète');
            } };
          },
        }
      : harness.tracked,
  };
  const errors: unknown[] = [];
  const supervisor = new SessionSupervisor({ nodeId: 'node-1', pool: pool.tracked, store: tracked, clock, onError: (e) => errors.push(e), ...(options.watchdogGraceMs === undefined ? {} : { watchdogGraceMs: options.watchdogGraceMs }) });
  const records = new Map<string, { expiresAt: number; maxExpiresAt: number }>();
  const create = (sessionId: string, timeoutMs = 300_000, maxDurationSeconds = 3600) => {
    store.create({ sessionId, createdAt: clock.now(), expiresAt: clock.now() + timeoutMs, maxDurationSeconds });
    records.set(sessionId, { expiresAt: clock.now() + timeoutMs, maxExpiresAt: clock.now() + maxDurationSeconds * 1000 });
  };
  /** Démarrage tel que le nœud le reçoit de la passerelle (POST /internal/sessions). */
  const begin = (sessionId: string, idleTimeoutSeconds = 60) =>
    supervisor.start({ sessionId, type: 'dedicated', tenantId: 't1', idleTimeoutSeconds, ...(records.get(sessionId) ?? { expiresAt: 0, maxExpiresAt: 0 }) });
  return { clock, log, store, pool, supervisor, errors, create, begin };
}

describe('démarrage', () => {
  test('bail pris sur le pool puis running sur ce nœud ; lancement impossible : failed crash, slot rendu par le pool', async () => {
    const { supervisor, store, log, create, begin } = setup({ failOpen: new Set(['s2']) });
    create('s1');
    create('s2');
    expect(await begin('s1', 60)).toEqual({ ok: true });
    expect(store.get('s1')).toMatchObject({ state: 'running', nodeId: 'node-1' });
    expect(await begin('s2', 60)).toEqual({ ok: false, code: 'open_failed' });
    expect(store.get('s2')).toMatchObject({ state: 'failed', endReason: 'crash' });
    expect(log).toEqual(['open s1', 'state s1 running', 'open s2', 'state s2 failed crash']);
    expect(supervisor.active()).toEqual(['s1']);
  });

  test('session déjà terminée en base pendant l’ouverture (nœud perdu, file expirée) : navigateur détruit, pas de running', async () => {
    const { supervisor, store, log, create, begin } = setup();
    create('s1');
    await store.transition({ sessionId: 's1', to: 'failed', reason: 'quota' });
    expect(await begin('s1', 60)).toEqual({ ok: false, code: 'invalid_transition' });
    expect(log).toEqual(['open s1', 'destroy s1']);
    expect(supervisor.active()).toEqual([]);
  });
});

describe('assert_session_teardown (BINV3, volet 1.2)', () => {
  const ends: [string, (s: ReturnType<typeof setup>) => Promise<unknown>, SessionState, EndReason][] = [
    ['libération', (s) => s.supervisor.end('s1', 'released'), 'ended', 'released'],
    ['budget atteint', (s) => s.supervisor.end('s1', 'budget_exceeded'), 'ended', 'budget_exceeded'],
    ['minutes épuisées', (s) => s.supervisor.end('s1', 'quota'), 'ended', 'quota'],
    ['délai total', async (s) => s.clock.advance(300_000), 'timed_out', 'timeout'],
    ['inactivité', async (s) => s.clock.advance(60_000), 'timed_out', 'idle'],
    ['plantage de Chromium', async (s) => s.pool.crash('s1'), 'failed', 'crash'],
    ['arrêt du nœud', (s) => s.supervisor.shutdown(), 'ended', 'node_shutdown'],
  ];
  for (const [name, trigger, state, reason] of ends) {
    test(`${name} : destruction unique avant l’état final ${state} (${reason})`, async () => {
      const s = setup();
      s.create('s1');
      await s.begin('s1', 60);
      await trigger(s);
      await flush();
      await s.supervisor.idle();
      expect(s.log.slice(2)).toEqual(['destroy s1', `state s1 ${state} ${reason}`]);
      expect(s.pool.destroyed.get('s1')).toBe(1);
      expect(s.supervisor.active()).toEqual([]);
      // Plus rien ne se déclenche après la fin.
      s.clock.advance(10_000_000);
      await flush();
      expect(s.pool.destroyed.get('s1')).toBe(1);
    });
  }

  test('fins concurrentes (libération, plantage, inactivité) : une destruction, une seule fin', async () => {
    const s = setup();
    s.create('s1');
    await s.begin('s1', 60);
    const release = s.supervisor.end('s1', 'released');
    s.pool.crash('s1');
    s.clock.advance(60_000);
    await release;
    await s.supervisor.idle();
    expect(s.pool.destroyed.get('s1')).toBe(1);
    expect(s.log.filter((l) => l.startsWith('state s1 ') && l !== 'state s1 running')).toEqual(['state s1 ended released']);
  });

  test('destruction en erreur : l’erreur est signalée et l’état final est quand même écrit', async () => {
    const s = setup({ failDestroy: new Set(['s1']) });
    s.create('s1');
    await s.begin('s1', 60);
    await s.supervisor.end('s1', 'released');
    expect(s.store.get('s1')).toMatchObject({ state: 'ended', endReason: 'released' });
    expect(s.errors).toHaveLength(1);
  });

  test('nœud isolé (battement perdu) : sessions locales détruites, aucune écriture (la passerelle les a déclarées node_lost)', async () => {
    const s = setup();
    s.create('s1');
    s.create('s2');
    await s.begin('s1', 60);
    await s.begin('s2', 60);
    await s.supervisor.isolate();
    expect(s.log.slice(4).sort()).toEqual(['destroy s1', 'destroy s2']);
    expect(s.store.get('s1')?.state).toBe('running');
    expect(s.supervisor.active()).toEqual([]);
    s.clock.advance(10_000_000);
    await flush();
    expect(s.pool.destroyed.get('s1')).toBe(1);
  });
});

describe('signaux du pool (interface de la tâche 1.1)', () => {
  test('chien de garde du pool armé sur la durée max du client (plafond des prolongations), plus une marge', async () => {
    const s = setup();
    s.create('s1', 300_000, 600);
    await s.begin('s1', 60);
    expect(s.pool.watchdogs.get('s1')).toBe(600_000 + 5_000);
  });

  test('chien de garde du pool déclenché (`timed_out`) : timed_out raison timeout', async () => {
    const s = setup({ watchdogGraceMs: 20 });
    s.create('s1', 300_000, 0);
    await s.begin('s1', 60);
    // Vrai chien de garde du pool (horloge réelle) : durée max nulle, marge de 20 ms.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await s.supervisor.idle();
    expect(s.store.get('s1')).toMatchObject({ state: 'timed_out', endReason: 'timeout' });
  });

  test('fermeture du pool (arrêt du nœud) : sessions ended raison node_shutdown', async () => {
    const s = setup();
    s.create('s1');
    s.create('s2');
    await s.begin('s1', 60);
    await s.begin('s2', 60);
    await s.pool.pool.close();
    await flush();
    await s.supervisor.idle();
    expect(s.store.get('s1')).toMatchObject({ state: 'ended', endReason: 'node_shutdown' });
    expect(s.store.get('s2')).toMatchObject({ state: 'ended', endReason: 'node_shutdown' });
    expect(s.pool.pool.stats().slotsFree).toBe(8);
  });
});

describe('délais et prolongation', () => {
  test('chaque message du client repousse l’inactivité', async () => {
    const s = setup();
    s.create('s1');
    await s.begin('s1', 60);
    for (let i = 0; i < 5; i += 1) {
      s.clock.advance(50_000);
      s.supervisor.activity('s1');
    }
    await flush();
    expect(s.store.get('s1')?.state).toBe('running');
    s.clock.advance(60_000);
    await flush();
    await s.supervisor.idle();
    expect(s.store.get('s1')).toMatchObject({ state: 'timed_out', endReason: 'idle' });
  });

  test('prolongation : le délai total recule, plafonné par la durée max du client', async () => {
    const s = setup();
    s.create('s1', 100_000, 200);
    await s.begin('s1', 10_000);
    expect(await s.supervisor.extend('s1', 60)).toEqual({ ok: true, expiresAt: 160_000 });
    expect(await s.supervisor.extend('s1', 600)).toEqual({ ok: true, expiresAt: 200_000 });
    s.clock.advance(199_999);
    await flush();
    expect(s.store.get('s1')?.state).toBe('running');
    s.clock.advance(1);
    await flush();
    await s.supervisor.idle();
    expect(s.store.get('s1')).toMatchObject({ state: 'timed_out', endReason: 'timeout' });
  });

  test('message ou prolongation d’une session inconnue du nœud : sans effet', async () => {
    const s = setup();
    s.supervisor.activity('inconnue');
    expect(await s.supervisor.extend('inconnue', 60)).toEqual({ ok: false, code: 'not_found' });
  });
});

describe('idle_timeout_precision (A4)', () => {
  test('horloge réelle : timed_out raison idle à ± 1 s du dernier message', async () => {
    const s = setup({ clock: systemClock });
    s.create('s1');
    await s.begin('s1', 2);
    let lastMessage = 0;
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      s.supervisor.activity('s1');
      lastMessage = Date.now();
    }
    while (s.store.get('s1')?.state === 'running') await new Promise((resolve) => setTimeout(resolve, 20));
    const session = s.store.get('s1');
    expect(session).toMatchObject({ state: 'timed_out', endReason: 'idle' });
    expect(Math.abs((session?.endedAt ?? 0) - lastMessage - 2_000)).toBeLessThanOrEqual(1_000);
  });
});

describe('state_machine_model (A5, fast-check, superviseur)', () => {
  type Cmd =
    | { kind: 'start'; id: number }
    | { kind: 'activity'; id: number }
    | { kind: 'advance'; ms: number }
    | { kind: 'extend'; id: number; seconds: number }
    | { kind: 'end'; id: number; reason: 'released' | 'budget_exceeded' | 'quota' }
    | { kind: 'crash'; id: number }
    | { kind: 'shutdown' };
  const id = fc.integer({ min: 0, max: 3 });
  const cmd: fc.Arbitrary<Cmd> = fc.oneof(
    fc.record({ kind: fc.constant('start' as const), id }),
    fc.record({ kind: fc.constant('activity' as const), id }),
    fc.record({ kind: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 90_000 }) }),
    fc.record({ kind: fc.constant('extend' as const), id, seconds: fc.integer({ min: 1, max: 600 }) }),
    fc.record({ kind: fc.constant('end' as const), id, reason: fc.constantFrom('released' as const, 'budget_exceeded' as const, 'quota' as const) }),
    fc.record({ kind: fc.constant('crash' as const), id }),
    fc.record({ kind: fc.constant('shutdown' as const) }),
  );

  test('commandes aléatoires : transitions dans la table, une destruction par session démarrée et terminée', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(cmd, { maxLength: 40 }), async (cmds) => {
        const s = setup();
        const ids = [0, 1, 2, 3].map((n) => `s${n}`);
        for (const sid of ids) s.create(sid, 120_000);
        for (const c of cmds) {
          const sid = 'id' in c ? `s${c.id}` : '';
          if (c.kind === 'start') await s.begin(sid, 30);
          else if (c.kind === 'activity') s.supervisor.activity(sid);
          else if (c.kind === 'advance') s.clock.advance(c.ms);
          else if (c.kind === 'extend') await s.supervisor.extend(sid, c.seconds);
          else if (c.kind === 'end') await s.supervisor.end(sid, c.reason);
          else if (c.kind === 'crash') s.pool.crash(sid);
          else await s.supervisor.shutdown();
          await flush();
        }
        await s.supervisor.idle();
        for (const sid of ids) {
          let previous: SessionState = 'pending';
          for (const event of s.store.events(sid)) {
            expect(checkTransition(previous, event.state, event.endReason ?? null).ok, `${sid} ${previous}→${event.state}`).toBe(true);
            previous = event.state;
          }
          const final = s.store.get(sid);
          const terminal = final?.state === 'ended' || final?.state === 'timed_out' || final?.state === 'failed';
          const opened = s.log.includes(`open ${sid}`);
          // Toute session ouverte sur le pool puis terminée a été détruite exactement une fois, avant son état final.
          if (opened && terminal) {
            expect(s.pool.destroyed.get(sid)).toBe(1);
            const destroyAt = s.log.indexOf(`destroy ${sid}`);
            const finalAt = s.log.findIndex((l) => l.startsWith(`state ${sid} `) && !l.endsWith('running'));
            if (finalAt >= 0) expect(destroyAt).toBeLessThan(finalAt);
          }
          if (final?.state === 'running') expect(s.supervisor.active()).toContain(sid);
        }
      }),
      { numRuns: 300 },
    );
  });
});
