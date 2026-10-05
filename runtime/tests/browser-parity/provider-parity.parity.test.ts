// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.4 (cdc/sym-browser 04g §5, 04e §5.1, BINV4) : `assert_provider_parity`. La liste de 04e §5.1 et les deux tests de 04g §4
// jouées avec les trois fournisseurs du worker, sur de vrais Chromium :
//   - `local` : le Chromium du worker (proxy de lancement fermé) ;
//   - `sym-browser` : une instance en mode `all` assemblée en processus (modules/browser/tests/helpers/all-mode.ts : PostgreSQL
//     jetable, passerelle, nœud, vrais Chromium), pilotée par le SDK, `BROWSER_URL` = sa passerelle ;
//   - `cdp` : un Chromium exposé en CDP lancé ici (jamais un compte tiers), neuf à chaque ouverture.
// Une sonde n'est jouée avec un fournisseur que si ses capacités déclarent la capacité requise ; sinon le verdict est « absente
// déclarée », lu sur `capabilities` du fournisseur (04g §5). Le tableau est écrit dans PARITY_RESULTS (JSON) pour
// scripts/provider-parity.ts, qui le rend et sort en code ≠ 0 au moindre écart. Seuls processus tués : les Chromium lancés ici,
// par leur pid (cdp) ou par le fournisseur (local, nœud) ; aucun kill large.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect as netConnect, type AddressInfo, type Server as NetServer, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSsrfPolicy, parseProxyDefinition, SsrfGuard, startEgressProxy, type BrowserEgressOptions, type EgressProxy } from '@runtime/core/net';
import type { BrowserProvider, ProviderCapabilities } from '../../packages/contracts/src/browser/index.ts';
import type { SymBrowser as SymBrowserClass } from '../../modules/browser/packages/sdk/src/index.ts';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createCdpProvider } from '../../apps/worker/src/browser/provider-cdp.js';
import { createLocalProvider } from '../../apps/worker/src/browser/provider-local.js';
import { createSymBrowserProvider } from '../../apps/worker/src/browser/provider-sym-browser.js';
import type { RunEgress } from '../../apps/worker/src/browser/run-egress.js';
import { openRunContext, type RunContext, type RunContextOptions } from '../../apps/worker/src/browser/run-context.js';
import { compareParity, PARITY_TESTS, PROVIDERS, renderParityTable, type ParityResults, type ProviderName, type Verdict } from './parity-table.ts';

const A = 'site-a.test';
const B = 'site-b.test';
type Provider = BrowserProvider<BrowserEgressOptions, RunEgress>;
type Hit = { host: string; method: string; path: string };

// --- Fixtures : un site, un proxy BYO (CONNECT) -------------------------------------------------------------------------
let site: Server;
let sitePort = 0;
const hits: Hit[] = [];
const hitsOf = (host: string, path?: string, method?: string): number => hits.filter((h) => h.host === host && (path === undefined || h.path === path) && (method === undefined || h.method === method)).length;
const BIG_BYTES = 8 * 1024 * 1024;

let byoProxy: NetServer;
let byoPort = 0;
const byoLog: string[] = [];

// --- Fournisseurs ---------------------------------------------------------------------------------------------------------
type Handle = { provider: Provider; dispose(): Promise<void> };
let launchProxy: EgressProxy;
let symInstance: { url: string; apiKey: string; close(): Promise<void>; errors: unknown[] } | undefined;
let SymBrowser: typeof SymBrowserClass;

const guard = () => new SsrfGuard({ policy: createSsrfPolicy({ allowedPorts: [sitePort, byoPort], testAllowPrivate: true }), resolver: async (host) => (host === A || host === B ? [{ address: '127.0.0.1', family: 4 as const }] : Promise.reject(new Error('ENOTFOUND'))) });

