// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.6 : BROWSER_CONCURRENCY du cgroup (14 §11), options de lancement figées (silencieux, proxy, non-root,
// environnement réduit), pool recyclé (N runs, âge, mémoire), fermeture à délai dur, chien de garde. Sans Chromium.
import type { Browser } from 'playwright-core';
import { describe, expect, test, vi } from 'vitest';
import { boundedDocumentBody, TOO_LARGE, type DecodedSizes } from './bounded.js';
import {
  browserConcurrencyForMemory,
  BrowserConcurrencyError,
  CGROUP_V1_MEMORY_LIMIT,
  CGROUP_V2_MEMORY_CURRENT,
  CGROUP_V2_MEMORY_MAX,
  cgroupMemoryCurrentBytes,
  cgroupMemoryLimitBytes,
  cgroupMemoryWorkingSetBytes,
  CGROUP_V1_MEMORY_STAT,
  CGROUP_V1_MEMORY_USAGE,
  CGROUP_V2_MEMORY_STAT,
  resolveBrowserConcurrency,
} from './cgroup.js';
import { assertNotRoot, ChromiumAsRootError, chromiumEnv, chromiumLaunchOptions, CHROMIUM_SILENT_ARGS } from './launch.js';
import { BrowserPool, BrowserPoolClosedError, type BrowserPoolEvent, type LaunchedBrowser } from './pool.js';
import { hostAllowed } from './run-context.js';

const GIB = 1024 ** 3;
const files = (map: Record<string, string>) => (path: string) => map[path];

describe('BROWSER_CONCURRENCY déduit du cgroup', () => {
  test('formule de 14 §11 : 2 Go → 1, 4 Go → 2, 8 Go → 5, jamais moins de 1', () => {
    expect(browserConcurrencyForMemory(2 * GIB)).toBe(1);
    expect(browserConcurrencyForMemory(4 * GIB)).toBe(2);
    expect(browserConcurrencyForMemory(8 * GIB)).toBe(5);
    expect(browserConcurrencyForMemory(512 * 1024 ** 2)).toBe(1);
  });

  test('cgroup v2 puis v1 ; « max » et la valeur « illimitée » de v1 ne sont pas des limites', () => {
    expect(cgroupMemoryLimitBytes(files({ [CGROUP_V2_MEMORY_MAX]: `${4 * GIB}\n` }))).toBe(4 * GIB);
    expect(cgroupMemoryLimitBytes(files({ [CGROUP_V2_MEMORY_MAX]: 'max\n', [CGROUP_V1_MEMORY_LIMIT]: `${2 * GIB}` }))).toBe(2 * GIB);
    expect(cgroupMemoryLimitBytes(files({ [CGROUP_V1_MEMORY_LIMIT]: '9223372036854771712' }))).toBeUndefined();
    expect(cgroupMemoryLimitBytes(files({}))).toBeUndefined();
    expect(cgroupMemoryCurrentBytes(files({ [CGROUP_V2_MEMORY_CURRENT]: '123456' }))).toBe(123456);
  });

  test('seuil de recyclage sur la mémoire de travail : page cache inactif (inactive_file) retiré, v2 puis v1', () => {
    const stat2 = 'anon 1000\nfile 9000\ninactive_file 7000\nactive_file 2000\n';
    expect(cgroupMemoryWorkingSetBytes(files({ [CGROUP_V2_MEMORY_CURRENT]: '10000', [CGROUP_V2_MEMORY_STAT]: stat2 }))).toBe(3000);
    // Sans memory.stat lisible : memory.current brut (prudent : recycle plus tôt, jamais plus tard).
    expect(cgroupMemoryWorkingSetBytes(files({ [CGROUP_V2_MEMORY_CURRENT]: '10000' }))).toBe(10000);
    // inactive_file plus grand que current (lectures non atomiques) : jamais négatif.
    expect(cgroupMemoryWorkingSetBytes(files({ [CGROUP_V2_MEMORY_CURRENT]: '100', [CGROUP_V2_MEMORY_STAT]: 'inactive_file 500\n' }))).toBe(0);
    const stat1 = 'cache 9000\ninactive_file 1\ntotal_inactive_file 6000\n';
    expect(cgroupMemoryWorkingSetBytes(files({ [CGROUP_V1_MEMORY_USAGE]: '10000', [CGROUP_V1_MEMORY_STAT]: stat1 }))).toBe(4000);
    expect(cgroupMemoryWorkingSetBytes(files({}))).toBeUndefined();
  });

  test('ordre : variable, puis cgroup, puis mémoire de la machine ; valeur invalide refusée', () => {
    const read = files({ [CGROUP_V2_MEMORY_MAX]: `${4 * GIB}` });
    expect(resolveBrowserConcurrency({ BROWSER_CONCURRENCY: '3' }, { read })).toEqual({ value: 3, source: 'env' });
    expect(resolveBrowserConcurrency({}, { read })).toEqual({ value: 2, source: 'cgroup' });
    expect(resolveBrowserConcurrency({}, { read: files({}), totalMemBytes: 2 * GIB })).toEqual({ value: 1, source: 'host' });
    for (const bad of ['0', '-1', '1.5', 'deux', '33']) expect(() => resolveBrowserConcurrency({ BROWSER_CONCURRENCY: bad }, { read })).toThrow(BrowserConcurrencyError);
  });
});

