// SPDX-License-Identifier: AGPL-3.0-only
// assert_user_agent_engine_real et assert_no_fingerprint_spoofing (INV6, X2, tâche 1.11, décision du 2026-10-01, 17 §5).
// Étage S (vrai Chromium 153, Playwright 1.63) sur une fixture qui ENREGISTRE les en-têtes reçus :
// - E1 (client HTTP) puis contextes Chromium (E2/E3, défaut des E4/E5) puis Chromium agentique (E5/E6) : l'en-tête
//   `User-Agent` vaut EXACTEMENT la chaîne du moteur, calculée ici depuis `browser.version()` et la plateforme réelle
//   (jamais une constante), sans `HeadlessChrome`, identique d'un run à l'autre ; E1 envoie aussi `Accept` et
//   `Accept-Language` d'un navigateur ;
// - `identify_instance` activé : le jeton `compatible; Scrapyomama/<version>; +<contact>` et `From` (adresse électronique) ;
// - aucun masquage : `navigator.webdriver` reste vrai dans la page ; les indices clients (`navigator.userAgentData`,
//   `Sec-CH-UA-*`) d'un contexte de run, cadre principal ET cadre hors processus, sont ceux d'un contexte vierge du même
//   navigateur (architecture, plateforme et sa version, marques, versions complètes : rien n'est déduit de la chaîne) ;
// - les commandes CDP réellement envoyées (journal `pw:protocol` de Playwright) ne sortent pas de la liste fermée de
//   17 §11 (`setDeviceMetricsOverride` avec `mobile: false`, `setFocusEmulationEnabled`, `setUserAgentOverride` avec
//   la chaîne exacte du moteur et un `userAgentMetadata` égal, champ par champ, aux valeurs réelles du moteur), plus
//   `setEmulatedMedia` sans valeur émulée ou avec les seules valeurs du moteur (D-39).
// Le volet statique (liste noire, code source) est dans tests/no-fingerprint-spoofing.unit.test.ts.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { chromium, type Frame } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

// Journal des commandes CDP : le `debug` de Playwright lit DEBUG au chargement du paquet, avant tout import.
vi.hoisted(() => {
  process.env['DEBUG'] = [process.env['DEBUG'], 'pw:protocol'].filter(Boolean).join(',');
});

import { BrowserPool } from '../../apps/worker/src/browser/pool.ts';
import { createLocalProvider } from '../../apps/worker/src/browser/provider-local.ts';
import { chromiumLaunchOptions } from '../../apps/worker/src/browser/launch.ts';
import { launchAgentBrowser } from '../../apps/worker/src/browser/agent-browser.ts';
import { openRunContext } from '../../apps/worker/src/browser/run-context.ts';
import { robotIdentity, type RobotIdentity } from '../../apps/worker/src/exec/robot-identity.ts';
import * as net from '@runtime/core/net';
import { openBrowserEgress, openNetworkSession, startEgressProxy, type BrowserEgress, type EgressProxy, type SsrfGuard } from '@runtime/core/net';
import { fixtureGuard } from '../helpers/fixture-net.ts';

