// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.3 : cycle de vie d'une session shared (contexte neuf dans un Chromium chaud du pool), piloté par un pool simulé.
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext } from 'playwright-core';
import { describe, expect, test } from 'vitest';
import type { AcquireRequest, PoolLease } from '../pool/index.js';
import { InvalidSessionOptionError } from './options.js';
import { SharedSessions, type SharedSessionEnd } from './shared.js';

type FakeContext = { options: unknown; closed: boolean; hang: boolean };

function fakePool(behaviour: { newContextFails?: boolean; hangOnClose?: boolean } = {}) {
  const log: string[] = [];
  const contexts: FakeContext[] = [];
  const controllers = new Map<string, AbortController>();
  const pool = {
    acquire: async (request: AcquireRequest): Promise<PoolLease> => {
      log.push(`acquire ${request.sessionId} ${request.type} ${request.tenantId} ${request.watchdogMs ?? '-'}`);
      const controller = new AbortController();
      controllers.set(request.sessionId, controller);
      const browser = {
        newContext: async (options: unknown) => {
          if (behaviour.newContextFails === true) throw new Error('contexte impossible');
          const fake: FakeContext = { options, closed: false, hang: behaviour.hangOnClose === true };
          contexts.push(fake);
          log.push(`newContext ${request.sessionId}`);
          return {
            close: () => {
              log.push(`context.close ${request.sessionId}`);
              if (fake.hang) return new Promise<void>(() => undefined);
              fake.closed = true;
              return Promise.resolve();
            },
          } as unknown as BrowserContext;
        },
      } as unknown as Browser;
      let released = false;
      return {
        sessionId: request.sessionId,
        type: request.type,
        tenantId: request.tenantId,
        browserId: `b-${request.tenantId}`,
        wsEndpoint: 'ws://127.0.0.1:1/x',
        cdpEndpoint: undefined,
        browser,
        signal: controller.signal,
        release: async () => {
          if (released) return;
          released = true;
          log.push(`release ${request.sessionId}`);
        },
      };
    },
  };
  return { pool, log, contexts, controllers };
}

describe('sessions shared : contexte neuf par session (04b § 1, 04c § 3.1)', () => {
  test('création : slot shared du client, contexte neuf avec les options ; libération : contexte fermé AVANT le slot rendu', async () => {
    const { pool, log, contexts } = fakePool();
    const ends: SharedSessionEnd[] = [];
    const sessions = new SharedSessions({ pool, onEnd: (end) => ends.push(end) });
    const s = await sessions.create({ sessionId: 's1', tenantId: 'A', options: { locale: 'fr-FR' }, watchdogMs: 120_000 });
    expect(s).toMatchObject({ sessionId: 's1', tenantId: 'A', type: 'shared', browserId: 'b-A', protocols: { playwright: true, cdp: false, bidi: false }, endReason: null });
    expect(contexts[0]!.options).toMatchObject({ locale: 'fr-FR', viewport: { width: 1280, height: 720 } });
    expect(sessions.get('s1')).toBe(s);
    await s.release();
    await s.release();
    expect(log).toEqual(['acquire s1 shared A 120000', 'newContext s1', 'context.close s1', 'release s1']);
    expect(s.endReason).toBe('released');
    expect(ends).toEqual([{ sessionId: 's1', tenantId: 'A', reason: 'released' }]);
    expect(sessions.get('s1')).toBeUndefined();
  });

  test('options invalides : refus avant toute réservation de slot', async () => {
    const { pool, log } = fakePool();
    const sessions = new SharedSessions({ pool });
    await expect(sessions.create({ sessionId: 's1', tenantId: 'A', options: { timezoneId: 'Mars/Olympus' } })).rejects.toThrow(InvalidSessionOptionError);
    expect(log).toEqual([]);
  });

  test('identifiant déjà pris sur ce nœud : refus, la session existante est intacte', async () => {
    const { pool } = fakePool();
    const sessions = new SharedSessions({ pool });
    const s = await sessions.create({ sessionId: 's1', tenantId: 'A', options: {} });
    await expect(sessions.create({ sessionId: 's1', tenantId: 'B', options: {} })).rejects.toThrow(/s1/);
    expect(sessions.get('s1')).toBe(s);
  });

  test('contexte impossible à créer : slot rendu, erreur remontée', async () => {
    const { pool, log } = fakePool({ newContextFails: true });
    const sessions = new SharedSessions({ pool });
    await expect(sessions.create({ sessionId: 's1', tenantId: 'A', options: {} })).rejects.toThrow('contexte impossible');
    expect(log).toEqual(['acquire s1 shared A -', 'release s1']);
    expect(sessions.get('s1')).toBeUndefined();
  });

  test('fin imposée par le pool : crash → crash, chien de garde → timeout, arrêt du nœud → node_shutdown', async () => {
    const { pool, controllers, contexts } = fakePool();
    const ends: SharedSessionEnd[] = [];
    const sessions = new SharedSessions({ pool, onEnd: (end) => ends.push(end) });
    for (const id of ['c', 't', 'n']) await sessions.create({ sessionId: id, tenantId: 'A', options: {} });
    controllers.get('c')!.abort('crash');
    controllers.get('t')!.abort('timed_out');
    controllers.get('n')!.abort('shutdown');
    await sessions.whenIdle();
    expect(ends).toEqual([
      { sessionId: 'c', tenantId: 'A', reason: 'crash' },
      { sessionId: 't', tenantId: 'A', reason: 'timeout' },
      { sessionId: 'n', tenantId: 'A', reason: 'node_shutdown' },
    ]);
    expect(contexts.every((c) => c.closed)).toBe(true);
    expect(sessions.get('c')?.endReason ?? 'gone').toBe('gone');
  });

  test('contexte qui ne se ferme pas : le slot est rendu au délai dur (le pool tue le Chromium si besoin)', async () => {
    const { pool, log } = fakePool({ hangOnClose: true });
    const sessions = new SharedSessions({ pool, closeTimeoutMs: 20 });
    const s = await sessions.create({ sessionId: 's1', tenantId: 'A', options: {} });
    await s.release();
    expect(log.at(-1)).toBe('release s1');
  });

  test('répertoire de session (04c § 3.1) : sessions/{id}/downloads créé en 0700 à la création, supprimé avant que le slot soit rendu', async () => {
    const { pool, log } = fakePool();
    const dataDir = mkdtempSync(join(tmpdir(), 'symb-shared-'));
    const root = join(dataDir, 'sessions', 's1');
    const sessions = new SharedSessions({ pool, dataDir });
    const s = await sessions.create({ sessionId: 's1', tenantId: 'A', options: {} });
    expect(statSync(join(root, 'downloads')).mode & 0o777).toBe(0o700);
    writeFileSync(join(root, 'downloads', 'reste.bin'), 'x');
    const release = s.release();
    await release;
    expect(existsSync(root)).toBe(false);
    expect(log.slice(-2)).toEqual(['context.close s1', 'release s1']);
    await expect(sessions.create({ sessionId: '../x', tenantId: 'A', options: {} })).rejects.toThrow();
  });
});
