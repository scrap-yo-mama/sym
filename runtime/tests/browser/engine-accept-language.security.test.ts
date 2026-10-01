// SPDX-License-Identifier: AGPL-3.0-only
// assert_accept_language_engine_real, assert_no_locale_cdp_override et assert_ui_locale_not_in_target_requests (INV6, X2, tâche 3.20,
// 21 § 6, 21b M8), étage S : vrai Chromium 153 (Playwright 1.63) sur une fixture qui ENREGISTRE les en-têtes reçus et ce que la page
// voit d'elle-même (langues, fuseau).
// - la valeur attendue est celle d'un Chromium VIERGE du même navigateur (contexte sans aucun réglage), lue sur le moteur, jamais écrite
//   ici ; `ENGINE_ACCEPT_LANGUAGE` (ce que le client HTTP envoie) lui est égal ;
// - E1 (client HTTP, y compris quand une stratégie pose son propre `Accept-Language`), E2/E3 (contexte de run) et Chromium agentique
//   (E5/E6) envoient EXACTEMENT cette valeur, identique d'un essai à l'autre ;
// - la langue de l'interface et le fuseau d'un compte (ici : un compte `fr`, `Europe/Paris`, une instance `DEFAULT_LOCALE=fr`) ne
//   changent rien : aucun en-tête, aucune URL, aucun corps reçu par la fixture ne les porte, et la page voit les langues et le fuseau
//   RÉELS du moteur ;
// - les commandes CDP réellement envoyées (journal `pw:protocol`) ne contiennent aucune commande de langue ni de fuseau, ni d'en-tête
//   `Accept-Language` ajouté ; les arguments de lancement n'ont pas `--lang`.
// Le volet statique (code source) est dans tests/i18n-engine.unit.test.ts ; l'enquête `fr` puis `en` de bout en bout est rejouée en 4.3.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

// Journal des commandes CDP : le `debug` de Playwright lit DEBUG au chargement du paquet, avant tout import.
vi.hoisted(() => {
  process.env['DEBUG'] = [process.env['DEBUG'], 'pw:protocol'].filter(Boolean).join(',');
});

import { ENGINE_ACCEPT_LANGUAGE } from '@runtime/core/access';
import * as net from '@runtime/core/net';
import { openBrowserEgress, openNetworkSession, startEgressProxy, type BrowserEgress, type EgressProxy, type SsrfGuard } from '@runtime/core/net';
import { isValidTimeZone, resolveLocale } from '@runtime/i18n';
import { launchAgentBrowser } from '../../apps/worker/src/browser/agent-browser.ts';
import { chromiumLaunchOptions } from '../../apps/worker/src/browser/launch.ts';
import { BrowserPool, playwrightLauncher } from '../../apps/worker/src/browser/pool.ts';
import { openRunContext } from '../../apps/worker/src/browser/run-context.ts';
import { robotIdentity } from '../../apps/worker/src/exec/robot-identity.ts';
import { fixtureGuard } from '../helpers/fixture-net.ts';
import { allowAllRequests } from '../helpers/robots-allow.ts';

const HOST = 'zz_test_al.localhost';
/** Compte de l'interface : langue et fuseau qui ne doivent atteindre AUCUNE requête vers un site. */
const UI_USER = { locale: 'fr', timezone: 'Europe/Paris' } as const;
const signal = new AbortController().signal;

type Seen = { path: string; headers: IncomingHttpHeaders; body: string };
let server: Server;
let port: number;
let seen: Seen[] = [];
type PageSelf = { language: string; languages: readonly string[]; timeZone: string };
let reported: PageSelf[] = [];
let guard: SsrfGuard;
let launchProxy: EgressProxy;
let pool: BrowserPool;
const base = (path = '/'): string => `http://${HOST}:${port}${path}`;
const acceptLanguages = (path?: string): string[] => seen.filter((s) => path === undefined || s.path === path).map((s) => String(s.headers['accept-language'] ?? ''));

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