const makers: Record<ProviderName, () => Promise<Handle>> = {
  local: async () => ({ provider: createLocalProvider({ launchProxyUrl: launchProxy.url, env: process.env }) as unknown as Provider, dispose: async () => undefined }),
  'sym-browser': async () => {
    const instance = symInstance!;
    const client = new SymBrowser({ url: instance.url, apiKey: instance.apiKey, releaseOnExit: false });
    return { provider: createSymBrowserProvider({ url: new URL(instance.url), client: client as never, workerId: 'zz_parity', playwrightVersion: '1.63.0', waitMs: 10_000 }), dispose: async () => undefined };
  },
  cdp: async () => {
    const profile = mkdtempSync(join(tmpdir(), 'zz_parity_cdp_'));
    const child: ChildProcess = spawn(chromium.executablePath(), ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, '--host-resolver-rules=MAP *.test 127.0.0.1', 'about:blank'], { stdio: 'ignore' });
    let url = '';
    for (let i = 0; i < 200 && url === ''; i++) {
      try {
        const [port, path] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n');
        url = `ws://127.0.0.1:${Number(port)}${path ?? ''}`;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    if (url === '') throw new Error('Chromium exposé en CDP : DevToolsActivePort absent');
    return {
      provider: createCdpProvider({ mode: { kind: 'url', url }, workerId: 'zz_parity' }),
      dispose: async () => {
        for (let i = 0; i < 60 && child.exitCode === null && child.signalCode === null; i++) await new Promise((r) => setTimeout(r, 50));
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        rmSync(profile, { recursive: true, force: true });
      },
    };
  },
};

beforeAll(async () => {
  site = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    hits.push({ host: (req.headers.host ?? '').replace(/:\d+$/, ''), method: req.method ?? 'GET', path });
    const html = (body: string) => res.writeHead(200, { 'content-type': 'text/html' }).end(body);
    switch (path) {
      case '/__ip':
        return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ip":"127.0.0.1"}');
      case '/page':
        return html('<title>fixture</title><p id="v">conforme</p>');
      case '/prive/page':
        return html('<p id="v">prive-servi</p>');
      case '/go':
        return res.writeHead(302, { location: `http://${B}:${sitePort}/prive/saut` }).end();
      case '/form':
        return html('<form method="post" action="/submit"><input name="q" value="1"><button id="b">Envoyer</button></form>');
      case '/submit':
        return html('<p>reçu</p>');
      case '/wss':
        return html(`<p id="m">m</p><script>window.__doc = typeof WebSocketStream; window.__worker = 'attente'; const w = new Worker('/wss.js'); w.onmessage = (e) => { window.__worker = e.data; };</script>`);
      case '/wss.js':
        return res.writeHead(200, { 'content-type': 'text/javascript' }).end('postMessage(typeof WebSocketStream)');
      case '/big': {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(BIG_BYTES) });
        const chunk = Buffer.alloc(64 * 1024, 120);
        let sent = 0;
        const pump = () => {
          while (sent < BIG_BYTES) {
            sent += chunk.length;
            if (!res.write(chunk)) return void res.once('drain', pump);
          }
          res.end();
        };
        res.on('error', () => undefined);
        return pump();
      }
      default:
        return res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  sitePort = (site.address() as AddressInfo).port;

  // Proxy BYO de test : CONNECT, toute cible nommée est jointe en 127.0.0.1 (la cible est journalisée).
  byoProxy = createNetServer((client) => {
    client.once('data', (head) => {
      const m = /^CONNECT ([^\s:]+):(\d+) HTTP/.exec(head.toString('latin1'));
      if (!m) return void client.destroy();
      byoLog.push(`${m[1]}:${m[2]}`);
      const upstream = netConnect(Number(m[2]), '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
    });
  });
  await new Promise<void>((resolve) => byoProxy.listen(0, '127.0.0.1', resolve));
  byoPort = (byoProxy.address() as AddressInfo).port;

  launchProxy = await startEgressProxy({ guard: guard(), refuseAll: true });
  SymBrowser = (await import('../../modules/browser/packages/sdk/src/index.ts')).SymBrowser;
  const { startAllMode } = await import('../../modules/browser/tests/helpers/all-mode.ts');
  // Noms de test résolus par la garde du nœud, proxy BYO et point d'écho joints en boucle locale (SYMB_PRIVATE_HOSTS).
  symInstance = await startAllMode({ hosts: [A, B], privateHosts: ['127.0.0.1'], ipEchoUrl: `http://${A}:${sitePort}/__ip` });
}, 300_000);

afterAll(async () => {
  await symInstance?.close();
  await launchProxy?.close();
  byoProxy?.close();
  await new Promise((resolve) => site?.close(resolve));
});

// --- Banc d'une sonde -----------------------------------------------------------------------------------------------------
type Bench = { provider: Provider; egress: RunEgress; rc: RunContext };
type Rung = BrowserEgressOptions['rung'];
const DIRECT: Rung = { mode: 'direct' };
const priced = (perGb: number): Rung => ({
  mode: 'dc_proxy',
  proxy: parseProxyDefinition({ id: 'zz_parity_dc', type: 'dc', url: `http://127.0.0.1:${byoPort}`, credentials_secret_id: 'zz_parity_secret', allow_private_address: true, price: { per_gb_usd: perGb, per_request_usd: 0 } }),
  params: {},
});

/** Navigateur partagé du fournisseur, egress de l'essai et contexte de run ; tout est refermé ensuite. */
async function withRun(name: ProviderName, fn: (bench: Bench) => Promise<void>, options: { rung?: Rung; costCeiling?: { maxUsd: number }; run?: Partial<RunContextOptions> } = {}): Promise<void> {
  const handle = await makers[name]();
  const { provider } = handle;
  const egress = await provider.openEgress({ rung: options.rung ?? DIRECT, guard: guard(), allowedHosts: [A], ...(options.costCeiling === undefined ? {} : { costCeiling: options.costCeiling }) });
  const launched = await provider.launchShared();
  let rc: RunContext | undefined;
  try {
    rc = await openRunContext(launched.browser, { egressServer: egress.server, egress, allowedHosts: [A], ...options.run });
    await fn({ provider, egress, rc });
  } finally {
    await rc?.close().catch(() => undefined);
    await launched.kill().catch(() => undefined);
    await egress.settle?.().catch(() => undefined);
    await egress.close().catch(() => undefined);
    await handle.dispose();
  }
}

const poll = async (ok: () => boolean, ms = 8000): Promise<void> => {
  for (let i = 0; i < ms / 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 100));
};

