// SPDX-License-Identifier: AGPL-3.0-only
// assert_user_agent_engine_real et assert_no_fingerprint_spoofing (INV6, X2, tâche 1.11, décision du 2026-10-01, 17 §5).
// Étage S (vrai Chromium 153, Playwright 1.63) sur une fixture qui ENREGISTRE les en-têtes reçus :
// - E1 (client HTTP) puis contextes Chromium (E2/E3, défaut des E4/E5) puis Chromium agentique (E5/E6) : l'en-tête
//   `User-Agent` vaut EXACTEMENT la chaîne du moteur, calculée ici depuis `browser.version()` et la plateforme réelle
//   (jamais une constante), sans `HeadlessChrome`, identique d'un run à l'autre ; E1 envoie aussi `Accept` et
//   `Accept-Language` d'un navigateur ;
// - `identify_instance` activé : le jeton `compatible; Scrapyomama/<version>; +<contact>` et `From` (adresse électronique) ;
// - aucun masquage : `navigator.webdriver` reste vrai dans la page, et les commandes CDP réellement envoyées (journal
//   `pw:protocol` de Playwright) ne contiennent aucun override interdit : seul `Emulation.setUserAgentOverride` avec la
//   chaîne exacte du moteur (ou vide) est admis, plus les appels propres à Playwright (fenêtre, focus, médias).
// Le volet statique (liste noire, code source) est dans tests/no-fingerprint-spoofing.unit.test.ts.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

// Journal des commandes CDP : le `debug` de Playwright lit DEBUG au chargement du paquet, avant tout import.
vi.hoisted(() => {
  process.env['DEBUG'] = [process.env['DEBUG'], 'pw:protocol'].filter(Boolean).join(',');
});

import { BrowserPool, playwrightLauncher } from '../../apps/worker/src/browser/pool.ts';
import { launchAgentBrowser } from '../../apps/worker/src/browser/agent-browser.ts';
import { openRunContext } from '../../apps/worker/src/browser/run-context.ts';
import { robotIdentity, type RobotIdentity } from '../../apps/worker/src/exec/robot-identity.ts';
import * as net from '@runtime/core/net';
import { openBrowserEgress, openNetworkSession, startEgressProxy, type BrowserEgress, type EgressProxy, type SsrfGuard } from '@runtime/core/net';
import { fixtureGuard } from '../helpers/fixture-net.ts';

const HOST = 'zz_test_ua.localhost';
const signal = new AbortController().signal;

type Seen = { path: string; headers: IncomingHttpHeaders };
let server: Server;
let port: number;
let seen: Seen[] = [];
let guard: SsrfGuard;
let launchProxy: EgressProxy;
let pool: BrowserPool;
/** `browser.version()` du Chromium du pool (lu, jamais écrit en dur). */
let browserVersion = '';
const base = (path = '/'): string => `http://${HOST}:${port}${path}`;
const uas = (path?: string): string[] => seen.filter((s) => path === undefined || s.path === path).map((s) => String(s.headers['user-agent'] ?? ''));

// ------------------------------------------------------------------------------------------- journal CDP (pw:protocol)
type Sent = { method: string; params?: Record<string, unknown> };
const sent: Sent[] = [];
let restoreStderr: (() => void) | undefined;

function captureProtocol(): void {
  const original = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line no-control-regex
  const ANSI = /\u001b\[[0-9;]*m/g;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (!text.includes('pw:protocol')) return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
    for (const line of text.split('\n')) {
      const at = line.indexOf('SEND ► ');
      if (at === -1) continue;
      try {
        const message = JSON.parse(line.slice(at + 'SEND ► '.length).replace(ANSI, '').trim()) as Sent;
        if (typeof message.method === 'string') sent.push({ method: message.method, ...(message.params === undefined ? {} : { params: message.params }) });
      } catch {
        // ligne tronquée ou non JSON : ignorée
      }
    }
    return true;
  }) as typeof process.stderr.write;
  restoreStderr = () => {
    process.stderr.write = original;
  };
}

// ------------------------------------------------------------------------------------------------- valeur attendue
/** Jeton de plateforme que Chromium annonce, par plateforme réelle (écrit ici indépendamment du code testé). */
const PLATFORM: Record<string, string> = {
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  linux: 'X11; Linux x86_64',
  win32: 'Windows NT 10.0; Win64; x64',
};
/** Chaîne attendue : `browser.version()` (version majeure) et plateforme réelle, rien d'autre. */
const expectedUserAgent = (version: string): string =>
  `Mozilla/5.0 (${PLATFORM[process.platform] ?? 'plateforme inconnue'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version.split('.')[0]}.0.0.0 Safari/537.36`;