describe('lancement de Chromium (options figées)', () => {
  test('proxy de lancement imposé, DNS local coupé, WebRTC restreint, liste silencieuse, pas de --disable-features', () => {
    const o = chromiumLaunchOptions('http://127.0.0.1:41234', { PATH: '/usr/bin' });
    expect(o.proxy).toEqual({ server: 'http://127.0.0.1:41234' });
    expect(o.host).toBe('127.0.0.1');
    expect(o.headless).toBe(true);
    expect(o.args).toContain('--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1');
    expect(o.args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    for (const arg of ['--disable-background-networking', '--disable-component-update', '--safebrowsing-disable-auto-update', '--metrics-recording-only', '--disable-dev-shm-usage', '--no-pings']) {
      expect(o.args).toContain(arg);
    }
    // Un second --disable-features écraserait celui de Playwright (dernier gagnant côté Chromium).
    expect(o.args.some((a) => a.startsWith('--disable-features'))).toBe(false);
    expect(o.args.some((a) => a === '--no-sandbox' || a.startsWith('--proxy-bypass-list'))).toBe(false);
    // Playwright ajoute --no-sandbox dès que chromiumSandbox n’est pas true : le bac à sable doit être demandé
    // explicitement (ligne de commande effective vérifiée sur un vrai Chromium : assert_chromium_sandboxed).
    expect(o.chromiumSandbox).toBe(true);
    expect(Object.isFrozen(CHROMIUM_SILENT_ARGS)).toBe(true);
    expect(() => chromiumLaunchOptions('http://10.0.0.1:3128', {})).toThrow();
    expect(() => chromiumLaunchOptions('http://127.0.0.1:1', { PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK: '1' })).toThrow();
  });

  test('environnement de Chromium réduit : ni MASTER_KEY, ni DATABASE_URL, ni clé LLM', () => {
    const env = chromiumEnv({ PATH: '/bin', HOME: '/home/pwuser', MASTER_KEY: 'zz', DATABASE_URL: 'postgres://zz', OPENROUTER_API_KEY: 'zz', MASTER_KEY_FILE: '/run/zz' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/pwuser' });
  });

  test('jamais en root', () => {
    expect(() => assertNotRoot(() => 0)).toThrow(ChromiumAsRootError);
    expect(() => assertNotRoot(() => 1001)).not.toThrow();
  });

  test('politique de domaines : hôte exact de l’API, http(s)/ws(s) seulement, sans identifiants', () => {
    const allowed = ['zz_test_spa.localhost'];
    expect(hostAllowed('http://zz_test_spa.localhost:4010/app.js', allowed)).toBe(true);
    expect(hostAllowed('ws://ZZ_TEST_SPA.localhost./ws', allowed)).toBe(true);
    expect(hostAllowed('http://evil.zz_test_spa.localhost/', allowed)).toBe(false);
    expect(hostAllowed('http://zz_test_spa.localhost@evil.test/', allowed)).toBe(false);
    expect(hostAllowed('http://user:pw@zz_test_spa.localhost/', allowed)).toBe(false);
    expect(hostAllowed('file:///etc/passwd', allowed)).toBe(false);
    expect(hostAllowed('pas une url', allowed)).toBe(false);
  });
});

type Fake = LaunchedBrowser & { id: number; closed: boolean; killed: boolean; connected: boolean };

function fakeLauncher(options: { hangOnClose?: boolean } = {}) {
  const launched: Fake[] = [];
  const launch = async (): Promise<LaunchedBrowser> => {
    const fake: Fake = {
      id: launched.length,
      closed: false,
      killed: false,
      connected: true,
      browser: { isConnected: () => fake.connected } as unknown as Browser,
      close: () => (options.hangOnClose ? new Promise<void>(() => undefined) : Promise.resolve().then(() => void (fake.closed = true))),
      kill: async () => {
        fake.killed = true;
        fake.connected = false;
      },
    };
    launched.push(fake);
    return fake;
  };
  return { launch, launched };
}

const signal = new AbortController().signal;

describe('BrowserPool', () => {
  test('lancement à la demande, recyclage après N runs', async () => {
    const { launch, launched } = fakeLauncher();
    const events: BrowserPoolEvent[] = [];
    const pool = new BrowserPool({ size: 1, launch, recycleAfterRuns: 2, onEvent: (e) => events.push(e) });
    expect(pool.launched()).toBe(0);
    for (let i = 0; i < 3; i++) await pool.run(signal, async () => undefined);
    expect(launched).toHaveLength(2);
    expect(launched[0]?.closed).toBe(true);
    expect(events.filter((e) => e.kind === 'recycle').map((e) => e.reason)).toEqual(['runs']);
    await pool.close();
    expect(launched[1]?.closed).toBe(true);
  });

  test('recyclage après 1 h et au seuil mémoire ; navigateur déconnecté relancé', async () => {
    let t = 0;
    let high = false;
    const { launch, launched } = fakeLauncher();
    const pool = new BrowserPool({ size: 1, launch, now: () => t, memoryHigh: () => high });
    await pool.run(signal, async () => undefined);
    t = 3_600_000;
    await pool.run(signal, async () => undefined);
    expect(launched).toHaveLength(2);
    high = true;
    await pool.run(signal, async () => undefined);
    high = false;
    expect(launched.length).toBeGreaterThanOrEqual(3);
    const last = launched[launched.length - 1] as Fake;
    last.connected = false;
    await pool.run(signal, async () => undefined);
    expect(launched[launched.length - 1]).not.toBe(last);
    await pool.close();
  });

  test('fermeture à délai dur : close() bloqué → kill()', async () => {
    const { launch, launched } = fakeLauncher({ hangOnClose: true });
    const events: BrowserPoolEvent[] = [];
    const pool = new BrowserPool({ size: 1, launch, recycleAfterRuns: 1, closeTimeoutMs: 20, onEvent: (e) => events.push(e) });
    await pool.run(signal, async () => undefined);
    expect(launched[0]?.killed).toBe(true);
    expect(events.some((e) => e.kind === 'kill' && e.reason === 'close_timeout')).toBe(true);
    await pool.close();
  });

  test('chien de garde par run : Chromium tué au-delà du délai', async () => {
    const { launch, launched } = fakeLauncher();
    const pool = new BrowserPool({ size: 1, launch, runWatchdogMs: 20 });
    await pool.run(signal, async () => new Promise((r) => setTimeout(r, 80)));
    expect(launched[0]?.killed).toBe(true);
    await pool.run(signal, async () => undefined);
    expect(launched).toHaveLength(2);
    await pool.close();
  });

  test('BROWSER_CONCURRENCY slots au plus ; attente interrompue par le signal ; pool fermé', async () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool({ size: 2, launch });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let peak = 0;
    const job = () =>
      pool.run(signal, async () => {
        peak = Math.max(peak, pool.active());
        await gate;
      });
    const running = [job(), job(), job()];
    await new Promise((r) => setTimeout(r, 10));
    expect(pool.active()).toBe(2);
    const controller = new AbortController();
    const waiting = pool.run(controller.signal, async () => undefined);
    controller.abort(new Error('lease_lost'));
    await expect(waiting).rejects.toThrow('lease_lost');
    release();
    await Promise.all(running);
    expect(peak).toBe(2);
    await pool.close();
    await expect(pool.run(signal, async () => undefined)).rejects.toBeInstanceOf(BrowserPoolClosedError);
  });

  test('attente interrompue retirée de la file : X tient le slot, A (annulé) et B attendent, X rend → B passe', async () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool({ size: 1, launch });
    let releaseX!: () => void;
    const x = pool.run(signal, () => new Promise<void>((r) => (releaseX = r)));
    await new Promise((r) => setTimeout(r, 5));
    const ca = new AbortController();
    const a = pool.run(ca.signal, async () => 'a');
    let bRan = false;
    const b = pool.run(AbortSignal.timeout(2_000), async () => {
      bRan = true;
      return 'b';
    });
    await new Promise((r) => setTimeout(r, 5));
    ca.abort(new Error('cancelled'));
    await expect(a).rejects.toThrow('cancelled');
    releaseX();
    await x;
    // B doit obtenir le slot libéré tout de suite, pas à l'expiration de son propre signal.
    await new Promise((r) => setTimeout(r, 50));
    expect(bRan).toBe(true);
    await expect(b).resolves.toBe('b');
    expect(pool.active()).toBe(0);
    await pool.close();
  });
});

describe('Chromium dédié (E5 agentique, E6) dans un slot du pool : un Chromium par slot (14 §11)', () => {
  /** Chromium vivants : ceux du pool (ni fermés ni tués) et les dédiés ouverts. */
  function census() {
    const pooled = fakeLauncher();
    let dedicatedAlive = 0;
    let peak = 0;
    const alive = () => pooled.launched.filter((f) => !f.closed && !f.killed).length + dedicatedAlive;
    const launch = async (): Promise<LaunchedBrowser> => {
      const l = await pooled.launch();
      peak = Math.max(peak, alive());
      return l;
    };
    const dedicated = async () => {
      dedicatedAlive += 1;
      peak = Math.max(peak, alive());
      let open = true;
      return {
        close: async () => {
          if (open) dedicatedAlive -= 1;
          open = false;
        },
      };
    };
    return { launch, launched: pooled.launched, dedicated, alive, peak: () => peak };
  }

  test('assert_agent_browser_in_pool_slot — BROWSER_CONCURRENCY=1, deux essais simultanés : jamais plus d’un Chromium vivant ; le Chromium partagé du slot fermé avant le dédié ; rejeux sans redemander de slot', async () => {
    const c = census();
    const events: BrowserPoolEvent[] = [];
    const pool = new BrowserPool({ size: 1, launch: c.launch, recycleAfterRuns: 100, onEvent: (e) => events.push(e) });
    // Un run E2 a laissé un Chromium partagé vivant dans le slot.
    await pool.run(signal, async () => undefined);
    expect(c.alive()).toBe(1);
    const trial = () =>
      pool.hold(signal, async (lease) => {
        const ab = await lease.dedicated(c.dedicated);
        await new Promise((r) => setTimeout(r, 20));
        // Le Chromium partagé du slot ne peut pas être prêté tant que le dédié est ouvert.
        await expect(lease.run(async () => undefined)).rejects.toThrow();
        await ab.close();
        // Rejeux de compilation : le slot tenu, sans en redemander un (un pool à 1 slot serait sinon bloqué).
        await lease.run(async () => undefined);
        await lease.run(async () => undefined);
        expect(pool.active()).toBe(1);
        return 'ok';
      });
    await expect(Promise.all([trial(), trial()])).resolves.toEqual(['ok', 'ok']);
    expect(c.peak()).toBe(1);
    expect(c.launched[0]?.closed).toBe(true);
    expect(events.some((e) => e.kind === 'recycle' && e.reason === 'dedicated')).toBe(true);
    expect(pool.active()).toBe(0);
    await pool.close();
    expect(c.alive()).toBe(0);
  });

  test('Chromium dédié laissé ouvert : fermé à la libération du slot ; chien de garde : fermé au-delà du délai ; un seul dédié par slot ; arrêt du pool', async () => {
    const c = census();
    const events: BrowserPoolEvent[] = [];
    const pool = new BrowserPool({ size: 1, launch: c.launch, runWatchdogMs: 20, onEvent: (e) => events.push(e) });
    await pool.hold(signal, async (lease) => {
      await lease.dedicated(c.dedicated);
    });
    expect(c.alive()).toBe(0);
    await pool.hold(signal, async (lease) => {
      await lease.dedicated(c.dedicated);
      await new Promise((r) => setTimeout(r, 80));
      expect(c.alive()).toBe(0);
    });
    expect(events.some((e) => e.kind === 'watchdog')).toBe(true);
    await pool.hold(signal, async (lease) => {
      const ab = await lease.dedicated(c.dedicated);
      await expect(lease.dedicated(c.dedicated)).rejects.toThrow();
      await ab.close();
    });
    expect(c.peak()).toBe(1);
    // Arrêt du worker pendant un essai : le dédié est fermé.
    let opened!: () => void;
    const ready = new Promise<void>((r) => (opened = r));
    const held = pool.hold(signal, async (lease) => {
      await lease.dedicated(c.dedicated);
      opened();
      await new Promise((r) => setTimeout(r, 10));
    });
    await ready;
    await pool.close();
    expect(c.alive()).toBe(0);
    await held;
  });
});

describe('boundedDocumentBody : corps brut d’un document lu seulement si sa taille DÉCODÉE est connue et bornée', () => {
  type FakeResponse = Parameters<typeof boundedDocumentBody>[0];
  const response = (headers: Record<string, string>, transferred: number, text: () => Promise<string>): FakeResponse =>
    ({ headers: () => headers, url: () => 'http://zz_test_x.localhost/', request: () => ({ sizes: async () => ({ responseBodySize: transferred }) }), text }) as unknown as FakeResponse;
  const sizes = (decoded: number | undefined): DecodedSizes => ({ decodedBodySize: async () => decoded });

  test('bombe de compression (32 Kio transférés, des dizaines de Mo décodés) : jamais rapatriée dans Node', async () => {
    const text = vi.fn(async () => 'x'.repeat(10));
    const gzip = { 'content-type': 'text/html', 'content-encoding': 'gzip' };
    // Taille décodée inconnue (pas de suivi CDP) : corps brut non lu.
    expect(await boundedDocumentBody(response(gzip, 30 * 1024, text), 5_000_000)).toBeUndefined();
    // Taille décodée connue et au-delà du plafond : refus, sans lecture.
    expect(await boundedDocumentBody(response(gzip, 30 * 1024, text), 5_000_000, 1_000, sizes(48_000_000))).toBe(TOO_LARGE);
    expect(await boundedDocumentBody(response(gzip, 30 * 1024, text), 5_000_000, 1_000, sizes(undefined))).toBeUndefined();
    expect(text).not.toHaveBeenCalled();
    // Taille décodée connue et bornée : lu (même au-delà de 32 Kio transférés).
    expect(await boundedDocumentBody(response(gzip, 200 * 1024, text), 5_000_000, 1_000, sizes(900_000))).toBe('x'.repeat(10));
    expect(text).toHaveBeenCalledOnce();
  });

  test('corps non compressé : taille réseau (Content-Length, octets transférés) suffit', async () => {
    const text = vi.fn(async () => '<html></html>');
    expect(await boundedDocumentBody(response({ 'content-type': 'text/html' }, 13, text), 1_000)).toBe('<html></html>');
    expect(await boundedDocumentBody(response({ 'content-type': 'text/html' }, 5_000, text), 1_000)).toBe(TOO_LARGE);
    expect(text).toHaveBeenCalledOnce();
  });
});
