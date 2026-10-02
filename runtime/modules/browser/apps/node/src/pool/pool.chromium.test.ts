// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.1 sur de vrais Chromium 153 (launchServer, bac à sable actif) : P1 `pool_no_orphans`, P6 `kill_on_close_timeout`,
// options de lancement effectives. Exige un utilisateur non root et les espaces de noms utilisateur (bac à sable) ; lancé par
// `pnpm --filter @sym-browser/node test:chromium` (étape « Chromium réels » de la CI locale du module).
// Sécurité des tests : seuls les processus lancés ici sont signalés, par leur pid exact (SIGSTOP) ou par leur groupe, que
// le pool a enregistré au lancement (OwnedProcessGroups refuse tout autre groupe, 0, 1 et le sien).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PROVISIONAL_CAPACITY } from './capacity.js';
import { startClosedLaunchProxy, type ClosedLaunchProxy } from './closed-proxy.js';
import { playwrightLauncher } from './launch.js';
import { BrowserPool, type BrowserLauncher, type LaunchedBrowser, type PoolEvent, type PoolLease, type RecycleReason } from './pool.js';
import { OwnedProcessGroups, readProcessTable } from './process-group.js';

const isRoot = process.getuid?.() === 0;

let proxy: ClosedLaunchProxy;
beforeAll(async () => {
  if (isRoot) throw new Error('tests Chromium : lance-les sous un utilisateur non root (le bac à sable de Chromium refuse root, 03 § 7).');
  proxy = await startClosedLaunchProxy();
});
afterAll(async () => proxy?.close());

/** Lanceur réel instrumenté : garde chaque Chromium lancé (pid de son groupe) pour la vérification d'orphelins. */
function recordingLauncher(groups: OwnedProcessGroups, env: Readonly<Record<string, string | undefined>> = process.env) {
  const launched: LaunchedBrowser[] = [];
  const base = playwrightLauncher({ launchProxyUrl: proxy.url, env, groups });
  const launch: BrowserLauncher = async (purpose) => {
    const browser = await base(purpose);
    launched.push(browser);
    return browser;
  };
  return { launch, launched };
}

/** Processus vivants (zombies exclus) dans l'un des groupes donnés, ou enfants directs de ce processus de test. */
function survivors(pgids: ReadonlySet<number>): { pid: number; pgid: number; ppid: number; comm: string }[] {
  return readProcessTable().filter((p) => p.state !== 'Z' && p.pid !== process.pid && (pgids.has(p.pgid) || (p.ppid === process.pid && /chrom|headless/i.test(p.comm))));
}

async function useOnce(lease: PoolLease): Promise<void> {
  const context = await lease.browser.newContext();
  await context.close();
}

