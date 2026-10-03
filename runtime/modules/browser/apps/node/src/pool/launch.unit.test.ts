// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.1 (04b § 1, 03 § 7, 04c § 1.1) : options de `launchServer` figées, environnement réduit, jamais en root ; kill de
// groupe limité aux groupes lancés par le pool.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ChromiumAsRootError, CHROMIUM_FROZEN_ARGS, assertNotRoot, chromiumEnv, chromiumLaunchOptions } from './launch.js';
import { OwnedProcessGroups, readProcessTable } from './process-group.js';

describe('options de lancement figées (launchServer local)', () => {
  test('127.0.0.1, bac à sable actif, proxy de lancement fermé local, signaux gardés par le nœud, délai de lancement', () => {
    const o = chromiumLaunchOptions('http://127.0.0.1:41234', { PATH: '/usr/bin' });
    expect(o).toMatchObject({ headless: true, chromiumSandbox: true, host: '127.0.0.1', proxy: { server: 'http://127.0.0.1:41234' }, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, timeout: 60_000 });
    expect(o.args).toContain('--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1');
    expect(o.args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    expect(o.args).toContain('--disable-dev-shm-usage');
    expect(o.args.some((a) => a === '--no-sandbox' || a.startsWith('--remote-debugging') || a.startsWith('--proxy-bypass-list'))).toBe(false);
    // Aucune option ne vient d'un client : la fonction ne reçoit que l'URL du proxy fermé.
    expect(Object.isFrozen(o) && Object.isFrozen(o.args) && Object.isFrozen(CHROMIUM_FROZEN_ARGS)).toBe(true);
    // wsPath absent : Playwright tire un chemin aléatoire (vérifié sur un vrai Chromium dans pool.chromium.test.ts).
    expect('wsPath' in o).toBe(false);
  });

  test('proxy de lancement : uniquement http://127.0.0.1:<port> ; variable de bouclage forcé interdite', () => {
    for (const bad of ['http://10.0.0.1:3128', 'https://127.0.0.1:1', 'http://127.0.0.1', 'http://user:pw@127.0.0.1:1', 'socks5://127.0.0.1:1']) {
      expect(() => chromiumLaunchOptions(bad, {})).toThrow();
    }
    expect(() => chromiumLaunchOptions('http://127.0.0.1:1', { PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK: '1' })).toThrow(/PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK/);
  });

  test('--disable-features unique qui reprend la liste de Playwright 1.63 installée', () => {
    const o = chromiumLaunchOptions('http://127.0.0.1:41234', {});
    const flags = o.args.filter((a) => a.startsWith('--disable-features='));
    expect(flags).toHaveLength(1);
    const ours = flags[0]!.slice('--disable-features='.length).split(',');
    const bundle = readFileSync(join(dirname(createRequire(import.meta.url).resolve('playwright-core')), 'lib', 'coreBundle.js'), 'utf8');
    const list = /disabledFeatures = \[([\s\S]*?)\]\.filter\(Boolean\)/.exec(bundle);
    expect(list).not.toBeNull();
    const playwright = [...list![1]!.matchAll(/^\s*"([A-Za-z0-9]+)",?\s*$/gm)].map((m) => m[1]!);
    expect(playwright.length).toBeGreaterThan(5);
    for (const feature of playwright) expect(ours).toContain(feature);
  });

  test('environnement de Chromium réduit à une liste blanche : ni MASTER_KEY, ni DATABASE_URL, ni NODE_TOKEN', () => {
    const env = chromiumEnv({ PATH: '/bin', HOME: '/home/pwuser', MASTER_KEY: 'zz', DATABASE_URL: 'postgres://zz', NODE_TOKEN: 'zz', MASTER_KEY_FILE: '/run/zz', SYMB_MODE: 'all' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/pwuser' });
  });

  test('jamais en root (le bac à sable exigerait --no-sandbox)', () => {
    expect(() => assertNotRoot(() => 0)).toThrow(ChromiumAsRootError);
    expect(() => assertNotRoot(() => 1001)).not.toThrow();
  });
});

describe('groupes de processus possédés par le pool', () => {
  test('refuse tout groupe qu’il n’a pas enregistré, son propre groupe, 0 et 1 (jamais kill -1 ni kill 0)', async () => {
    const signals: [number, string][] = [];
    const groups = new OwnedProcessGroups({ signal: (pid, sig) => void signals.push([pid, sig]), table: () => [] });
    for (const pgid of [0, 1, -1, 1.5, process.pid, Number.NaN]) expect(() => groups.add(pgid)).toThrow(RangeError);
    expect(await groups.kill(4242)).toBe(false);
    expect(signals).toEqual([]);
  });

  // Groupes factices au-delà de pid_max (4 194 304) : jamais le pid ni le groupe du processus de test (sur un runner, 8000
  // pouvait l'être).
  test('kill : SIGKILL au groupe enregistré, attente de sa disparition, oubli une fois vide ; balayage des groupes retirés non vides', async () => {
    let alive = [{ pid: 5005000, pgid: 5005000, state: 'S' }, { pid: 5005001, pgid: 5005000, state: 'S' }, { pid: 5006000, pgid: 5006000, state: 'S' }];
    const signals: [number, string][] = [];
    const groups = new OwnedProcessGroups({
      signal: (pid, sig) => {
        signals.push([pid, sig]);
        alive = alive.filter((p) => p.pgid !== -pid);
      },
      table: () => alive,
      pollMs: 1,
    });
    groups.add(5005000);
    expect(groups.members(5005000)).toEqual([5005000, 5005001]);
    expect(await groups.kill(5005000)).toBe(true);
    expect(signals).toEqual([[-5005000, 'SIGKILL']]);
    expect(groups.owned()).toEqual([]);
    // Groupe retiré (fermeture propre) dont un processus survit : le balayage le tue ; groupe vide : oublié sans signal.
    alive.push({ pid: 5007001, pgid: 5007000, state: 'S' });
    groups.add(5007000);
    groups.add(5008000);
    groups.retire(5007000);
    groups.retire(5008000);
    expect(await groups.sweep()).toEqual([5007000]);
    expect(signals).toEqual([[-5005000, 'SIGKILL'], [-5007000, 'SIGKILL']]);
    expect(groups.owned()).toEqual([]);
    // Un zombie ne compte pas comme membre vivant.
    alive.push({ pid: 5009000, pgid: 5009000, state: 'Z' });
    groups.add(5009000);
    expect(groups.members(5009000)).toEqual([]);
  });

  test('table des processus lue dans /proc (Linux) : ce processus y figure avec son groupe', () => {
    if (process.platform !== 'linux') return;
    const self = readProcessTable().find((p) => p.pid === process.pid);
    expect(self).toBeDefined();
    expect(Number.isInteger(self!.pgid)).toBe(true);
  });
});