const PAGE = `<!doctype html><html><body>ok<script>
  fetch('/self', { method: 'POST', body: JSON.stringify({ language: navigator.language, languages: navigator.languages, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }) }).catch(() => {});
  fetch('/sub').catch(() => {});
</script></body></html>`;

beforeAll(async () => {
  captureProtocol();
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      seen.push({ path, headers: req.headers, body });
      if (path === '/self') {
        reported.push(JSON.parse(body) as PageSelf);
        return void res.writeHead(204).end();
      }
      if (path === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow:\n');
      if (path === '/api') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"items":[]}');
      res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  guard = fixtureGuard(port, [HOST], net);
  launchProxy = await startEgressProxy({ guard, refuseAll: true });
  // Instance en français et compte `fr` : rien de cela ne doit atteindre le moteur.
  process.env['DEFAULT_LOCALE'] = UI_USER.locale;
  pool = new BrowserPool({ size: 1, launch: playwrightLauncher(launchProxy.url, process.env), recycleAfterRuns: 100 });
  await pool.run(signal, async (browser) => browser.version());
}, 120_000);

afterAll(async () => {
  delete process.env['DEFAULT_LOCALE'];
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

/** Ce qu'un Chromium vierge (aucune option) envoie et voit : la référence, lue sur le moteur. */
let real: { header: string; self: PageSelf } | undefined;
async function virgin(): Promise<NonNullable<typeof real>> {
  if (real !== undefined) return real;
  seen = [];
  reported = [];
  await pool.run(signal, (browser) =>
    withEgress(async (egress) => {
      const context = await browser.newContext({ proxy: { server: egress.server }, serviceWorkers: 'block' });
      try {
        const page = await context.newPage();
        await page.goto(base('/'), { waitUntil: 'load' });
        await page.waitForResponse((r) => r.url().endsWith('/sub')).catch(() => undefined);
      } finally {
        await context.close();
      }
    }),
  );
  const header = acceptLanguages('/')[0];
  if (header === undefined || reported[0] === undefined) throw new Error('le Chromium vierge n’a rien envoyé');
  real = { header, self: reported[0] };
  return real;
}

describe('assert_accept_language_engine_real : la langue envoyée est celle du moteur, jamais celle de l’interface', () => {
  test('la valeur de référence est celle d’un Chromium vierge, et ENGINE_ACCEPT_LANGUAGE (client HTTP) lui est égale', async () => {
    const ref = await virgin();
    expect(ref.header).toBe(ENGINE_ACCEPT_LANGUAGE);
    expect(ref.self.languages.length).toBeGreaterThan(0);
    // Le compte `fr` de l'interface n'a rien changé au moteur : la résolution de langue de l'UI est un autre monde.
    expect(resolveLocale({ surface: 'console', user: UI_USER.locale }, ['en', 'fr']).locale).toBe('fr');
    expect(ref.header).not.toMatch(/fr/i);
    expect(isValidTimeZone(UI_USER.timezone)).toBe(true);
    expect(ref.self.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  test('E1 (client HTTP) : même liste que Chromium, y compris quand la stratégie pose son propre Accept-Language ; jamais la langue du compte', async () => {
    const ref = await virgin();
    seen = [];
    const identity = await robotIdentity({ warn: () => undefined })();
    const session = openNetworkSession({ rung: { mode: 'direct' }, guard, userAgent: identity.userAgent });
    try {
      await session.fetch(base('/api'));
      await session.fetch(base('/api'), { headers: { 'accept-language': 'fr-FR,fr;q=0.9' } });
      await session.fetch(base('/api'), { headers: { 'Accept-Language': `${UI_USER.locale}-FR` } });
    } finally {
      await session.close();
    }
    expect(acceptLanguages('/api')).toEqual([ref.header, ref.header, ref.header]);
  });

  test('E2/E3 (contexte de run) : document et sous-ressource portent la valeur du moteur, la page voit les langues et le fuseau réels', async () => {
    const ref = await virgin();
    seen = [];
    reported = [];
    await pool.run(signal, (browser) =>
      withEgress(async (egress) => {
        const rc = await openRunContext(browser, { egressServer: egress.server, allowedHosts: [HOST], checkRequest: allowAllRequests });
        try {
          await rc.page.goto(base('/'), { waitUntil: 'load' });
          await rc.page.waitForResponse((r) => r.url().endsWith('/sub')).catch(() => undefined);
        } finally {
          await rc.close();
        }
      }),
    );
    expect(acceptLanguages('/')).toEqual([ref.header]);
    expect(acceptLanguages('/sub')).toEqual([ref.header]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toEqual(ref.self);
  });

  test('Chromium agentique (E5/E6) : même valeur dès le lancement, deux essais identiques', async () => {
    const ref = await virgin();
    const runs: string[][] = [];
    for (let i = 0; i < 2; i++) {
      seen = [];
      reported = [];
      await withEgress(async (egress) => {
        const ab = await launchAgentBrowser({ egressServer: egress.server, allowedHosts: [HOST], allowWriteActions: false, checkRequest: allowAllRequests });
        try {
          await ab.page.goto(base('/'), { waitUntil: 'load' });
          await ab.page.waitForResponse((r) => r.url().endsWith('/sub')).catch(() => undefined);
        } finally {
          await ab.close();
        }
      });
      runs.push(acceptLanguages());
      expect(reported[0]).toEqual(ref.self);
    }
    expect(runs[0]).toEqual(runs[1]);
    expect([...new Set(runs[0])]).toEqual([ref.header]);
  }, 60_000);
});

describe('assert_ui_locale_not_in_target_requests : la langue et le fuseau du compte n’atteignent aucune requête vers un site', () => {
  test('aucun en-tête, aucune URL ni aucun corps reçu par la fixture ne porte la langue, le fuseau ou une ville du compte', async () => {
    const all = JSON.stringify(seen.map((s) => ({ path: s.path, headers: s.headers, body: s.body })));
    // Les visites précédentes (E1, E2/E3, E5/E6) ont toutes atteint la fixture : le contrôle porte sur des requêtes réelles.
    expect(seen.length).toBeGreaterThan(3);
    expect(all).not.toContain(UI_USER.timezone);
    expect(all).not.toMatch(/Europe\/Paris|Paris/);
    expect(all).not.toMatch(/accept-language":"[^"]*\bfr\b/i);
    expect(all).not.toMatch(/\bfr-FR\b/);
    // La page n'a jamais rapporté le fuseau du compte : le fuseau vu est celui de la machine.
    for (const self of reported) expect(self.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe('assert_no_locale_cdp_override : aucune commande CDP de langue ou de fuseau', () => {
  test('le journal des commandes réellement envoyées ne contient ni setLocaleOverride, ni setTimezoneOverride, ni en-tête Accept-Language ajouté', () => {
    expect(sent.length).toBeGreaterThan(20);
    const methods = [...new Set(sent.map((s) => s.method))];
    for (const forbidden of ['Emulation.setLocaleOverride', 'Emulation.setTimezoneOverride', 'Emulation.setNavigatorOverrides', 'Emulation.setAcceptLanguage', 'Emulation.setGeolocationOverride']) {
      expect(methods, forbidden).not.toContain(forbidden);
    }
    const extraHeaders = sent.filter((s) => s.method === 'Network.setExtraHTTPHeaders').map((s) => JSON.stringify(s.params ?? {}));
    for (const headers of extraHeaders) expect(headers.toLowerCase()).not.toContain('accept-language');
    // `Emulation.setUserAgentOverride` ne porte aucune langue (`acceptLanguage` absent ou vide) : seul le User-Agent (D-39).
    for (const s of sent.filter((x) => x.method === 'Emulation.setUserAgentOverride')) expect(String(s.params?.['acceptLanguage'] ?? '')).toBe('');
  });

  test('les arguments de lancement n’ont ni --lang ni langue forcée', () => {
    const args = chromiumLaunchOptions('http://127.0.0.1:1', process.env).args ?? [];
    expect(args.filter((a) => /^--(lang|accept-lang|force-lang)/i.test(a))).toEqual([]);
  });
});