// --- Les onze sondes ----------------------------------------------------------------------------------------------------
type Probe = (name: ProviderName) => Promise<void>;
const PROBES: Record<string, Probe> = {
  // 04e §5.1 : Chromium non root, bac à sable actif. Processus Chromium descendants de ce processus (local : launchServer ; nœud
  // en mode all : même processus), jamais ceux d'un autre.
  assert_chromium_sandboxed: async (name) => {
    const handle = await makers[name]();
    const launched = await handle.provider.launchShared();
    try {
      const ps = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,uid=,args='], { encoding: 'utf8' })
        .split('\n')
        .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), args: m[4]! }));
      const ours = new Set<number>([process.pid]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const p of ps) if (ours.has(p.ppid) && !ours.has(p.pid)) {
          ours.add(p.pid);
          grew = true;
        }
      }
      const chromes = ps.filter((p) => ours.has(p.pid) && p.pid !== process.pid && /chrom/i.test(p.args));
      expect(chromes.length).toBeGreaterThan(0);
      for (const p of chromes) {
        expect(p.args).not.toContain('--no-sandbox');
        expect(p.uid).not.toBe(0);
      }
    } finally {
      await launched.kill().catch(() => undefined);
      await handle.dispose();
    }
  },

  // 04e §5.1 : Chromium oisif, 0 requête hors contexte ; contexte de run sur about:blank, 5 s d'inactivité.
  assert_chromium_idle_silent: (name) =>
    withRun(name, async ({ egress, rc }) => {
      await rc.page.goto('about:blank');
      await new Promise((r) => setTimeout(r, 5000));
      await egress.settle?.();
      expect(egress.usage().requests).toBe(0);
    }),

  // 04e §5.1 : la requête du navigateur sort par le proxy BYO de l'essai (garde, puis proxy amont).
  assert_browser_egress_chained: (name) =>
    withRun(
      name,
      async ({ egress, rc }) => {
        byoLog.length = 0;
        await rc.page.goto(`http://${A}:${sitePort}/page`);
        expect(await rc.page.locator('#v').textContent()).toBe('conforme');
        await egress.settle?.();
        expect(byoLog).toContain(`${A}:${sitePort}`);
        expect(egress.usage().requests).toBeGreaterThan(0);
      },
      { rung: priced(1) },
    ),

  // 04e §5.1 : coupure au plafond converti en octets (5 $/Go, plafond 0,002 $ : 400 ko pour un corps de 8 Mo).
  assert_run_cost_capped: (name) =>
    withRun(
      name,
      async ({ egress, rc }) => {
        await rc.page.goto(`http://${A}:${sitePort}/big`).catch(() => undefined);
        await rc.page.waitForTimeout(500);
        await egress.settle?.();
        await poll(() => egress.budgetExceeded());
        await egress.settle?.();
        expect(egress.budgetExceeded()).toBe(true);
        expect(egress.usage().costUsd).toBeLessThanOrEqual(0.002);
      },
      { rung: priced(5), costCeiling: { maxUsd: 0.002 } },
    ),

  // 04e §5.1 : le User-Agent est la chaîne du moteur qui sert, sans HeadlessChrome.
  assert_user_agent_engine_real: (name) =>
    withRun(name, async ({ provider, rc }) => {
      await rc.page.goto(`http://${A}:${sitePort}/page`);
      const ua = await rc.page.evaluate(() => navigator.userAgent);
      const major = (await provider.engineIdentity()).version.split('.')[0];
      expect(ua).toContain(`Chrome/${major}.`);
      expect(ua).not.toContain('HeadlessChrome');
    }),

  // 04e §5.1 : un Chromium dédié à l'essai, distinct du partagé, libéré avec lui.
  assert_agent_browser_in_pool_slot: async (name) => {
    const handle = await makers[name]();
    const { provider } = handle;
    const egress = await provider.openEgress({ rung: DIRECT, guard: guard(), allowedHosts: [A] });
    const dedicated = await provider.launchDedicated({ userAgent: 'zz-parity', egress: { allowedHosts: [A] }, egressServer: egress.server, launchArgs: [] });
    let rc: RunContext | undefined;
    try {
      rc = await openRunContext(dedicated.browser, { dedicated: true, egressServer: egress.server, egress, allowedHosts: [A] });
      await rc.page.goto(`http://${A}:${sitePort}/page`);
      expect(await rc.page.locator('#v').textContent()).toBe('conforme');
      expect(dedicated.cdpUrl).toMatch(/^wss?:\/\//);
      await dedicated.kill();
      await poll(() => !dedicated.browser.isConnected());
      expect(dedicated.browser.isConnected()).toBe(false);
    } finally {
      await rc?.close().catch(() => undefined);
      await dedicated.kill().catch(() => undefined);
      await egress.close().catch(() => undefined);
      await handle.dispose();
    }
  },

  // 04e §5.1 : tout contexte de run passe par la garde : un domaine hors liste est coupé, 0 requête chez lui.
  assert_all_browser_contexts_guarded: (name) =>
    withRun(name, async ({ rc }) => {
      hits.length = 0;
      await rc.page.goto(`http://${A}:${sitePort}/page`);
      await rc.page.goto(`http://${B}:${sitePort}/page`).catch(() => undefined);
      expect(rc.violations).toContain(B);
      expect(hitsOf(B)).toBe(0);
      expect(hitsOf(A, '/page')).toBe(1);
    }),

  // 04e §5.1 : sans allow_write_actions, le clic d'envoi est coupé (0 POST) ; témoin : permis, le POST part.
  assert_write_action_blocked: async (name) => {
    const READ = new Set(['GET', 'HEAD', 'OPTIONS']);
    const click = async ({ rc }: Bench) => {
      await rc.page.goto(`http://${A}:${sitePort}/form`);
      await rc.page.click('#b');
      await rc.page.waitForTimeout(800);
    };
    hits.length = 0;
    await withRun(name, click, { run: { checkRequest: async (hop) => READ.has(hop.method) } });
    expect(hitsOf(A, '/submit', 'POST')).toBe(0);
    await withRun(name, click);
    expect(hitsOf(A, '/submit', 'POST')).toBe(1);
  },

  // 04e §5.1 : aucun contrôle robots.txt : /prive/ servi, 0 requête /robots.txt.
  assert_robots_not_gating: (name) =>
    withRun(name, async ({ rc }) => {
      hits.length = 0;
      await rc.page.goto(`http://${A}:${sitePort}/prive/page`);
      expect(await rc.page.locator('#v').textContent()).toBe('prive-servi');
      expect(hitsOf(A, '/robots.txt')).toBe(0);
    }),

  // 04g §4 (G7) : un saut de redirection hors domaines est coupé, 0 requête chez la destination.
  request_guard_blocks_offsite_redirect: (name) =>
    withRun(name, async ({ egress, rc }) => {
      hits.length = 0;
      await rc.page.goto(`http://${A}:${sitePort}/go`).catch(() => undefined);
      await rc.page.waitForTimeout(800);
      await egress.settle?.();
      expect(hitsOf(B)).toBe(0);
      expect(rc.violations.includes(B) || egress.domainBlockedCount() > 0).toBe(true);
    }),

  // 04g §4 (G8) : WebSocketStream indéfini dans la page et dans son worker dédié.
  websocketstream_neutralized_by_init_script: (name) =>
    withRun(name, async ({ rc }) => {
      await rc.page.goto(`http://${A}:${sitePort}/wss`);
      await rc.page.waitForFunction(() => (globalThis as unknown as { __worker: string }).__worker !== 'attente', undefined, { timeout: 10_000 });
      expect(await rc.page.evaluate(() => ({ doc: (globalThis as unknown as { __doc: string }).__doc, worker: (globalThis as unknown as { __worker: string }).__worker }))).toEqual({ doc: 'undefined', worker: 'undefined' });
    }),
};