const TOKEN_SUFFIX = (version: string, contact: string): string => ` (compatible; Scrapyomama/${version}; +${contact})`;

beforeAll(async () => {
  captureProtocol();
  server = createServer((req, res) => {
    seen.push({ path: (req.url ?? '/').split('?')[0] ?? '/', headers: req.headers });
    if (req.url === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow:\n');
    if (req.url === '/api') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"items":[]}');
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><body>ok<script>fetch("/sub").catch(() => {})</script></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  guard = fixtureGuard(port, [HOST], net);
  launchProxy = await startEgressProxy({ guard, refuseAll: true });
  pool = new BrowserPool({ size: 1, launch: playwrightLauncher(launchProxy.url, process.env), recycleAfterRuns: 100 });
  browserVersion = await pool.run(signal, async (browser) => browser.version());
}, 120_000);

afterAll(async () => {
  await pool?.close();
  await launchProxy?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  restoreStderr?.();
});

async function withEgress<T>(fn: (egress: BrowserEgress) => Promise<T>): Promise<T> {
  const egress = await openBrowserEgress({ rung: { mode: 'direct' }, guard });
  try {
    return await fn(egress);
  } finally {
    await egress.close();
  }
}

const identityOf = (options: { identify?: boolean; contact?: string | null } = {}): Promise<RobotIdentity> =>
  robotIdentity({
    version: '1.2.3',
    instanceContact: async () => (options.contact === undefined ? 'ops@zz-test.example' : options.contact),
    identifyInstance: async () => options.identify === true,
    warn: () => undefined,
  })();

/** Une visite complète par un contexte de run : document, sous-ressource (`fetch`), `navigator.userAgent`. */
async function visitWithRunContext(userAgent: string | undefined): Promise<{ navigator: string; webdriver: unknown }> {
  return pool.run(signal, (browser) =>
    withEgress(async (egress) => {
      const rc = await openRunContext(browser, { egressServer: egress.server, allowedHosts: [HOST], ...(userAgent === undefined ? {} : { userAgent }) });
      try {
        await rc.page.goto(base('/'), { waitUntil: 'load' });
        await rc.page.waitForResponse((r) => r.url().endsWith('/sub')).catch(() => undefined);
        return await rc.page.evaluate(() => ({ navigator: navigator.userAgent, webdriver: (navigator as unknown as { webdriver?: boolean }).webdriver }));
      } finally {
        await rc.close();
      }
    }),
  );
}

describe('assert_user_agent_engine_real : le User-Agent est celui du moteur embarqué, sans HeadlessChrome', () => {
  test('la valeur attendue est celle du vrai moteur : un contexte sans aucun réglage annonce la même chaîne, à HeadlessChrome et à la version complète près', async () => {
    const raw = await pool.run(signal, async (browser) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        return await page.evaluate(() => navigator.userAgent);
      } finally {
        await context.close();
      }
    });
    expect(raw.replace(/HeadlessChrome\/(\d+)\.[\d.]+/, 'Chrome/$1.0.0.0')).toBe(expectedUserAgent(browserVersion));
    // L'identité de moteur du worker (Playwright installé) coïncide avec le Chromium qui tourne.
    const { installedEngineIdentity } = await import('../../apps/worker/src/browser/engine-identity.ts');
    expect(installedEngineIdentity().version).toBe(browserVersion);
  });

  test('E1 (client HTTP) : User-Agent exactement celui du moteur, Accept et Accept-Language de navigateur, pas de From ni de jeton', async () => {
    seen = [];
    const identity = await identityOf();
    expect(identity.userAgent).toBe(expectedUserAgent(browserVersion));
    expect(identity.from).toBeNull();
    const session = openNetworkSession({ rung: { mode: 'direct' }, guard, userAgent: identity.userAgent });
    try {
      await session.fetch(base('/api'));
      // Une stratégie ne remplace pas le User-Agent ; son propre Accept est conservé.
      await session.fetch(base('/api'), { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Firefox/130', accept: 'application/json' } });
    } finally {
      await session.close();
    }
    const requests = seen.filter((s) => s.path === '/api');
    expect(requests).toHaveLength(2);
    for (const r of requests) {
      expect(r.headers['user-agent']).toBe(expectedUserAgent(browserVersion));
      expect(String(r.headers['user-agent'])).not.toMatch(/HeadlessChrome|Scrapyomama/);
      expect(r.headers['accept-language']).toBe('en-US,en;q=0.9');
      expect(r.headers['from']).toBeUndefined();
    }
    expect(requests[0]!.headers['accept']).toMatch(/^text\/html,application\/xhtml\+xml,application\/xml;q=0\.9/);
    expect(requests[1]!.headers['accept']).toBe('application/json');
  });

  test('E2/E3 (contexte de run) : document, sous-ressource et navigator.userAgent valent exactement la chaîne du moteur', async () => {
    seen = [];
    const identity = await identityOf();
    const page = await visitWithRunContext(identity.userAgent);
    expect(page.navigator).toBe(expectedUserAgent(browserVersion));
    expect(uas('/')).toEqual([expectedUserAgent(browserVersion)]);
    expect(uas('/sub')).toEqual([expectedUserAgent(browserVersion)]);
  });

  test('contexte ouvert sans User-Agent fourni (défaut de E4/E5) : la chaîne exacte du moteur, jamais HeadlessChrome', async () => {
    seen = [];
    const page = await visitWithRunContext(undefined);
    expect(page.navigator).toBe(expectedUserAgent(browserVersion));
    expect(uas('/')).toEqual([expectedUserAgent(browserVersion)]);
  });

  test('Chromium agentique (E5/E6) : la chaîne exacte du moteur dès le lancement', async () => {
    seen = [];
    const ua = await withEgress(async (egress) => {
      const ab = await launchAgentBrowser({ egressServer: egress.server, allowedHosts: [HOST], allowWriteActions: false });
      try {
        await ab.page.goto(base('/'), { waitUntil: 'load' });
        await ab.page.waitForResponse((r) => r.url().endsWith('/sub')).catch(() => undefined);
        return await ab.page.evaluate(() => navigator.userAgent);
      } finally {
        await ab.close();
      }
    });
    expect(ua).toBe(expectedUserAgent(browserVersion));
    expect(uas('/')).toEqual([expectedUserAgent(browserVersion)]);
    expect(uas('/sub')).toEqual([expectedUserAgent(browserVersion)]);
  }, 60_000);

  test('identique d’un run à l’autre : deux runs complets (client HTTP, contexte, Chromium agentique) donnent la même chaîne', async () => {
    const runs: string[][] = [];
    for (let run = 0; run < 2; run++) {
      seen = [];
      const identity = await identityOf();
      const session = openNetworkSession({ rung: { mode: 'direct' }, guard, userAgent: identity.userAgent });
      try {
        await session.fetch(base('/api'));
      } finally {
        await session.close();
      }
      await visitWithRunContext(identity.userAgent);
      runs.push(uas());
    }
    expect(new Set(runs.flat())).toEqual(new Set([expectedUserAgent(browserVersion)]));
    expect(runs[0]).toEqual(runs[1]);
  });

  test('identify_instance activé : le jeton compatible; Scrapyomama/<version>; +<contact> (E1, Chromium) et From (E1, contact électronique)', async () => {
    seen = [];
    const identity = await identityOf({ identify: true });
    const expected = expectedUserAgent(browserVersion) + TOKEN_SUFFIX('1.2.3', 'mailto:ops@zz-test.example');
    expect(identity).toEqual({ userAgent: expected, from: 'ops@zz-test.example' });
    const session = openNetworkSession({ rung: { mode: 'direct' }, guard, userAgent: identity.userAgent, ...(identity.from === null ? {} : { from: identity.from }) });
    try {
      await session.fetch(base('/api'));
    } finally {
      await session.close();
    }
    const e1 = seen.filter((s) => s.path === '/api');
    expect(e1.map((s) => s.headers['user-agent'])).toEqual([expected]);
    expect(e1.map((s) => s.headers['from'])).toEqual(['ops@zz-test.example']);
    seen = [];
    const page = await visitWithRunContext(identity.userAgent);
    expect(page.navigator).toBe(expected);
    expect(uas('/')).toEqual([expected]);
    expect(uas('/sub')).toEqual([expected]);
    // Contact URL : le jeton le porte ; aucun From (RFC 9110 : une adresse électronique).
    const byUrl = await identityOf({ identify: true, contact: 'https://ops.zz-test.example/robot' });
    expect(byUrl).toEqual({ userAgent: expectedUserAgent(browserVersion) + TOKEN_SUFFIX('1.2.3', 'https://ops.zz-test.example/robot'), from: null });
    // Réglage coupé : retour à la chaîne du moteur seule.
    expect((await identityOf({ identify: false })).userAgent).toBe(expectedUserAgent(browserVersion));
  });
});

describe('assert_no_fingerprint_spoofing : navigator.webdriver intact, aucun override CDP interdit, chaîne stable', () => {
  test('navigator.webdriver reste vrai dans la page : contexte de run et Chromium agentique', async () => {
    const run = await visitWithRunContext(undefined);
    expect(run.webdriver).toBe(true);
    const agent = await withEgress(async (egress) => {
      const ab = await launchAgentBrowser({ egressServer: egress.server, allowedHosts: [HOST], allowWriteActions: false });
      try {
        await ab.page.goto(base('/'));
        return await ab.page.evaluate(() => (navigator as unknown as { webdriver?: boolean }).webdriver);
      } finally {
        await ab.close();
      }
    });
    expect(agent).toBe(true);
  }, 60_000);

  test('commandes CDP envoyées (journal pw:protocol, tous les scénarios ci-dessus) : aucun override interdit', () => {
    // Le journal doit exister : sans lui, le test serait creux.
    expect(sent.length).toBeGreaterThan(50);
    expect(sent.some((m) => m.method === 'Emulation.setUserAgentOverride')).toBe(true);
    const methods = new Set(sent.map((m) => m.method));
    for (const forbidden of [
      'Emulation.setHardwareConcurrencyOverride',
      'Emulation.setNavigatorOverrides',
      'Emulation.setTimezoneOverride',
      'Emulation.setLocaleOverride',
      'Emulation.setGeolocationOverride',
      'Emulation.setAutomationOverride',
      'Emulation.setSensorOverrideEnabled',
      'Network.setUserAgentOverride',
    ]) {
      expect(methods.has(forbidden), forbidden).toBe(false);
    }
    // Domaine Emulation : seuls les appels propres à Playwright (fenêtre, focus, médias) et le User-Agent exact du moteur.
    const TOLERATED = new Set(['Emulation.setFocusEmulationEnabled', 'Emulation.setDeviceMetricsOverride', 'Emulation.setEmulatedMedia', 'Emulation.setUserAgentOverride', 'Emulation.setDefaultBackgroundColorOverride']);
    expect([...methods].filter((m) => m.startsWith('Emulation.') && !TOLERATED.has(m))).toEqual([]);
    // User-Agent : vide (aucun override) ou la chaîne exacte du moteur, avec ou sans le jeton de l'instance ; ni langue
    // ni indices clients inventés (`userAgentMetadata` ne porte ni marques ni versions complètes, seulement ce que
    // Playwright déduit lui-même de la chaîne).
    const exact = expectedUserAgent(browserVersion);
    for (const message of sent.filter((m) => m.method === 'Emulation.setUserAgentOverride')) {
      const params = message.params ?? {};
      const ua = String(params['userAgent']);
      expect(ua === '' || ua === exact || ua.startsWith(`${exact} (compatible; Scrapyomama/`), ua).toBe(true);
      expect(ua).not.toContain('HeadlessChrome');
      expect(params['acceptLanguage']).toBeUndefined();
      const metadata = params['userAgentMetadata'] as Record<string, unknown> | undefined;
      if (metadata !== undefined) {
        expect(Object.keys(metadata).sort()).toEqual(['architecture', 'mobile', 'model', 'platform', 'platformVersion']);
        expect(metadata['mobile']).toBe(false);
      }
    }
    // Aucun script injecté ne touche webdriver, le matériel ou les propriétés de navigator.
    for (const message of sent.filter((m) => m.method === 'Page.addScriptToEvaluateOnNewDocument')) {
      expect(String(message.params?.['source'] ?? '')).not.toMatch(/webdriver|hardwareConcurrency|deviceMemory|userAgentData|navigator\.(plugins|languages|platform|vendor)|defineProperty\(\s*navigator\s*,/);
    }
  });

  test('la chaîne ne varie pas entre deux runs d’une même image', async () => {
    const strings = new Set<string>();
    for (let run = 0; run < 2; run++) strings.add((await visitWithRunContext(undefined)).navigator);
    expect(strings).toEqual(new Set([expectedUserAgent(browserVersion)]));
  });
});
