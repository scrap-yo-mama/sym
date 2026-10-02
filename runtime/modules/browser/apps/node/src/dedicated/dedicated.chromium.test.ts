// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.4 sur de vrais Chromium 153 : Given `type: dedicated` / Then `connectOverCDP` et `connect` fonctionnent ; profil
// temporaire supprimé à la fin. Et, partie 1.4 des invariants : assert_session_teardown (BINV3 : 0 processus Chromium de
// la session, `sessions/{id}` supprimé, port CDP fermé, à la libération, au plantage, au délai et à l'arrêt du nœud) et
// assert_session_isolation (BINV1 : deux sessions dedicated ne partagent ni processus, ni profil, ni cookies, ni cibles CDP).
// Exige un utilisateur non root et les espaces de noms utilisateur (`pnpm --filter @sym-browser/node test:chromium`).
// Sécurité des tests : seul le processus principal d'un Chromium lancé ici est signalé, par son pid exact (plantage simulé) ;
// les groupes sont tués par OwnedProcessGroups, qui refuse tout groupe non enregistré, 0, 1 et le sien.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startClosedLaunchProxy, type ClosedLaunchProxy } from '../pool/closed-proxy.js';
import { playwrightLauncher } from '../pool/launch.js';
import { BrowserPool, type BrowserLauncher, type LaunchedBrowser, type PoolLease } from '../pool/pool.js';
import { OwnedProcessGroups, readProcessTable } from '../pool/process-group.js';
import { dedicatedLauncher } from './dedicated.js';

const isRoot = process.getuid?.() === 0;
let proxy: ClosedLaunchProxy;
const roots: string[] = [];
const tmpBefore = new Set(readdirSync(tmpdir()));

