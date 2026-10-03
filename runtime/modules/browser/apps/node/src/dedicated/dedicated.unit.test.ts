// SPDX-License-Identifier: AGPL-3.0-only
// Sessions `dedicated` sans navigateur (tâche 1.4) : répertoire de session, lecture de `DevToolsActivePort` (CDP sur
// 127.0.0.1 seulement), ordre de destruction (04c § 3.2 : processus tué AVANT le détachement et la suppression du
// répertoire), branchement sur le pool de la tâche 1.1 (`launchDedicated`, `cdpEndpoint`, `launchArgs`).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { afterAll, describe, expect, test } from 'vitest';
import { BrowserPool, type BrowserLauncher, type LaunchedBrowser, type LaunchPurpose } from '../pool/pool.js';
import { createDedicatedTeardown, DEDICATED_TEARDOWN_TIMEOUT_MS, parseDevToolsActivePort, sessionDir, SessionDirError } from './dedicated.js';

const roots: string[] = [];
const newRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'symb-data-'));
  roots.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe('répertoire de session : SYMB_DATA_DIR/sessions/{id}', () => {
  test('chemin sous la racine, profil, artefacts et téléchargements dedans', () => {
    const dir = sessionDir('/data', '3f2b6c1e-8d4a-4f7b-9a1c-2e5d7f9b0c13');
    expect(dir).toEqual({
      root: '/data/sessions/3f2b6c1e-8d4a-4f7b-9a1c-2e5d7f9b0c13',
      profile: '/data/sessions/3f2b6c1e-8d4a-4f7b-9a1c-2e5d7f9b0c13/profile',
      artifacts: '/data/sessions/3f2b6c1e-8d4a-4f7b-9a1c-2e5d7f9b0c13/artifacts',
      downloads: '/data/sessions/3f2b6c1e-8d4a-4f7b-9a1c-2e5d7f9b0c13/downloads',
    });
  });

  test('identifiant hors format ou racine relative refusés (aucune sortie de sessions/)', () => {
    for (const id of ['', '.', '..', '../x', 'a/b', 'a\\b', '/abs', 'x'.repeat(129), 'sp ace', 'é']) {
      expect(() => sessionDir('/data', id), id).toThrow(SessionDirError);
    }
    expect(() => sessionDir('data', 'abc')).toThrow(SessionDirError);
  });
});

describe('DevToolsActivePort : point CDP local', () => {
  test('port et chemin du navigateur → ws://127.0.0.1', () => {
    expect(parseDevToolsActivePort('39385\n/devtools/browser/d67a1c09-036f-486c-b1ed-21b3aa90535d\n')).toEqual({
      port: 39385,
      path: '/devtools/browser/d67a1c09-036f-486c-b1ed-21b3aa90535d',
      endpoint: 'ws://127.0.0.1:39385/devtools/browser/d67a1c09-036f-486c-b1ed-21b3aa90535d',
    });
  });

  test('contenu partiel ou inattendu refusé (fichier en cours d’écriture, chemin étranger)', () => {
    for (const content of ['', '39385', '39385\n', '0\n/devtools/browser/x', '70000\n/devtools/browser/abc', 'abc\n/devtools/browser/abc', '9222\n/devtools/page/abc', '9222\n/devtools/browser/../x']) {
      expect(parseDevToolsActivePort(content), JSON.stringify(content)).toBeUndefined();
    }
  });
});