const HOST = 'zz_test_ua.localhost';
/** Second site (cadre hors processus : isolation des sites de Chromium). */
const HOST2 = 'zz_test_ub.localhost';
/** Médias jamais émulés : `Emulation.setEmulatedMedia` de Playwright ne porte alors aucune valeur (D-39). */
const NO_MEDIA_EMULATION = { colorScheme: null, reducedMotion: null, forcedColors: null, contrast: null } as const;
/** Indices clients à haute entropie demandés au moteur (tous ceux de Chromium 153). */
const HIGH_ENTROPY = ['architecture', 'bitness', 'formFactors', 'fullVersionList', 'model', 'platformVersion', 'uaFullVersion', 'wow64'];
/** En-têtes d'indices clients demandés par la fixture (`Accept-CH`) et comparés au contexte vierge. */
const CH_HEADERS = ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-model', 'sec-ch-ua-platform-version', 'sec-ch-ua-full-version-list', 'sec-ch-ua-wow64'];
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
const base = (path = '/', host = HOST): string => `http://${host}:${port}${path}`;
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
    // Sauts de redirection : même origine, puis autre origine (autre hôte) ; `From` ne suit que le premier (17 §5).
    if (req.url === '/hop-same') return void res.writeHead(302, { location: '/api' }).end();
    if (req.url === '/hop-cross') return void res.writeHead(302, { location: base('/api', HOST2) }).end();
    if (req.url === '/frame') return void res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><body><iframe src="${base('/inner', HOST2)}"></iframe></body></html>`);
    if (req.url === '/inner') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><body>inner</body></html>');
    res.writeHead(200, { 'content-type': 'text/html', 'accept-ch': CH_HEADERS.filter((h) => h !== 'sec-ch-ua' && h !== 'sec-ch-ua-mobile' && h !== 'sec-ch-ua-platform').join(', ') }).end('<!doctype html><html><body>ok<script>fetch("/sub").catch(() => {})</script></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  guard = fixtureGuard(port, [HOST, HOST2], net);
  launchProxy = await startEgressProxy({ guard, refuseAll: true });
  pool = new BrowserPool({ size: 1, launch: createLocalProvider({ launchProxyUrl: launchProxy.url, env: process.env }).launchShared, recycleAfterRuns: 100 });
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

type Hints = Record<string, unknown>;
/** Indices clients d'un cadre : marques, mobile, plateforme et toutes les valeurs à haute entropie. */
function hintsOf(frame: Frame): Promise<Hints> {
  return frame.evaluate(async (names) => {
    const data = (navigator as unknown as { userAgentData?: { brands: unknown; mobile: unknown; platform: unknown; getHighEntropyValues(n: string[]): Promise<Record<string, unknown>> } }).userAgentData;
    if (data === undefined) return { missing: true };
    return { brands: data.brands, mobile: data.mobile, platform: data.platform, ...(await data.getHighEntropyValues(names)) };
  }, HIGH_ENTROPY);
}
const chHeaders = (headers: IncomingHttpHeaders): Record<string, unknown> => Object.fromEntries(CH_HEADERS.map((h) => [h, headers[h]]));

/** Valeurs réelles du moteur : contexte vierge (aucun User-Agent, aucune émulation de médias) du même navigateur. */
let real: { hints: Hints; frameHints: Hints; media: Record<string, string>; sub: Record<string, unknown> } | undefined;
async function realEngineHints(): Promise<NonNullable<typeof real>> {
  if (real !== undefined) return real;
  seen = [];
  const out = await pool.run(signal, (browser) =>
    withEgress(async (egress) => {
      const context = await browser.newContext({ proxy: { server: egress.server }, serviceWorkers: 'block', ...NO_MEDIA_EMULATION });
      try {
        const page = await context.newPage();
        await page.goto(base('/'), { waitUntil: 'load' });
        await page.waitForResponse((r) => r.url().endsWith('/sub')).catch(() => undefined);
        const hints = await hintsOf(page.mainFrame());
        // Préférences de médias du moteur, sans émulation (valeurs que `setEmulatedMedia` aurait le droit de reprendre).
        const media = await page.evaluate(() => {
          const first = (feature: string, values: string[], fallback: string): string => values.find((v) => (globalThis as unknown as { matchMedia(query: string): { matches: boolean } }).matchMedia(`(${feature}: ${v})`).matches) ?? fallback;
          return {
            'prefers-color-scheme': first('prefers-color-scheme', ['dark', 'light'], ''),
            'prefers-reduced-motion': first('prefers-reduced-motion', ['reduce', 'no-preference'], ''),
            'forced-colors': first('forced-colors', ['active', 'none'], ''),
            'prefers-contrast': first('prefers-contrast', ['more', 'less', 'custom', 'no-preference'], ''),
          };
        });
        await page.goto(base('/frame'), { waitUntil: 'load' });
        const inner = page.frames().find((f) => f.url().endsWith('/inner'));
        if (inner === undefined) throw new Error('cadre /inner absent');
        return { hints, frameHints: await hintsOf(inner), media };
      } finally {
        await context.close();
      }
    }),
  );
  const sub = seen.find((s) => s.path === '/sub');
  if (sub === undefined) throw new Error('sous-ressource /sub absente');
  real = { ...out, sub: chHeaders(sub.headers) };
  return real;
}
/** `userAgentMetadata` CDP attendu : les valeurs réelles du moteur, champ par champ. */
const expectedMetadata = (h: Hints): Record<string, unknown> => ({
  brands: h['brands'],
  fullVersionList: h['fullVersionList'],
  fullVersion: h['uaFullVersion'],
  platform: h['platform'],
  platformVersion: h['platformVersion'],
  architecture: h['architecture'],
  model: h['model'],
  mobile: h['mobile'],
  bitness: h['bitness'],
  wow64: h['wow64'],
  ...(Array.isArray(h['formFactors']) ? { formFactors: h['formFactors'] } : {}),
});

describe('assert_user_agent_engine_real : le User-Agent est celui du moteur embarqué, sans HeadlessChrome', () => {
  test('la valeur attendue est celle du vrai moteur : un contexte sans aucun réglage annonce la même chaîne, à HeadlessChrome et à la version complète près', async () => {
    const raw = await pool.run(signal, async (browser) => {
      const context = await browser.newContext(NO_MEDIA_EMULATION);
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

  test('E1 (client HTTP) : User-Agent exactement celui du moteur, Accept de navigateur, Accept-Language du moteur (aucun), pas de From ni de jeton', async () => {
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
      // Un Chromium vierge n'envoie aucun Accept-Language (assert_accept_language_engine_real) : E1 non plus.
      expect(r.headers['accept-language']).toBeUndefined();
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

  test('fenêtre ouverte par la page (window.open, lien target=_blank) : aucune requête ne part avec une autre chaîne que celle du moteur', async () => {
    seen = [];
    await pool.run(signal, (browser) =>
      withEgress(async (egress) => {
        const rc = await openRunContext(browser, { egressServer: egress.server, allowedHosts: [HOST] });
        try {
          await rc.page.goto(base('/'), { waitUntil: 'load' });
          await rc.page.evaluate((url) => {
            type Link = { href: string; target: string; click(): void };
            const w = globalThis as unknown as { open(url: string): unknown; document: { createElement(tag: 'a'): Link; body: { append(node: Link): void } } };
            w.open(url + '?w');
            const a = w.document.createElement('a');
            a.href = url + '?a';
            a.target = '_blank';
            w.document.body.append(a);
            a.click();
          }, base('/popup'));
          await new Promise((resolve) => setTimeout(resolve, 1500));
        } finally {
          await rc.close();
        }
      }),
    );
    expect(uas('/').length).toBeGreaterThan(0);
    expect(uas('/popup')).toEqual([]);
    expect([...new Set(uas())]).toEqual([expectedUserAgent(browserVersion)]);
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
    // Sauts (17 §5) : le jeton suit chaque saut ; `From` suit un saut de même origine, pas un saut vers une autre origine.
    seen = [];
    const hops = openNetworkSession({ rung: { mode: 'direct' }, guard, userAgent: identity.userAgent, ...(identity.from === null ? {} : { from: identity.from }) });
    try {
      await hops.fetch(base('/hop-same'));
      await hops.fetch(base('/hop-cross'));
    } finally {
      await hops.close();
    }
    const landed = seen.filter((s) => s.path === '/api').map((s) => ({ host: String(s.headers['host']).split(':')[0], ua: s.headers['user-agent'], from: s.headers['from'] }));
    expect(landed).toEqual([
      { host: HOST, ua: expected, from: 'ops@zz-test.example' },
      { host: HOST2, ua: expected, from: undefined },
    ]);
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

  test('indices clients réels : contexte de run (chaîne du moteur, puis avec le jeton) = contexte vierge, cadre principal et cadre d’un autre site, dans le processus ou hors processus', async () => {
    const reference = await realEngineHints();
    expect(reference.hints['missing']).toBeUndefined();
    expect(reference.hints['platformVersion']).toEqual(expect.any(String));
    const identified = (await identityOf({ identify: true })).userAgent;
    // Isolation des sites forcée (`--site-per-process`) : le cadre de l'autre site a sa propre cible CDP. Sans elle
    // (défaut du Chromium headless de Playwright), il partage le processus de la page.
    const isolated = new BrowserPool({
      size: 1,
      recycleAfterRuns: 100,
      launch: async () => {
        const options = chromiumLaunchOptions(launchProxy.url, process.env);
        const server = await chromium.launchServer({ ...options, args: [...options.args, '--site-per-process'], proxy: { ...options.proxy } });
        const browser = await chromium.connect(server.wsEndpoint());
        return { browser, close: async () => (await browser.close().catch(() => undefined), await server.close()), kill: () => server.kill() };
      },
    });
    try {
      for (const [lender, outOfProcess] of [[pool, false], [isolated, true]] as const) {
        for (const userAgent of [undefined, identified]) {
          seen = [];
          const got = await lender.run(signal, (browser) =>
            withEgress(async (egress) => {
              const rc = await openRunContext(browser, { egressServer: egress.server, allowedHosts: [HOST, HOST2], ...(userAgent === undefined ? {} : { userAgent }) });
              try {
                await rc.page.goto(base('/'), { waitUntil: 'load' });
                await rc.page.waitForResponse((r) => r.url().endsWith('/sub')).catch(() => undefined);
                const hints = await hintsOf(rc.page.mainFrame());
                await rc.page.goto(base('/frame'), { waitUntil: 'load' });
                const inner = rc.page.frames().find((f) => f.url().endsWith('/inner'));
                if (inner === undefined) throw new Error('cadre /inner absent');
                // Le cadre d'un autre site est bien hors processus : il a sa propre cible CDP.
                const oopif = await rc.context.newCDPSession(inner).then(
                  async (s) => (await s.detach().catch(() => undefined), true),
                  () => false,
                );
                return { hints, frameHints: await hintsOf(inner), frameUa: await inner.evaluate(() => navigator.userAgent), oopif };
              } finally {
                await rc.close();
              }
            }),
          );
          const ua = userAgent ?? expectedUserAgent(browserVersion);
          expect(got.oopif).toBe(outOfProcess);
          expect(got.hints).toEqual(reference.hints);
          expect(got.frameHints).toEqual(reference.frameHints);
          expect(got.frameUa).toBe(ua);
          expect(uas('/inner')).toEqual([ua]);
          const sub = seen.find((s) => s.path === '/sub');
          expect(sub && chHeaders(sub.headers)).toEqual(reference.sub);
          expect(sub?.headers['user-agent']).toBe(ua);
        }
      }
    } finally {
      await isolated.close();
    }
  }, 120_000);

  test('commandes CDP envoyées (journal pw:protocol, tous les scénarios ci-dessus) : aucun override interdit', async () => {
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
    // Domaine Emulation : liste fermée de 17 §11, plus `setEmulatedMedia` sans valeur émulée (D-39). Tout autre appel échoue.
    const TOLERATED = new Set(['Emulation.setFocusEmulationEnabled', 'Emulation.setDeviceMetricsOverride', 'Emulation.setUserAgentOverride', 'Emulation.setEmulatedMedia']);
    expect([...methods].filter((m) => m.startsWith('Emulation.') && !TOLERATED.has(m))).toEqual([]);
    const metrics = sent.filter((m) => m.method === 'Emulation.setDeviceMetricsOverride');
    expect(metrics.length).toBeGreaterThan(0);
    for (const message of metrics) expect(message.params?.['mobile'], JSON.stringify(message.params)).toBe(false);
    // Médias (D-39) : aucun type de média émulé ; chaque préférence vide (aucune émulation : contextes de run) ou égale à
    // celle du moteur constatée sans émulation (contexte par défaut du Chromium agentique, où Playwright reprend ses
    // défauts). Jamais une valeur que le moteur n'a pas.
    const media = (await realEngineHints()).media;
    expect(Object.values(media).every((v) => v !== '')).toBe(true);
    for (const message of sent.filter((m) => m.method === 'Emulation.setEmulatedMedia')) {
      expect(message.params?.['media'] ?? '', JSON.stringify(message.params)).toBe('');
      for (const feature of (message.params?.['features'] ?? []) as { name?: unknown; value?: unknown }[]) {
        expect(['', media[String(feature.name)]], JSON.stringify(message.params)).toContain(feature.value ?? '');
      }
    }
    // User-Agent : vide (aucun override) ou la chaîne exacte du moteur, avec ou sans le jeton de l'instance ; ni langue,
    // ni plateforme, ni indices clients autres que les valeurs RÉELLES du moteur, comparées champ par champ à celles d'un
    // contexte vierge du même navigateur (architecture, plateforme et sa version, modèle, marques, versions complètes).
    const exact = expectedUserAgent(browserVersion);
    const metadataReal = expectedMetadata((await realEngineHints()).hints);
    const overrides = sent.filter((m) => m.method === 'Emulation.setUserAgentOverride');
    expect(overrides.some((m) => String(m.params?.['userAgent'] ?? '') !== '')).toBe(true);
    for (const message of overrides) {
      const params = message.params ?? {};
      const ua = String(params['userAgent']);
      expect(ua === '' || ua === exact || ua.startsWith(`${exact} (compatible; Scrapyomama/`), ua).toBe(true);
      expect(ua).not.toContain('HeadlessChrome');
      expect(params['acceptLanguage']).toBeUndefined();
      expect(params['platform']).toBeUndefined();
      const metadata = params['userAgentMetadata'] as Record<string, unknown> | undefined;
      if (ua === '') expect(metadata).toBeUndefined();
      else expect(metadata, ua).toEqual(metadataReal);
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