beforeAll(async () => {
  if (isRoot) throw new Error('tests Chromium : lance-les sous un utilisateur non root (le bac à sable de Chromium refuse root, 03 § 7).');
  proxy = await startClosedLaunchProxy();
});
afterAll(async () => {
  await proxy?.close();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function setup(slotsTotal = 4) {
  const groups = new OwnedProcessGroups();
  const dataDir = mkdtempSync(join(tmpdir(), 'symb-data-'));
  roots.push(dataDir);
  const launched = new Map<string, LaunchedBrowser>();
  const base = dedicatedLauncher({ launchProxyUrl: proxy.url, groups, dataDir });
  const launchDedicated: BrowserLauncher = async (purpose) => {
    const browser = await base(purpose);
    launched.set(purpose.sessionId!, browser);
    return browser;
  };
  const pool = new BrowserPool({
    slotsTotal,
    warmBrowsers: 0,
    launch: playwrightLauncher({ launchProxyUrl: proxy.url, groups }),
    launchDedicated,
    sweep: () => groups.sweep(),
    sweepIntervalMs: 0,
  });
  return { groups, dataDir, launched, pool };
}

/** Processus vivants (zombies exclus) du groupe d'un Chromium. */
const alive = (pgid: number) => readProcessTable().filter((p) => p.pgid === pgid && p.state !== 'Z');

function listening(port: number): string[] {
  const hex = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  return ['/proc/net/tcp', '/proc/net/tcp6'].flatMap((file) => {
    let lines: string[] = [];
    try {
      lines = readFileSync(file, 'utf8').split('\n').slice(1);
    } catch {
      return [];
    }
    return lines
      .map((l) => l.trim().split(/\s+/))
      .filter((f) => f[1]?.endsWith(hex) && f[3] === '0A')
      .map((f) => f[1]!.split(':')[0]!);
  });
}

const portOf = (endpoint: string) => Number(new URL(endpoint).port);

function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

/** BINV3 : 0 processus du groupe, répertoire de session supprimé, port CDP fermé. */
async function expectDestroyed(pgid: number, sessionRoot: string, cdpPort: number): Promise<void> {
  expect(alive(pgid), `processus restants du groupe ${pgid}`).toEqual([]);
  expect(existsSync(sessionRoot), sessionRoot).toBe(false);
  expect(await refused(cdpPort), `port CDP ${cdpPort}`).toBe(true);
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const sessionRootOf = (dataDir: string, id: string) => join(dataDir, 'sessions', id);

describe('sessions dedicated sur de vrais Chromium (tâche 1.4)', () => {
  test('Given type dedicated / Then connectOverCDP et connect fonctionnent ; profil temporaire supprimé à la fin', async () => {
    const { pool, launched, dataDir } = setup();
    const id = 'd0c4e5f6-1111-4a4a-8b8b-000000000001';
    const lease = await pool.acquire({ sessionId: id, type: 'dedicated', tenantId: 't-1', launchArgs: ['mute-audio', 'hide-scrollbars'] });
    const chromiumProcess = launched.get(id)!;
    const pid = chromiumProcess.pid!;
    const profile = join(sessionRootOf(dataDir, id), 'profile');

    // CDP sur 127.0.0.1 seulement, chemin de navigateur imprévisible.
    expect(lease.cdpEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]{36}$/);
    expect(lease.wsEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
    const cdpPort = portOf(lease.cdpEndpoint!);
    expect(listening(cdpPort)).toEqual(['0100007F']);

    // Profil temporaire de la session, arguments de la liste fermée, bac à sable actif.
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    expect(cmdline).toContain(`--user-data-dir=${profile}`);
    expect(cmdline).toContain('--remote-debugging-port=0');
    expect(cmdline).toContain('--mute-audio');
    expect(cmdline).toContain('--hide-scrollbars');
    expect(cmdline).not.toContain('--no-sandbox');
    expect(cmdline.some((a) => a.startsWith('--remote-debugging-address'))).toBe(false);
    expect(statSync(profile).mode & 0o777).toBe(0o700);
    expect(statSync(sessionRootOf(dataDir, id)).mode & 0o777).toBe(0o700);

    // Playwright natif (`connect`).
    const viaPlaywright = await chromium.connect(lease.wsEndpoint);
    const context = await viaPlaywright.newContext();
    const page = await context.newPage();
    await page.setContent('<p id="p">bonjour</p>');
    expect(await page.textContent('#p')).toBe('bonjour');

    // CDP (`connectOverCDP`) : même navigateur, contexte par défaut sur le profil de la session.
    const viaCdp = await chromium.connectOverCDP(lease.cdpEndpoint!);
    const cdpPage = await viaCdp.contexts()[0]!.newPage();
    await cdpPage.setContent('<p id="c">cdp</p>');
    expect(await cdpPage.evaluate(() => document.getElementById('c')?.textContent)).toBe('cdp');
    const version = await (await viaCdp.newBrowserCDPSession()).send('Browser.getVersion');
    expect(version.product).toMatch(/^HeadlessChrome\/153\./);

    // Le processus est arrêté AVANT que les clients soient détachés (04c § 3.2, étapes 3 et 4).
    const aliveAtDetach: number[] = [];
    viaCdp.once('disconnected', () => aliveAtDetach.push(alive(pid).length));
    viaPlaywright.once('disconnected', () => aliveAtDetach.push(alive(pid).length));

    await lease.release();
    await expectDestroyed(pid, sessionRootOf(dataDir, id), cdpPort);
    await waitFor(() => aliveAtDetach.length === 2);
    expect(aliveAtDetach).toEqual([0, 0]);
    expect(readdirSync(join(dataDir, 'sessions'))).toEqual([]);
    await pool.close();
  });

  test('assert_session_teardown (1.4) : libération, plantage, délai de session, arrêt du nœud → 0 processus, sessions/{id} supprimé', async () => {
    const { pool, launched, dataDir } = setup(4);
    const ids = ['released', 'crash', 'timeout', 'shutdown'].map((name, i) => ({ name, id: `teardown-${i}-${name}` }));
    const leases = new Map<string, PoolLease>();
    for (const { name, id } of ids) {
      leases.set(name, await pool.acquire({ sessionId: id, type: 'dedicated', tenantId: 't-1', ...(name === 'timeout' ? { watchdogMs: 800 } : {}) }));
    }
    const info = new Map(ids.map(({ name, id }) => [name, { id, pid: launched.get(id)!.pid!, port: portOf(leases.get(name)!.cdpEndpoint!) }]));
    // Chaque session écrit dans son profil (cookies) : le répertoire n'est pas vide quand vient la destruction.
    for (const [name, lease] of leases) {
      const viaCdp = await chromium.connectOverCDP(lease.cdpEndpoint!);
      // Connexion laissée ouverte : la destruction doit la couper elle-même.
      await viaCdp.contexts()[0]!.addCookies([{ name: 'sid', value: `zz_test_${name}`, url: 'https://fixture.test/' }]);
    }

    // Libération.
    await leases.get('released')!.release();
    await expectDestroyed(info.get('released')!.pid, sessionRootOf(dataDir, info.get('released')!.id), info.get('released')!.port);

    // Plantage : SIGKILL du seul processus principal de ce Chromium (pid exact, lancé par ce test).
    const crash = info.get('crash')!;
    process.kill(crash.pid, 'SIGKILL');
    await waitFor(() => leases.get('crash')!.signal.aborted);
    expect(leases.get('crash')!.signal.reason).toBe('crash');
    await pool.whenIdle();
    await expectDestroyed(crash.pid, sessionRootOf(dataDir, crash.id), crash.port);

    // Délai de session (chien de garde).
    await waitFor(() => leases.get('timeout')!.signal.aborted);
    expect(leases.get('timeout')!.signal.reason).toBe('timed_out');
    await pool.whenIdle();
    const timeout = info.get('timeout')!;
    await expectDestroyed(timeout.pid, sessionRootOf(dataDir, timeout.id), timeout.port);

    // Arrêt du nœud.
    await pool.close();
    expect(leases.get('shutdown')!.signal.reason).toBe('shutdown');
    const shutdown = info.get('shutdown')!;
    await expectDestroyed(shutdown.pid, sessionRootOf(dataDir, shutdown.id), shutdown.port);

    expect(readdirSync(join(dataDir, 'sessions'))).toEqual([]);
    expect(pool.stats().slotsFree).toBe(4);
  });

  test('assert_session_teardown (1.4) : 20 cycles acquérir-libérer → 0 processus orphelin, 0 répertoire, rien dans le répertoire temporaire', async () => {
    const { pool, launched, dataDir } = setup(2);
    for (let i = 0; i < 20; i += 1) {
      const lease = await pool.acquire({ sessionId: `cycle-${i}`, type: 'dedicated', tenantId: `t-${i % 3}` });
      await lease.release();
    }
    await pool.close();
    for (const browser of launched.values()) expect(alive(browser.pid!)).toEqual([]);
    expect(readdirSync(join(dataDir, 'sessions'))).toEqual([]);
    const leftovers = readdirSync(tmpdir()).filter((name) => !tmpBefore.has(name) && /^playwright[_-]/.test(name));
    expect(leftovers).toEqual([]);
  });

  test('assert_session_isolation (1.4) : deux sessions dedicated, deux processus, deux profils, aucun cookie ni cible CDP partagés', async () => {
    const { pool, launched, dataDir } = setup(2);
    const a = await pool.acquire({ sessionId: 'iso-a', type: 'dedicated', tenantId: 't-a' });
    const b = await pool.acquire({ sessionId: 'iso-b', type: 'dedicated', tenantId: 't-b' });
    try {
      const pa = launched.get('iso-a')!;
      const pb = launched.get('iso-b')!;
      expect(pa.pid).not.toBe(pb.pid);
      expect(a.cdpEndpoint).not.toBe(b.cdpEndpoint);
      expect(readFileSync(`/proc/${pa.pid}/cmdline`, 'utf8')).toContain(join(dataDir, 'sessions', 'iso-a', 'profile'));
      expect(readFileSync(`/proc/${pb.pid}/cmdline`, 'utf8')).toContain(join(dataDir, 'sessions', 'iso-b', 'profile'));

      const ca = await chromium.connectOverCDP(a.cdpEndpoint!);
      const cb = await chromium.connectOverCDP(b.cdpEndpoint!);
      await ca.contexts()[0]!.addCookies([{ name: 'sid', value: 'zz_test_a', url: 'https://fixture.test/' }]);
      const pageB = await cb.contexts()[0]!.newPage();
      await pageB.goto('about:blank#session-b');
      expect(await cb.contexts()[0]!.cookies('https://fixture.test/')).toEqual([]);

      // Cible `browser` de A : elle n'énumère que les cibles de son propre Chromium.
      const targets = (await (await ca.newBrowserCDPSession()).send('Target.getTargets')).targetInfos;
      expect(targets.some((t) => t.url.includes('session-b'))).toBe(false);
    } finally {
      await a.release();
      await b.release();
      await pool.close();
    }
  });
});