describe('destruction d’une session dedicated (04c § 3.2, BINV3)', () => {
  function fakeSteps(opts: { killOk?: boolean; groupEmptyAfter?: boolean } = {}) {
    const order: string[] = [];
    const root = newRoot();
    const dir = sessionDir(root, 's-1');
    mkdirSync(dir.profile, { recursive: true });
    writeFileSync(join(dir.profile, 'Cookies'), 'secret-cookie');
    let alive = true;
    const teardown = createDedicatedTeardown({
      dir,
      killGroup: async () => {
        order.push('kill');
        if (opts.killOk ?? true) alive = false;
        return opts.killOk ?? true;
      },
      killFallback: async () => {
        order.push('fallback');
        if (opts.groupEmptyAfter ?? true) alive = false;
      },
      groupAlive: () => alive,
      disconnect: async () => {
        order.push(`disconnect(alive=${alive})`);
      },
    });
    return { order, dir, teardown };
  }

  test('ordre : SIGKILL du groupe, puis détachement du client, puis suppression récursive de sessions/{id}', async () => {
    const { order, dir, teardown } = fakeSteps();
    await teardown();
    expect(order).toEqual(['kill', 'disconnect(alive=false)']);
    expect(existsSync(dir.root)).toBe(false);
  });

  test('idempotente : deux appels, une seule destruction', async () => {
    const { order, teardown } = fakeSteps();
    await Promise.all([teardown(), teardown()]);
    await teardown();
    expect(order).toEqual(['kill', 'disconnect(alive=false)']);
  });

  test('groupe récalcitrant : arrêt de secours, répertoire supprimé quand même', async () => {
    const { order, dir, teardown } = fakeSteps({ killOk: false });
    await teardown();
    expect(order).toEqual(['kill', 'fallback', 'disconnect(alive=false)']);
    expect(existsSync(dir.root)).toBe(false);
  });

  test('processus toujours vivant après secours : erreur (le pool compte un close_timeout et retue), répertoire supprimé', async () => {
    const { dir, teardown } = fakeSteps({ killOk: false, groupEmptyAfter: false });
    await expect(teardown()).rejects.toThrow(/processus/);
    expect(existsSync(dir.root)).toBe(false);
  });

  test('délai de destruction visé : 5 s', () => {
    expect(DEDICATED_TEARDOWN_TIMEOUT_MS).toBe(5_000);
  });
});

describe('pool (tâche 1.1) : sessions dedicated branchées sur launchDedicated', () => {
  function fakeLauncher(role: 'warm' | 'dedicated') {
    const purposes: LaunchPurpose[] = [];
    let n = 0;
    const launch: BrowserLauncher = async (purpose) => {
      purposes.push(purpose);
      n += 1;
      const launched: LaunchedBrowser = {
        id: `${role}-${n}`,
        pid: undefined,
        wsEndpoint: `ws://127.0.0.1:1/${role}-${n}`,
        ...(role === 'dedicated' ? { cdpEndpoint: `ws://127.0.0.1:2/devtools/browser/${n}` } : {}),
        browser: {} as Browser,
        isConnected: () => true,
        onDisconnected: () => {},
        close: async () => {},
        kill: async () => {},
      };
      return launched;
    };
    return { launch, purposes };
  }

  test('lease dedicated : cdpEndpoint et launchArgs transmis au lanceur ; shared : pas de CDP', async () => {
    const warm = fakeLauncher('warm');
    const dedicated = fakeLauncher('dedicated');
    const pool = new BrowserPool({ slotsTotal: 4, warmBrowsers: 0, launch: warm.launch, launchDedicated: dedicated.launch });
    const lease = await pool.acquire({ sessionId: 's-1', type: 'dedicated', tenantId: 't-1', launchArgs: ['mute-audio'] });
    expect(lease.cdpEndpoint).toBe('ws://127.0.0.1:2/devtools/browser/1');
    expect(dedicated.purposes).toEqual([{ role: 'dedicated', sessionId: 's-1', launchArgs: ['mute-audio'] }]);
    const shared = await pool.acquire({ sessionId: 's-2', type: 'shared', tenantId: 't-1' });
    expect(shared.cdpEndpoint).toBeUndefined();
    await lease.release();
    await shared.release();
    await pool.close();
  });

  test('launchArgs sur une session shared : refus (la bascule se fait avant le pool)', async () => {
    const pool = new BrowserPool({ slotsTotal: 2, warmBrowsers: 0, launch: fakeLauncher('warm').launch });
    await expect(pool.acquire({ sessionId: 's-3', type: 'shared', tenantId: 't-1', launchArgs: ['mute-audio'] })).rejects.toThrow(/dedicated/);
    expect(pool.stats().slotsFree).toBe(2);
    await pool.close();
  });
});