describe('pool de Chromium chauds sur de vrais Chromium', () => {
  test('launchServer local : 127.0.0.1, chemin imprévisible, bac à sable actif, arguments figés, environnement réduit, proxy de lancement fermé', async () => {
    const groups = new OwnedProcessGroups();
    const { launch, launched } = recordingLauncher(groups, { ...process.env, MASTER_KEY: 'zz-not-a-key', DATABASE_URL: 'postgres://zz', NODE_TOKEN: 'zz' });
    const pool = new BrowserPool({ slotsTotal: 1, warmBrowsers: 1, launch, constants: PROVISIONAL_CAPACITY, sweep: () => groups.sweep() });
    await pool.start();
    try {
      const chromium = launched[0]!;
      expect(chromium.wsEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
      const pid = chromium.pid!;
      expect(groups.owned()).toContain(pid);
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      expect(cmdline).not.toContain('--no-sandbox');
      expect(cmdline).toContain('--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1');
      expect(cmdline).toContain(`--proxy-server=${proxy.url}`);
      const environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
      for (const secret of ['MASTER_KEY', 'DATABASE_URL', 'NODE_TOKEN']) expect(environ).not.toContain(`${secret}=`);
      // Bac à sable : le processus de rendu tourne dans d'autres espaces de noms que le processus principal.
      const lease = await pool.acquire({ sessionId: 's', type: 'shared', tenantId: 'A' });
      const context = await lease.browser.newContext();
      const page = await context.newPage();
      const before = proxy.refused();
      const response = await page.goto('http://zz-test.invalid/', { timeout: 15_000 }).catch(() => null);
      expect(response === null || response.status() === 403).toBe(true);
      expect(proxy.refused()).toBeGreaterThan(before);
      const renderers = readProcessTable().filter((p) => p.pgid === pid && p.pid !== pid);
      expect(renderers.length).toBeGreaterThan(0);
      await context.close();
      await lease.release();
    } finally {
      await pool.close();
    }
  });

  test('pool_no_orphans : 200 cycles acquérir-libérer (shared et dedicated, 3 clients) → 0 processus orphelin, recyclages comptés par raison (P1)', async () => {
    const groups = new OwnedProcessGroups();
    const { launch, launched } = recordingLauncher(groups);
    const events: PoolEvent[] = [];
    let memoryHigh = false;
    const pool = new BrowserPool({
      slotsTotal: 6,
      warmBrowsers: 1,
      launch,
      constants: { ...PROVISIONAL_CAPACITY, contextsPerBrowser: 2 },
      recycleAfterSessions: 3,
      memoryHigh: () => memoryHigh,
      sweep: () => groups.sweep(),
      onEvent: (event) => events.push(event),
    });
    await pool.start();
    const tenants = ['A', 'B', 'C'];
    /** Session en cours par client : chaque cycle shared acquiert une session puis libère la précédente (chevauchement). */
    const carry = new Map<string, PoolLease>();
    let maxBrowsers = 0;
    try {
      for (let i = 0; i < 200; i += 1) {
        const tenantId = tenants[i % tenants.length]!;
        if (i % 10 === 0) {
          const lease = await pool.acquire({ sessionId: `d${i}`, type: 'dedicated', tenantId });
          await useOnce(lease);
          await lease.release();
        } else if (i % 30 === 29) {
          // Fin d'activité du client sous pression mémoire : sa dernière session part, le Chromium est recyclé raison memory.
          memoryHigh = true;
          await carry.get(tenantId)?.release();
          carry.delete(tenantId);
          memoryHigh = false;
        } else {
          const lease = await pool.acquire({ sessionId: `s${i}`, type: 'shared', tenantId });
          await useOnce(lease);
          await carry.get(tenantId)?.release();
          carry.set(tenantId, lease);
        }
        const { browsers } = pool.stats();
        maxBrowsers = Math.max(maxBrowsers, browsers.warm + browsers.shared + browsers.dedicated);
      }
      for (const lease of carry.values()) await lease.release();
      await pool.whenIdle();
    } finally {
      await pool.close();
    }
    const stats = pool.stats();
    const tally: Partial<Record<RecycleReason, number>> = {};
    for (const event of events) if (event.kind === 'recycle') tally[event.reason] = (tally[event.reason] ?? 0) + 1;
    for (const event of events) if (event.kind === 'kill' && event.reason === 'close_timeout') tally.close_timeout = (tally.close_timeout ?? 0) + 1;
    expect(stats.recycles).toEqual({ runs: 0, age: 0, memory: 0, disconnected: 0, close_timeout: 0, shutdown: 0, dedicated: 0, ...tally });
    expect(stats.recycles.runs).toBeGreaterThan(10);
    expect(stats.recycles.memory).toBeGreaterThan(0);
    expect(stats.recycles.shutdown).toBeGreaterThan(0);
    expect(stats.recycles.disconnected + stats.recycles.close_timeout).toBe(0);
    expect(events.filter((e) => e.kind === 'release').length).toBeGreaterThanOrEqual(20);
    expect(stats).toMatchObject({ slotsFree: 6, sessions: { shared: 0, dedicated: 0 }, browsers: { warm: 0, shared: 0, dedicated: 0 } });
    // Aucun Chromium ne s'accumule : au plus un par client, le chaud, le dédié du cycle et un recyclage en vol.
    expect(maxBrowsers).toBeLessThanOrEqual(tenants.length * 2 + 2);
    // 0 orphelin : aucun processus vivant dans un groupe lancé par le pool, aucun Chromium enfant de ce processus.
    const pgids = new Set(launched.map((l) => l.pid!));
    expect(pgids.size).toBe(launched.length);
    expect(launched.length).toBeGreaterThan(40);
    expect(survivors(pgids)).toEqual([]);
    expect(groups.owned()).toEqual([]);
  });

  test('kill_on_close_timeout : un Chromium figé (SIGSTOP) ne se ferme pas, il est tué avec son groupe au délai dur, slot libéré (P6)', async () => {
    const groups = new OwnedProcessGroups();
    const { launch, launched } = recordingLauncher(groups);
    const events: PoolEvent[] = [];
    const pool = new BrowserPool({ slotsTotal: 1, warmBrowsers: 0, launch, constants: PROVISIONAL_CAPACITY, closeTimeoutMs: 1_000, sweep: () => groups.sweep(), onEvent: (e) => events.push(e) });
    await pool.start();
    try {
      const lease = await pool.acquire({ sessionId: 'd', type: 'dedicated', tenantId: 'A' });
      const pid = launched[0]!.pid!;
      expect(groups.members(pid).length).toBeGreaterThan(1);
      // pid exact du Chromium lancé par ce test (enfant direct du processus de test : Playwright l'a lancé ici).
      expect(readProcessTable().find((p) => p.pid === pid)?.ppid).toBe(process.pid);
      process.kill(pid, 'SIGSTOP');
      const started = Date.now();
      await lease.release();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(900);
      // Délai dur (1 s) + groupe rendu en 2 s au plus.
      expect(elapsed).toBeLessThan(1_000 + 2_000 + 500);
      expect(events).toContainEqual({ kind: 'kill', browserId: launched[0]!.id, reason: 'close_timeout' });
      expect(survivors(new Set([pid]))).toEqual([]);
      expect(pool.stats()).toMatchObject({ slotsFree: 1, recycles: { close_timeout: 1 } });
    } finally {
      await pool.close();
    }
  });
});
