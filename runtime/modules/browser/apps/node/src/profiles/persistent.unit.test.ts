// SPDX-License-Identifier: AGPL-3.0-only
// Profil persistant d'une session dedicated, sans navigateur (cdc/sym-browser 04c § 3.2 et § 4.2, tâche 3.1) :
// - fin normale : Chromium fermé proprement (flush des bases) AVANT la sauvegarde, puis destruction ; le verrou est libéré
//   par la sauvegarde (ou, si elle échoue, juste après) ;
// - plantage, délai de fermeture dépassé : destruction sans sauvegarde, la dernière version valide reste, verrou libéré ;
// - le profil n'est accepté que pour une session dedicated et suit la demande jusqu'au lanceur.
import { describe, expect, test } from 'vitest';
import { BrowserPool, type BrowserLauncher, type LaunchedBrowser, type LaunchPurpose } from '../pool/pool.js';
import { createPersistentTeardown } from './persistent.js';

function steps(opts: { saveFails?: boolean; gracefulHangs?: boolean } = {}) {
  const order: string[] = [];
  let releaseGraceful: () => void = () => undefined;
  const handle = createPersistentTeardown({
    teardown: async () => {
      order.push('teardown');
    },
    gracefulClose: () => {
      order.push('graceful');
      return opts.gracefulHangs ? new Promise<void>((resolve) => (releaseGraceful = resolve)) : Promise.resolve();
    },
    save: async () => {
      order.push('save');
      if (opts.saveFails) throw new Error('stockage indisponible');
    },
    abandon: async () => {
      order.push('abandon');
    },
  });
  return { order, handle, releaseGraceful: () => releaseGraceful() };
}

describe('createPersistentTeardown', () => {
  test('fin normale : fermeture propre, sauvegarde, puis destruction ; idempotent', async () => {
    const { order, handle } = steps();
    await handle.close();
    await handle.close();
    await handle.kill();
    expect(order).toEqual(['graceful', 'save', 'teardown']);
  });

  test('sauvegarde en échec : destruction quand même, verrou abandonné (version précédente intacte)', async () => {
    const { order, handle } = steps({ saveFails: true });
    await handle.close();
    expect(order).toEqual(['graceful', 'save', 'teardown', 'abandon']);
  });

  test('plantage : destruction sans sauvegarde, puis verrou abandonné', async () => {
    const { order, handle } = steps();
    await handle.kill();
    await handle.close();
    expect(order).toEqual(['teardown', 'abandon']);
  });

  test('kill pendant une fermeture qui traîne (délai du pool dépassé) : aucune sauvegarde, destruction, abandon', async () => {
    const { order, handle, releaseGraceful } = steps({ gracefulHangs: true });
    const closing = handle.close();
    await Promise.resolve();
    await handle.kill();
    releaseGraceful();
    await closing;
    expect(order).toEqual(['graceful', 'teardown', 'abandon']);
  });
});

describe('pool : le profil suit la demande jusqu’au lanceur dedicated', () => {
  function fake(purpose: LaunchPurpose): LaunchedBrowser {
    return {
      id: `fake-${purpose.sessionId}`,
      pid: undefined,
      wsEndpoint: 'ws://127.0.0.1:1/x',
      cdpEndpoint: 'ws://127.0.0.1:2/devtools/browser/x',
      browser: {} as never,
      isConnected: () => true,
      onDisconnected: () => undefined,
      close: async () => undefined,
      kill: async () => undefined,
    };
  }

  test('dedicated : profile transmis tel quel ; shared : refusé avant tout lancement', async () => {
    const seen: LaunchPurpose[] = [];
    const launchDedicated: BrowserLauncher = async (purpose) => {
      seen.push(purpose);
      return fake(purpose);
    };
    const pool = new BrowserPool({ slotsTotal: 4, warmBrowsers: 0, launch: launchDedicated, launchDedicated, sweepIntervalMs: 0 });
    const profile = { tenantId: 't-1', profileId: 'p-1', mode: 'write' as const };
    const lease = await pool.acquire({ sessionId: 's-1', type: 'dedicated', tenantId: 't-1', profile });
    expect(seen).toEqual([{ role: 'dedicated', sessionId: 's-1', profile }]);
    await expect(pool.acquire({ sessionId: 's-2', type: 'shared', tenantId: 't-1', profile })).rejects.toThrow(/profil/);
    expect(seen).toHaveLength(1);
    await lease.release();
    await pool.close();
  });

  test('le profil d’une autre session ou d’un autre client ne peut pas être demandé : tenantId du profil = celui de la session', async () => {
    const launchDedicated: BrowserLauncher = async (purpose) => fake(purpose);
    const pool = new BrowserPool({ slotsTotal: 4, warmBrowsers: 0, launch: launchDedicated, launchDedicated, sweepIntervalMs: 0 });
    await expect(pool.acquire({ sessionId: 's-3', type: 'dedicated', tenantId: 't-1', profile: { tenantId: 't-2', profileId: 'p', mode: 'read' } })).rejects.toThrow(/client/);
    await pool.close();
  });
});