// --- Exécution et tableau -------------------------------------------------------------------------------------------------
const results: ParityResults = {};
/** `capabilities` du fournisseur réel, lues sans ouvrir de navigateur (le CDP exposé n'est lancé que par une sonde). */
const capabilitiesOf = (name: ProviderName): ProviderCapabilities => {
  if (name === 'local') return createLocalProvider({ launchProxyUrl: launchProxy.url, env: process.env }).capabilities;
  if (name === 'cdp') return createCdpProvider({ mode: { kind: 'url', url: 'ws://127.0.0.1:1' }, workerId: 'zz_parity' }).capabilities;
  return createSymBrowserProvider({ url: new URL(symInstance!.url), client: {} as never, workerId: 'zz_parity', playwrightVersion: '1.63.0' }).capabilities;
};

describe('assert_provider_parity : sondes', () => {
  for (const t of PARITY_TESTS) {
    for (const name of PROVIDERS) {
      test(`${t.name} × ${name}`, async () => {
        const declared = capabilitiesOf(name);
        const row = (results[t.name] ??= {});
        if (t.capability !== null && !declared[t.capability]) {
          row[name] = 'absente déclarée';
          return;
        }
        try {
          await PROBES[t.name]!(name);
          row[name] = 'PASS';
        } catch (error) {
          row[name] = 'FAIL';
          throw error;
        }
      }, 180_000);
    }
  }
});

describe('assert_provider_parity', () => {
  test('assert_provider_parity : tableau local, sym-browser, cdp conforme à 04g §5 (G9)', async () => {
    const caps = { local: capabilitiesOf('local'), 'sym-browser': capabilitiesOf('sym-browser'), cdp: capabilitiesOf('cdp') };
    const out = process.env['PARITY_RESULTS'];
    if (out !== undefined) writeFileSync(out, JSON.stringify({ results, capabilities: caps }, null, 2));
    console.log(`\n${renderParityTable(results)}\n`);
    expect(compareParity(results, caps)).toEqual([]);
    expect(Object.values(results).flatMap((r) => Object.values(r) as Verdict[]).filter((v) => v === 'FAIL')).toEqual([]);
  });
});

