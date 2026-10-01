// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.6, livrable vérifiable (10-taches) : « Chaque exécuteur produit une sortie conforme sur les fixtures API,
// SSR et SPA. Chromium à vide : 0 requête sortante. » Étage S (seul job qui installe Chromium) : vrai Chromium 153
// (Playwright 1.63) lancé par le pool du worker, proxy de lancement fermé, proxy d'egress par essai (garde SSRF),
// chaînage au proxy BYO (CONNECT, SOCKS5), politique de domaines en seconde couche, `request.newContext` avec proxy.
// E3 en script : bac à sable de 1.5 (processus enfant, isolated-vm) avec `ctx.page.*` relayé ; `assert_sandbox` étendu à
// `ctx.page` (D-29) : une page qui exfiltre vers un domaine hors API → `sandbox_violation`, 0 requête, enfant tué < 2 s,
// y compris de façon différée (redirection, WebRTC) vue par le seul proxy d'egress ; les ressources tierces du site ne
// sont jamais imputées au script. Cadence (1.9) et `max_requests_per_run` tenus par `ctx.fetch` et `ctx.page`,
// actions d'écriture refusées sans `allow_write_actions`, lectures bornées dans la page, `ctx.log` hors du journal du worker.
import { createSocket } from 'node:dgram';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { request as playwrightRequest, type Browser } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { BrowserPool, playwrightLauncher, type BrowserPoolEvent } from '../../apps/worker/src/browser/pool.ts';
import { newEgressRequestContext, openRunContext } from '../../apps/worker/src/browser/run-context.ts';
import { runFetchInPageExecutor, runPlaywrightExecutor } from '../../apps/worker/src/exec/browser-executors.ts';
import { createPageBridge, hostViolationWatch, PAGE_OPERATIONS } from '../../apps/worker/src/exec/script.ts';
import { runScriptExecutor, type ScriptRunOutcome } from '../../apps/worker/src/exec/script-executor.ts';
import { ProcessSandboxEngine, sandboxOptionsFromEnv } from '../../apps/worker/src/sandbox/engine.ts';
type Logger = Parameters<typeof runScriptExecutor>[0]['logger'];
import { startClient, type Client } from '../../fixtures/src/test-helpers.ts';
// Paquets construits, comme le worker : mêmes classes (erreurs de garde, DslError) des deux côtés.
import { DomainPacer, Secret, validateDeclarativeSpec, validateOutput, type DeclarativeSpec } from '@runtime/core';
import { domainRequestPacer, failureRoute, runFetchExecutor, type DeclarativeRunResult, type ExecFailure, type HttpExchange, type RequestPacer } from '@runtime/core/exec';
import * as net from '@runtime/core/net';
import {
  openBrowserEgress,
  openNetworkSession,
  parseProxyDefinition,
  startEgressProxy,
  type BrowserEgress,
  type EgressProxy,
  type NetworkRung,
  type SsrfGuard,
} from '@runtime/core/net';
import { contactsSpecInput, fixtureGuard, SCHEMA_CONTACT, SCHEMA_PRODUCT, spaApiSpecInput, spaSpecInput, ssrSpecInput } from '../helpers/fixture-net.ts';
import { memoryPacingStore } from '../helpers/memory-pacing.ts';
import { startConnectProxy, startSocks5Proxy, type UpstreamTestProxy } from '../helpers/upstream-proxies.ts';

const API = 'zz_test_api_json.localhost';
const SSR = 'zz_test_ssr.localhost';
const SPA = 'zz_test_spa.localhost';
const SLOW = 'zz_test_slow.localhost';
/** Hôte joignable pour la garde SSRF mais hors des domaines de l'API : seul le verrou de domaines doit le couper. */
const INTERNAL = 'zz_test_internal.localhost';
/** Redirige `/to-internal` vers INTERNAL : le saut n'est vu que par le proxy d'egress. */
const SSRF = 'zz_test_ssrf.localhost';
/** Tiers d'une page du site (mesure d'audience) : compte toute requête reçue. */
const EVIL = 'zz_test_evil.localhost';
const LIMITED = 'zz_test_429.localhost';
const PERSONAL = 'zz_test_personal.localhost';
/** Refus en cours de script (INV6) : 403 nu, défi servi en 200, 401 JSON. */
const SIGNED403 = 'zz_test_signed403.localhost';
const CHALLENGE_200 = 'zz_test_challenge_200.localhost';
const LOGIN = 'zz_test_login.localhost';
const HOSTS = [API, SSR, SPA, SLOW, INTERNAL, SSRF, EVIL, LIMITED, PERSONAL, SIGNED403, CHALLENGE_200, LOGIN];

let client: Client;
let guard: SsrfGuard;
let launchProxy: EgressProxy;
const launchSeen: string[] = [];
const events: BrowserPoolEvent[] = [];
let pool: BrowserPool;
let base: (host: string) => string;
const signal = new AbortController().signal;

beforeAll(async () => {
  client = await startClient();
  base = (host) => `http://${host}:${client.server.port}`;
  guard = fixtureGuard(client.server.port, HOSTS, net);
  // Proxy de lancement FERMÉ : tout ce que Chromium émettrait hors d'un contexte de run y arrive et y est refusé.
  launchProxy = await startEgressProxy({ guard, refuseAll: true, onRequest: (t) => launchSeen.push(`${t.via} ${t.host}:${t.port}`) });
  pool = new BrowserPool({ size: 1, launch: playwrightLauncher(launchProxy.url, process.env), recycleAfterRuns: 100, onEvent: (e) => events.push(e) });
}, 120_000);
afterAll(async () => {
  await pool?.close();
  await launchProxy?.close();
  await client?.close();
});
beforeEach(async () => {
  await client.reset();
});

function valid(raw: Record<string, unknown>, schema: unknown): DeclarativeSpec {
  const check = validateDeclarativeSpec(raw, { outputSchema: schema });
  if (!check.ok) throw new Error(JSON.stringify(check.errors));
  return check.spec;
}

async function withEgress<T>(rung: NetworkRung, fn: (egress: BrowserEgress) => Promise<T>, extra: Partial<Parameters<typeof openBrowserEgress>[0]> = {}): Promise<T> {
  const egress = await openBrowserEgress({ rung, guard, ...extra });
  try {
    return await fn(egress);
  } finally {
    await egress.close();
  }
}

function expectConform(out: DeclarativeRunResult, schema: unknown, count: number): void {
  expect(out.ok, JSON.stringify(out.ok ? {} : out.failure)).toBe(true);
  if (!out.ok) return;
  expect(out.records).toHaveLength(count);
  for (const r of out.records) expect(validateOutput(schema, r)).toEqual({ ok: true });
}

describe('assert_chromium_idle_silent : Chromium à vide, 0 requête sortante', () => {
  test('lancement, contexte de run ouvert sur about:blank, 10 s d’inactivité : rien au proxy de lancement ni à l’egress', async () => {
    launchSeen.length = 0;
    await pool.run(signal, (browser) =>
      withEgress({ mode: 'direct' }, async (egress) => {
        const rc = await openRunContext(browser, { egressServer: egress.server, allowedHosts: HOSTS });
        await rc.page.goto('about:blank');
        await new Promise((r) => setTimeout(r, 10_000));
        await rc.close();
        expect(egress.usage().requests).toBe(0);
      }),
    );
    expect(events.filter((e) => e.kind === 'launch')).toHaveLength(1);
    expect(launchSeen).toEqual([]);
    expect((await client.stats()).total).toBe(0);
  }, 60_000);

  test('assert_chromium_sandboxed : ligne de commande effective du Chromium du pool, bac à sable actif (jamais --no-sandbox)', async () => {
    await pool.run(signal, async () => {
      // Processus Chromium de CE pool : reconnus à leur proxy de lancement (port propre à ce test).
      const ps = execFileSync('ps', ['-A', '-ww', '-o', 'args='], { encoding: 'utf8' });
      const ours = ps.split('\n').filter((line) => line.includes(`--proxy-server=${launchProxy.url}`) || line.includes(`--proxy-server=127.0.0.1:${launchProxy.port}`));
      expect(ours.length).toBeGreaterThan(0);
      for (const line of ours) {
        expect(line).not.toContain('--no-sandbox');
        expect(line).toContain('--disable-component-update');
      }
    });
  });

  test('témoin : un contexte sans proxy de run passe par le proxy de lancement, qui refuse (l’observation fonctionne)', async () => {
    launchSeen.length = 0;
    await pool.run(signal, async (browser) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${base(SPA)}/`).catch(() => undefined);
      await context.close();
    });
    expect(launchSeen).toContain(`http ${SPA}:${client.server.port}`);
    expect((await client.stats()).hosts[SPA]?.total ?? 0).toBe(0);
  });
});

describe('assert_executors_conform_fixtures : E1, E2, E3 × fixtures API, SSR, SPA', () => {
  const cases = {
    api: { host: API, schema: SCHEMA_CONTACT, count: 500, spec: () => contactsSpecInput(base(API), API, 50) },
    ssr: { host: SSR, schema: SCHEMA_PRODUCT, count: 100, spec: () => ssrSpecInput(base(SSR), SSR) },
    spa_api: { host: SPA, schema: SCHEMA_PRODUCT, count: 30, spec: () => spaApiSpecInput(base(SPA), SPA) },
    spa_dom: { host: SPA, schema: SCHEMA_PRODUCT, count: 30, spec: () => spaSpecInput(base(SPA), SPA) },
  };

  test.each([['api'], ['ssr'], ['spa_api']] as const)('E1 fetch : %s', async (name) => {
    const c = cases[name];
    const session = openNetworkSession({ rung: { mode: 'direct' }, guard });
    try {
      expectConform(await runFetchExecutor(session, { spec: valid(c.spec(), c.schema), input: {}, outputSchema: c.schema, signal }), c.schema, c.count);
    } finally {
      await session.close();
    }
  });

  test.each([['api'], ['ssr'], ['spa_api']] as const)('E2 fetch_in_page : %s', async (name) => {
    const c = cases[name];
    const out = await withEgress({ mode: 'direct' }, (egress) =>
      runFetchInPageExecutor({ pool, egress, guard, spec: valid(c.spec(), c.schema), input: {}, outputSchema: c.schema, signal }),
    );
    expectConform(out, c.schema, c.count);
    // Le site est ouvert dans le navigateur (page d'accueil), puis les données sont lues par fetch dans la page.
    expect((await client.stats()).hosts[c.host]?.paths['/']).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test.each([['api'], ['ssr'], ['spa_dom']] as const)('E3 playwright : %s', async (name) => {
    const c = cases[name];
    const out = await withEgress({ mode: 'direct' }, async (egress) => {
      const result = await runPlaywrightExecutor({ pool, egress, guard, spec: valid(c.spec(), c.schema), input: {}, outputSchema: c.schema, signal });
      expect(egress.usage().requests).toBeGreaterThan(0);
      return result;
    });
    expectConform(out, c.schema, c.count);
    if (name === 'spa_dom') {
      // La SPA a exécuté son JavaScript : l'appel XHR est passé par Chromium, donc par le proxy d'egress.
      const paths = (await client.stats()).hosts[SPA]?.paths ?? {};
      expect(paths['/app.js']).toBe(1);
      expect(paths['/api/items.json']).toBe(1);
    }
  }, 60_000);
});

describe('garde SSRF et politique de domaines', () => {
  test('cible hors de la garde : E3 → forbidden (ssrf_blocked), 0 requête reçue', async () => {
    const host = 'zz_test_dom.localhost';
    const spec = valid(
      { schema_version: 1, kind: 'declarative', request: { method: 'GET', url: `${base(host)}/`, allowed_hosts: [host] }, sources: [{ id: 'dom', from: 'html', records: 'li' }], fields: { title: { attr: 'text', type: 'string', required: true } } },
      undefined,
    );
    const out = await withEgress({ mode: 'direct' }, (egress) => runPlaywrightExecutor({ pool, egress, guard, spec, input: {}, signal }));
    expect(out).toMatchObject({ ok: false, failure: { failure_class: 'forbidden', detail: 'ssrf_blocked' } });
    expect((await client.stats()).hosts[host]?.total ?? 0).toBe(0);
  });
  test('assert_domain_lock_redirects (E3) : redirection hors des domaines de l’API (saut vu par le seul proxy d’egress) → code_error domain_not_allowed, non rejouable, 0 requête vers l’hôte', async () => {
    const spec = valid(
      { schema_version: 1, kind: 'declarative', request: { method: 'GET', url: `${base(SSRF)}/to-internal`, allowed_hosts: [SSRF] }, sources: [{ id: 'dom', from: 'html', records: 'li' }], fields: { title: { attr: 'text', type: 'string', required: true } } },
      undefined,
    );
    const out = await withEgress({ mode: 'direct' }, (egress) => runPlaywrightExecutor({ pool, egress, guard, spec, input: {}, signal }), { allowedHosts: [SSRF] });
    expect(out).toMatchObject({ ok: false, failure: { failure_class: 'code_error', retryable: false, detail: 'domain_not_allowed' } });
    expect((await client.stats()).hosts[INTERNAL]?.total ?? 0).toBe(0);
  });

  test.each([
    ['451 (géo-restriction)', '451', { failure_class: 'network', detail: 'geo_restriction' }],
    ['503', '503', { failure_class: 'transient', detail: 'http_503' }],
  ])('assert_subresource_cut_not_strategy_fault (E3) : page en %s dont le site charge des tiers coupés (pixel, redirection vers un tiers vue par le seul proxy d’egress) → classe d’origine, jamais domain_not_allowed', async (_name, status, expected) => {
    const spec = valid(
      { schema_version: 1, kind: 'declarative', request: { method: 'GET', url: `${base(SPA)}/tiers?status=${status}`, allowed_hosts: [SPA] }, sources: [{ id: 'dom', from: 'html', records: 'div.spa-item' }], fields: { title: { attr: 'text', type: 'string', required: true } } },
      undefined,
    );
    let domainBlocked = 0;
    const out = await withEgress(
      { mode: 'direct' },
      async (egress) => {
        const result = await runPlaywrightExecutor({ pool, egress, guard, spec, input: {}, signal });
        domainBlocked = egress.domainBlockedCount();
        return result;
      },
      { allowedHosts: [SPA] },
    );
    expect(out).toMatchObject({ ok: false, failure: expected });
    // Les deux coupures ont bien eu lieu : pixel (seconde couche) et saut de redirection (proxy d'egress).
    expect(domainBlocked).toBeGreaterThan(0);
    expect((await client.stats()).hosts[SPA]?.paths['/tiers/pixel'] ?? 0).toBeGreaterThan(0);
    expect((await client.stats()).hosts[EVIL]?.total ?? 0).toBe(0);
  }, 60_000);

  test('E2 : page hostile qui gonfle les lectures (TextDecoder surchargé, 100 M caractères) → response_too_large, rien de gros ne quitte la page', async () => {
    await client.control({ op: 'site', site: 'spa', mode: 'hostile' });
    const spec = valid(spaApiSpecInput(base(SPA), SPA), SCHEMA_PRODUCT);
    let peak = process.memoryUsage().rss;
    const start = peak;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 5);
    try {
      const out = await withEgress({ mode: 'direct' }, (egress) => runFetchInPageExecutor({ pool, egress, guard, spec, input: {}, outputSchema: SCHEMA_PRODUCT, signal }));
      expect(out).toMatchObject({ ok: false, failure: { failure_class: 'extraction', detail: 'response_too_large' } });
    } finally {
      clearInterval(sampler);
    }
    // 100 M caractères transférés au worker coûteraient au moins 100 Mo de plus dans ce processus.
    expect(peak - start).toBeLessThan(64 * 1024 * 1024);
  }, 60_000);


  test('E2 : un fetch dans la page qui ne répond pas est borné (transient), le slot Chromium est rendu', async () => {
    const spec = valid(
      {
        schema_version: 1,
        kind: 'declarative',
        request: { method: 'GET', url: `${base(SLOW)}/data?wait_seconds=5`, allowed_hosts: [SLOW] },
        sources: [{ id: 'api', from: 'response', records: '$' }],
        fields: { ok: { path: '$.ok', type: 'boolean', required: true } },
      },
      undefined,
    );
    const started = Date.now();
    const out = await withEgress({ mode: 'direct' }, (egress) => runFetchInPageExecutor({ pool, egress, guard, spec, input: {}, signal, navigationTimeoutMs: 1_500 }));
    expect(out).toMatchObject({ ok: false, failure: { failure_class: 'transient', retryable: true } });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(pool.active()).toBe(0);
  });

  test('seconde couche : fetch et WebSocket de la page vers un hôte hors de l’API coupés, violation journalisée', async () => {
    await pool.run(signal, (browser) =>
      withEgress({ mode: 'direct' }, async (egress) => {
        const rc = await openRunContext(browser, { egressServer: egress.server, allowedHosts: [SSR] });
        await rc.page.goto(`${base(SSR)}/`);
        const fetched = await rc.page.evaluate((u) => fetch(u).then(() => 'ok', () => 'blocked'), `${base(SPA)}/api/items.json`);
        const ws = await rc.page.evaluate(
          (u) => new Promise<string>((resolve) => {
            const socket = new WebSocket(u);
            socket.onopen = () => resolve('open');
            socket.onclose = () => resolve('closed');
            socket.onerror = () => resolve('error');
          }),
          `ws://${SPA}:${client.server.port}/ws`,
        );
        await rc.close();
        expect(fetched).toBe('blocked');
        expect(ws).not.toBe('open');
        expect(rc.violations).toContain(SPA);
      }),
    );
    expect((await client.stats()).hosts[SPA]?.total ?? 0).toBe(0);
  });

  test('APIRequestContext : `request.newContext` avec le proxy d’egress, et `context.request` hérite du proxy du contexte', async () => {
    await withEgress({ mode: 'direct' }, async (egress) => {
      const api = await newEgressRequestContext(playwrightRequest, egress.server);
      const res = await api.get(`${base(SPA)}/api/items.json`);
      expect(res.status()).toBe(200);
      await api.dispose();
      expect(egress.usage().requests).toBe(1);
      await pool.run(signal, async (browser) => {
        const rc = await openRunContext(browser, { egressServer: egress.server, allowedHosts: [SPA] });
        expect((await rc.context.request.get(`${base(SPA)}/api/items.json`)).status()).toBe(200);
        await rc.close();
      });
      expect(egress.usage().requests).toBe(2);
      // Hors garde : refusé par le proxy d'egress, jamais en connexion directe.
      const denied = await newEgressRequestContext(playwrightRequest, egress.server);
      await expect(denied.get(`http://zz_test_dom.localhost:${client.server.port}/`)).resolves.toMatchObject({});
      await denied.dispose();
      expect(egress.blocked.length).toBe(1);
    });
    expect((await client.stats()).hosts['zz_test_dom.localhost']?.total ?? 0).toBe(0);
  });
});

describe('assert_browser_egress_chained : chaînage au proxy BYO (1.4)', () => {
  let connectProxy: UpstreamTestProxy;
  let socksProxy: UpstreamTestProxy;
  const creds = { username: new Secret('zz_test_user'), password: new Secret('zz_test_pass') };
  beforeAll(async () => {
    connectProxy = await startConnectProxy({ password: 'zz_test_pass' });
    socksProxy = await startSocks5Proxy({ username: 'zz_test_user', password: 'zz_test_pass' });
  });
  afterAll(async () => {
    await connectProxy?.close();
    await socksProxy?.close();
  });
  const def = (url: string) =>
    parseProxyDefinition({ id: 'zz_test_dc', type: 'dc', url, credentials_secret_id: 'zz_test_secret', allow_private_address: true, price: { per_gb_usd: 5, per_request_usd: 0.0001 } });

  test.each([['CONNECT'], ['SOCKS5']] as const)('E3 sur la SPA par un proxy %s : tout le trafic de Chromium sort par le proxy, coût imputé', async (kind) => {
    const proxy = kind === 'CONNECT' ? connectProxy : socksProxy;
    proxy.log.length = 0;
    const out = await withEgress(
      { mode: 'dc_proxy', proxy: def(proxy.url), params: {} },
      async (egress) => {
        const result = await runPlaywrightExecutor({ pool, egress, guard, spec: valid(spaSpecInput(base(SPA), SPA), SCHEMA_PRODUCT), input: {}, outputSchema: SCHEMA_PRODUCT, signal });
        const usage = egress.usage();
        expect(usage.mode).toBe('dc_proxy');
        expect(usage.costUsd).toBeGreaterThan(0);
        return result;
      },
      { credentials: creds },
    );
    expectConform(out, SCHEMA_PRODUCT, 30);
    expect(proxy.log.length).toBeGreaterThan(0);
    expect(new Set(proxy.log.map((e) => e.target))).toEqual(new Set([`${SPA}:${client.server.port}`]));
    expect(proxy.log.every((e) => e.username === 'zz_test_user' && e.password === 'zz_test_pass')).toBe(true);
  }, 60_000);
});

describe('E3 en script dans le bac à sable (1.5) : ctx.page.*, ctx.fetch, ctx.emit', () => {
  // Utilisateur dédié comme en production quand l'environnement le fournit (job security de la CI, D-30).
  const engine = new ProcessSandboxEngine({ ...sandboxOptionsFromEnv(process.env), production: false });
  const logged: { event: string; reason?: string }[] = [];
  const logger = {
    info: (o: { event: string }) => void logged.push(o),
    warn: (o: { event: string; reason?: string }) => void logged.push(o),
    child: () => logger,
  } as unknown as Logger;
  const limits = { timeoutMs: 20_000, memoryMb: 128 };

  type ScriptOptions = {
    allowedHosts?: string[];
    startUrl?: string;
    input?: unknown;
    pacer?: RequestPacer;
    maxRequests?: number;
    allowWriteActions?: boolean;
    logger?: Logger;
    classify?: (exchange: HttpExchange) => ExecFailure | null;
  };
  async function script(code: string, opts: ScriptOptions = {}): Promise<ScriptRunOutcome> {
    return withEgress(
      { mode: 'direct' },
      async (egress) => {
        const session = openNetworkSession({ rung: { mode: 'direct' }, guard, allowedHosts: opts.allowedHosts ?? [SPA] });
        try {
          return await runScriptExecutor({
            pool,
            egress,
            guard,
            session,
            engine,
            code,
            allowedHosts: opts.allowedHosts ?? [SPA],
            startUrl: opts.startUrl ?? `${base(SPA)}/`,
            input: opts.input ?? null,
            signal,
            logger: opts.logger ?? logger,
            limits,
            ...(opts.pacer === undefined ? {} : { pacer: opts.pacer }),
            ...(opts.maxRequests === undefined ? {} : { maxRequests: opts.maxRequests }),
            ...(opts.allowWriteActions === undefined ? {} : { allowWriteActions: opts.allowWriteActions }),
            ...(opts.classify === undefined ? {} : { classify: opts.classify }),
          });
        } finally {
          await session.close();
        }
      },
      { allowedHosts: opts.allowedHosts ?? [SPA] },
    );
  }

  test('SPA rendue par ctx.page (waitForSelector, evaluate) : 30 éléments conformes', async () => {
    const out = await script(`
      await ctx.page.waitForSelector('div.spa-item', { timeout: 10000 });
      const rows = await ctx.page.evaluate(() => Array.from(document.querySelectorAll('div.spa-item')).map((n) => n.textContent));
      for (const t of rows) {
        const m = /(.+) - ([0-9]+\\.[0-9]{2})/.exec(t);
        ctx.emit({ title: m[1].trim(), price: Number(m[2]) });
      }`);
    expect(out.violations).toEqual([]);
    expectConform(out.result, SCHEMA_PRODUCT, 30);
  }, 60_000);

  test('SSR par ctx.page.textAll et attrAll, API par ctx.fetch : sorties conformes', async () => {
    const ssr = await script(
      `const titles = await ctx.page.textAll('article.product h2.title a');
       const prices = await ctx.page.textAll('article.product span.price');
       const hrefs = await ctx.page.attrAll('article.product h2.title a', 'href');
       titles.forEach((t, i) => ctx.emit({ title: t.trim(), price: Number(prices[i].replace(/[^0-9,]/g, '').replace(',', '.')), sku: /zz_test_product_[0-9]+/.exec(hrefs[i])[0] }));`,
      { allowedHosts: [SSR], startUrl: `${base(SSR)}/` },
    );
    expect(ssr.violations).toEqual([]);
    expect(ssr.result.ok).toBe(true);
    if (ssr.result.ok) {
      expect(ssr.result.records.length).toBeGreaterThan(0);
      for (const r of ssr.result.records) expect(validateOutput(SCHEMA_PRODUCT, r)).toEqual({ ok: true });
    }
    const api = await script(`
      const res = await ctx.fetch(input.url);
      const data = await res.json();
      for (const it of data.items) ctx.emit({ title: it.title, price: it.price_cents, sku: String(it.id) });`,
      { input: { url: `${base(SPA)}/api/items.json` } },
    );
    expectConform(api.result, SCHEMA_PRODUCT, 30);
  }, 60_000);

  test.each([
    ['fetch attendu', `await ctx.page.evaluate((u) => fetch(u).then(() => 'ok', () => 'blocked'), INTERNAL_URL);`],
    ['fetch lâché', `await ctx.page.evaluate((u) => { fetch(u).catch(() => {}); return 1; }, INTERNAL_URL); await new Promise(() => {});`],
    ['image et sendBeacon', `await ctx.page.evaluate((u) => { new Image().src = u; navigator.sendBeacon(u, 'zz_test_exfil'); return 1; }, INTERNAL_URL); await new Promise(() => {});`],
    ['ctx.page.goto', `await ctx.page.goto(INTERNAL_URL);`],
  ])('assert_sandbox (ctx.page, D-29) : %s vers un domaine hors API → sandbox_violation, 0 requête, enfant tué en < 2 s', async (_name, body) => {
    logged.length = 0;
    const started = Date.now();
    const out = await script(`const INTERNAL_URL = input.url;\n${body}\nctx.emit({ title: 'jamais', price: 1 });`, {
      input: { url: `${base(INTERNAL)}/secret?zz_test_exfil=1` },
    });
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'code_error', detail: 'sandbox_violation' } });
    expect(out.violations.map((v) => v.reason)).toContain('domain_not_allowed');
    expect(out.violations.find((v) => v.reason === 'domain_not_allowed')?.detail).toBe(INTERNAL);
    expect(out.killed).toBe(true);
    expect(out.killLatencyMs ?? Number.POSITIVE_INFINITY).toBeLessThan(2_000);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(logged.some((l) => l.event === 'sandbox_violation' && l.reason === 'domain_not_allowed')).toBe(true);
    expect((await client.stats()).hosts[INTERNAL]?.total ?? 0).toBe(0);
    expect(pool.active()).toBe(0);
  }, 60_000);

  // Revue de 1.7 (INV6) : une navigation du cadre principal pendant un evaluate peut venir du code du script comme d'un défi
  // muet de la page ; la tentative reste une violation (journalisée, enfant tué, 0 requête : D-29), mais la classe est
  // celle d'une navigation non demandée (refus, aucune réparation), jamais code_error.
  test('assert_sandbox (ctx.page, D-29) : navigation de la page vers un domaine hors API pendant un evaluate → sandbox_violation journalisée, 0 requête, enfant tué en < 2 s ; classe blocked_by_protection (self_navigation), jamais de réparation', async () => {
    logged.length = 0;
    const started = Date.now();
    const out = await script(`const INTERNAL_URL = input.url;\nawait ctx.page.evaluate((u) => { location.href = u; return 1; }, INTERNAL_URL); await new Promise(() => {});\nctx.emit({ title: 'jamais', price: 1 });`, {
      input: { url: `${base(INTERNAL)}/secret?zz_test_exfil=1` },
    });
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'blocked_by_protection', detail: 'self_navigation' } });
    expect(failureRoute((out.result as { failure: ExecFailure }).failure.failure_class).agent).toBe(false);
    expect(out.violations.find((v) => v.reason === 'domain_not_allowed')?.detail).toBe(INTERNAL);
    expect(out.killed).toBe(true);
    expect(out.killLatencyMs ?? Number.POSITIVE_INFINITY).toBeLessThan(2_000);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(logged.some((l) => l.event === 'sandbox_violation' && l.reason === 'domain_not_allowed')).toBe(true);
    expect((await client.stats()).hosts[INTERNAL]?.total ?? 0).toBe(0);
    expect(pool.active()).toBe(0);
  }, 60_000);

  test('pont ctx.page en liste fermée : le script ne voit que les 8 opérations (objet gelé, aucune autre atteignable) ; l’hôte refuse toute opération hors liste (invalid_bridge_call, violation)', async () => {
    const out = await script(
      `await ctx.fetch('${base(SPA)}/api/items.json');
       const r = await (async () => { try { return await ctx.page.evaluate('1 + 1'); } catch (e) { return -1; } })();
       let other = 'absente';
       try { await ctx.page.route('**'); other = 'présente'; } catch (e) { other = e instanceof TypeError ? 'absente' : 'autre'; }
       try { ctx.page.route = () => 1; } catch (e) { /* objet gelé */ }
       ctx.emit({ title: Object.keys(ctx.page).join(',') + '|' + Object.isFrozen(ctx.page) + '|' + other + '|' + typeof ctx.page.route, price: r });`,
    );
    expectConform(out.result, SCHEMA_PRODUCT, 1);
    expect(out.result.ok && out.result.records[0]?.['title']).toBe(`${PAGE_OPERATIONS.join(',')}|true|absente|undefined`);
    const page = createPageBridge({ page: undefined as never, guard, allowedHosts: [SPA], maxResponseBytes: 1000, maxItems: 5, timeoutMs: 1000, watch: hostViolationWatch(), allowWriteActions: false });
    await expect(page(JSON.stringify({ op: 'route', args: {} }))).rejects.toMatchObject({ code: 'invalid_bridge_call', violation: true });
    await expect(page(JSON.stringify({ op: 'goto', args: { url: 'file:///etc/passwd' } }))).rejects.toMatchObject({ code: 'invalid_bridge_call', violation: true });
    await expect(page(JSON.stringify({ op: 'goto', args: { url: `${base(SSR)}/` } }))).rejects.toMatchObject({ code: 'domain_not_allowed', violation: true });
    expect(PAGE_OPERATIONS).toEqual(['goto', 'url', 'waitForSelector', 'content', 'textAll', 'attrAll', 'click', 'evaluate']);
    expect((await client.stats()).hosts[SSR]?.total ?? 0).toBe(0);
  }, 60_000);

  test('assert_domain_lock_redirects (E3 en script) : page de départ redirigée hors des domaines de l’API → code_error domain_not_allowed, non rejouable, script jamais lancé', async () => {
    const out = await script(`ctx.emit({ title: 'jamais', price: 1 });`, { allowedHosts: [SSRF], startUrl: `${base(SSRF)}/to-internal` });
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'code_error', retryable: false, detail: 'domain_not_allowed' } });
    expect(out.violations).toEqual([]);
    expect((await client.stats()).hosts[INTERNAL]?.total ?? 0).toBe(0);
  }, 60_000);

  test('ressources tierces du site (pixel, minuterie, défilement) : evaluate puis goto puis attente → ok, jamais imputées au script, 0 requête au tiers', async () => {
    const out = await script(
      `const first = await ctx.page.evaluate(() => { window.scrollTo(0, 50); return Array.from(document.querySelectorAll('div.spa-item')).map((n) => n.textContent); });
       await ctx.page.goto(input.second);
       // La page 2 relance sa minuterie de mesure d'audience pendant cette attente, code du script présent.
       const second = await ctx.page.evaluate(() => new Promise((r) => setTimeout(() => r(Array.from(document.querySelectorAll('div.spa-item')).map((n) => n.textContent)), 800)));
       await ctx.page.waitForSelector('div.spa-item');
       for (const t of [...first, ...second]) { const m = /(.+) - ([0-9]+\\.[0-9]{2})/.exec(t); ctx.emit({ title: m[1].trim(), price: Number(m[2]) }); }`,
      { startUrl: `${base(SPA)}/tiers`, input: { second: `${base(SPA)}/tiers?page=2` } },
    );
    expect(out.violations).toEqual([]);
    expect(out.killed).toBe(false);
    expectConform(out.result, SCHEMA_PRODUCT, 20);
    expect((await client.stats()).hosts[EVIL]?.total ?? 0).toBe(0);
  }, 60_000);

  // Revue de 1.7 : une navigation du cadre principal lancée HORS d'une opération (même par le code injecté, après la fin
  // de son evaluate) est coupée à l'émission, avant toute connexion : la redirection n'est même pas demandée au site.
  test('assert_sandbox (ctx.page, D-29) : navigation différée du code injecté (après son evaluate) vers une redirection hors API → coupée à l’émission (self_navigation), 0 requête au site comme au domaine hors API, enfant arrêté', async () => {
    const out = await script(`await ctx.page.evaluate((u) => { setTimeout(() => { location.href = u; }, 300); return 1; }, input.redirect); await new Promise(() => {});\nctx.emit({ title: 'jamais', price: 1 });`, {
      allowedHosts: [SPA, SSRF],
      input: { redirect: `${base(SSRF)}/to-internal` },
    });
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'blocked_by_protection', detail: 'self_navigation' } });
    expect(out.killed).toBe(true);
    expect(out.items).toEqual([]);
    expect((await client.stats()).hosts[SSRF]?.total ?? 0).toBe(0);
    expect((await client.stats()).hosts[INTERNAL]?.total ?? 0).toBe(0);
  }, 60_000);

  test.each([
    ['fetch différé qui suit une redirection', `await ctx.page.evaluate((u) => { setTimeout(() => { fetch(u, { mode: 'no-cors' }).catch(() => {}); }, 300); return 1; }, input.redirect); await new Promise(() => {});`],
  ])('assert_sandbox (ctx.page, D-29) : %s vers un domaine hors API → sandbox_violation, 0 requête, enfant tué en < 2 s', async (_name, body) => {
    const out = await script(`${body}\nctx.emit({ title: 'jamais', price: 1 });`, {
      allowedHosts: [SPA, SSRF],
      input: { redirect: `${base(SSRF)}/to-internal` },
    });
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'code_error', detail: 'sandbox_violation' } });
    expect(out.violations.find((v) => v.reason === 'domain_not_allowed')?.detail).toBe(INTERNAL);
    expect(out.killed).toBe(true);
    expect(out.killLatencyMs ?? Number.POSITIVE_INFINITY).toBeLessThan(2_000);
    expect((await client.stats()).hosts[INTERNAL]?.total ?? 0).toBe(0);
  }, 60_000);

  test('assert_sandbox (ctx.page, D-29) : WebRTC (STUN/UDP, TURN/TCP vers une IP littérale) et WebTransport → 0 paquet ni connexion reçus, TURN/TCP refusé au proxy d’egress → sandbox_violation', async () => {
    const udp = createSocket('udp4');
    let packets = 0;
    udp.on('message', () => void (packets += 1));
    await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', () => resolve()));
    let connections = 0;
    const tcp = createTcpServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', () => resolve()));
    try {
      const out = await script(
        `await ctx.page.evaluate((a) => {
           const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:' + a.udp }, { urls: 'turn:127.0.0.1:' + a.tcp + '?transport=tcp', username: 'zz_test', credential: 'zz_test' }] });
           pc.createDataChannel('zz_test');
           pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => {});
           try { new WebTransport('https://127.0.0.1:' + a.udp + '/zz_test').ready.catch(() => {}); } catch (e) { /* absent */ }
           return 1;
         }, input);
         // Attente hors evaluate (le bac à sable n'a pas de minuterie) : le guet reste armé, le code du script est dans la page.
         try { await ctx.page.waitForSelector('#zz_test_jamais', { timeout: 5000 }); } catch (e) { /* attendu */ }
         ctx.emit({ title: 'jamais', price: 1 });`,
        { input: { udp: (udp.address() as AddressInfo).port, tcp: (tcp.address() as AddressInfo).port } },
      );
      expect(packets).toBe(0);
      expect(connections).toBe(0);
      expect(out.result).toMatchObject({ ok: false, failure: { detail: 'sandbox_violation' } });
      expect(out.violations.find((v) => v.reason === 'domain_not_allowed')?.detail).toBe('127.0.0.1');
      expect(out.killed).toBe(true);
    } finally {
      udp.close();
      await new Promise<void>((resolve) => tcp.close(() => resolve()));
    }
  }, 60_000);

  test.each([
    [
      'clic de l’hôte',
      "await ctx.page.evaluate((u) => { setTimeout(() => { fetch(u).catch(() => {}); }, 300); return 1; }, input.url);\n" +
        "try { await ctx.page.click('#zz_test_absent', { timeout: 2000 }); } catch (e) { /* attendu */ }",
    ],
    [
      'navigation de l’hôte (goto lente)',
      "await ctx.page.evaluate((u) => { setInterval(() => { fetch(u).catch(() => {}); }, 50); return 1; }, input.url);\n" +
        'await ctx.page.goto(input.slow);',
    ],
    [
      'navigation dans le document (pushState, le code reste)',
      "await ctx.page.evaluate((u) => { history.pushState({}, '', '/zz_test_push'); setTimeout(() => { fetch(u).catch(() => {}); }, 300); return 1; }, input.url);\n" +
        "try { await ctx.page.waitForSelector('#zz_test_absent', { timeout: 2000 }); } catch (e) { /* attendu */ }",
    ],
    [
      // Avant tout evaluate (guet désarmé) : le saut hors API d'une navigation du script n'entre jamais dans la ligne de base.
      'ctx.page.goto vers une redirection ouverte avant tout evaluate',
      'try { await ctx.page.goto(input.redirect); } catch (e) { /* saut coupé */ }\nawait ctx.page.goto(input.spa);',
    ],
  ])('assert_sandbox (ctx.page, D-29) : blanchiment par %s (hôte hors API contacté pendant une opération de l’hôte, puis exfiltration par le code injecté) → sandbox_violation, enfant tué, 0 requête', async (_name, launder) => {
    const out = await script(
      launder +
        "\nawait ctx.page.evaluate((u) => fetch(u + '&zz_test_data=secret').then(() => 1, () => 0), input.url);\nctx.emit({ title: 'jamais', price: 1 });",
      {
        allowedHosts: [SPA, SLOW, SSRF],
        input: { url: `${base(INTERNAL)}/collect?zz_test_exfil=1`, slow: `${base(SLOW)}/data?wait_seconds=1`, redirect: `${base(SSRF)}/to-internal`, spa: `${base(SPA)}/` },
      },
    );
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'code_error', detail: 'sandbox_violation' } });
    expect(out.violations.find((v) => v.reason === 'domain_not_allowed')?.detail).toBe(INTERNAL);
    expect(out.killed).toBe(true);
    expect(out.killLatencyMs ?? Number.POSITIVE_INFINITY).toBeLessThan(2_000);
    expect((await client.stats()).hosts[INTERNAL]?.total ?? 0).toBe(0);
  }, 60_000);

  // Garde de classification de 1.7 PAR DÉFAUT (classifyExchange) : la page de défi générique, servie en 200, est reconnue par son contenu.
  test.each([
    ['ctx.page.goto en 403', 'await ctx.page.goto(input.forbidden);', { failure_class: 'forbidden', detail: 'http_403' }],
    ['ctx.fetch en 403', 'await ctx.fetch(input.forbidden);', { failure_class: 'forbidden', detail: 'http_403' }],
    ['ctx.fetch en 401', 'await ctx.fetch(input.login);', { failure_class: 'auth_required', detail: 'http_401' }],
    [
      'ctx.page.goto vers un défi servi en 200',
      "await ctx.page.goto(input.challenge);\nawait ctx.page.click('#zz-test-challenge input');",
      { failure_class: 'blocked_by_protection', detail: 'challenge_page' },
    ],
    [
      'clic qui mène à un défi servi en 200',
      "await ctx.page.evaluate((u) => { const a = document.createElement('a'); a.id = 'zz_test_go'; a.href = u; a.textContent = 'suite'; document.body.appendChild(a); return 1; }, input.challenge);\n" +
        "await ctx.page.click('#zz_test_go');\nconst html = await ctx.page.content();\nctx.emit({ title: html.slice(0, 50), price: 1 });\nawait ctx.page.click('#zz-test-challenge input');",
      { failure_class: 'blocked_by_protection', detail: 'challenge_page' },
    ],
  ])('assert_script_refusal_stops (INV6) : page 1 conforme, puis %s → échec avec la classe du refus, rien rendu au script, 0 requête après le refus, 0 élément', async (_name, refusal, expected) => {
    const out = await script(
      "await ctx.page.waitForSelector('div.spa-item', { timeout: 10000 });\n" +
        "for (const t of await ctx.page.textAll('div.spa-item')) { const m = /(.+) - ([0-9]+\\.[0-9]{2})/.exec(t); ctx.emit({ title: m[1].trim(), price: Number(m[2]) }); }\n" +
        refusal +
        "\nctx.emit({ title: 'après le refus', price: 1 });\nawait ctx.fetch(input.after);\nawait ctx.page.goto(input.after);",
      {
        allowedHosts: [SPA, SIGNED403, CHALLENGE_200, LOGIN],
        input: {
          forbidden: `${base(SIGNED403)}/plain-forbidden`,
          login: `${base(LOGIN)}/api/orders`,
          challenge: `${base(CHALLENGE_200)}/`,
          after: `${base(SPA)}/items/zz_test_after`,
        },
      },
    );
    expect(out.result).toMatchObject({ ok: false, failure: { ...expected, retryable: false } });
    expect(out.violations).toEqual([]);
    // Rien de la page refusée n'a été rendu au script : aucun élément émis après le refus.
    expect(out.items.length).toBeLessThanOrEqual(30);
    expect(out.items.every((i) => (i as { title?: string }).title !== 'après le refus' && !/Security check/.test((i as { title?: string }).title ?? ''))).toBe(true);
    expect((await client.stats()).hosts[SPA]?.paths['/items/zz_test_after'] ?? 0).toBe(0);
  }, 60_000);

  test.each([
    ['ctx.fetch', 'await ctx.fetch(input.challenge);'],
    ['ctx.page.goto', 'await ctx.page.goto(input.challenge);\nawait ctx.page.content();'],
  ])('assert_circuit_opens_on_refusals (E3 script) : un défi servi en 200 via %s est rapporté à la cadence avec sa classe (jamais « ok »)', async (_name, code) => {
    const reports: { url: string; status: number; failureClass: string | null }[] = [];
    const pacer: RequestPacer = {
      acquire: async () => ({ granted: true }),
      report: async (url, response) => void reports.push({ url, status: response.status, failureClass: response.failureClass ?? null }),
    };
    const out = await script(`${code}\nctx.emit({ title: 'jamais', price: 1 });`, {
      allowedHosts: [SPA, CHALLENGE_200],
      input: { challenge: `${base(CHALLENGE_200)}/` },
      pacer,
    });
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'blocked_by_protection', detail: 'challenge_page' } });
    const challenge = reports.filter((r) => r.url.startsWith(base(CHALLENGE_200)));
    expect(challenge).toHaveLength(1);
    expect(challenge[0]).toMatchObject({ status: 200, failureClass: 'blocked_by_protection' });
  }, 60_000);

  test.each([
    ['ctx.fetch', 'await ctx.fetch(input.account);'],
    ['ctx.page.goto', 'await ctx.page.goto(input.account);\nawait ctx.page.content();'],
  ])('redirection vers /login suivie par %s → auth_required (login_redirect), jamais code_error ni extraction', async (_name, code) => {
    const out = await script(`${code}\nctx.emit({ title: 'jamais', price: 1 });`, {
      allowedHosts: [SPA, LOGIN],
      input: { account: `${base(LOGIN)}/account` },
    });
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'auth_required', detail: 'login_redirect' } });
    expect(out.items).toEqual([]);
  }, 60_000);

  test('page de départ : défi qui se résout seul (rechargement immédiat) → blocked_by_protection, la page « franchie » n’est jamais servie', async () => {
    await client.control({ op: 'site', site: 'challenge_200', resolve_after_ms: 0 });
    const out = await script("ctx.emit({ title: (await ctx.page.textAll('h1.product'))[0] ?? 'aucun', price: 1 });", {
      allowedHosts: [CHALLENGE_200],
      startUrl: `${base(CHALLENGE_200)}/`,
    });
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'blocked_by_protection' } });
    expect(out.items).toEqual([]);
    expect((await client.stats()).hosts[CHALLENGE_200]?.paths['/']).toBe(1);
  }, 60_000);

  // Revue de 1.7 : même règle structurelle qu'en E2/E3 déclaratifs. Seule la navigation du cadre principal demandée par
  // l'hôte (page de départ, ctx.page.goto, clic du script : une par opération) ou lancée pendant un ctx.page.evaluate
  // part ; toute autre (rechargement d'un défi muet, redirection JS ou meta refresh, vers l'API ou hors API) arrête l'essai.
  const firstProduct = "ctx.emit({ title: (await ctx.page.textAll('h1.product'))[0] ?? 'aucun', price: 1 });";
  /** Le script attend le contenu « franchi » : sans la garde, il le lirait après le rechargement. */
  const waitProduct = "await ctx.page.waitForSelector('h1.product', { timeout: 3000 }).catch(() => null);\n";
  test.each([
    ['page de départ, rechargement immédiat', 'start', 0],
    ['page de départ, rechargement après 300 ms', 'start', 300],
    ['ctx.page.goto, rechargement immédiat', 'goto', 0],
    ['ctx.page.goto, rechargement après 300 ms', 'goto', 300],
  ])('assert_no_circumvention (E3 script) : défi JS silencieux servi en 200 (ni titre, ni phrase, ni widget ; cookie puis rechargement), %s → blocked_by_protection (self_navigation), 0 élément, la page « franchie » jamais servie', async (_name, how, delay) => {
    await client.control({ op: 'site', site: 'challenge_200', variant: 'silent' });
    await client.control({ op: 'site', site: 'challenge_200', resolve_after_ms: delay });
    const out =
      how === 'start'
        ? await script(`${waitProduct}${firstProduct}`, { allowedHosts: [CHALLENGE_200], startUrl: `${base(CHALLENGE_200)}/` })
        : await script(`await ctx.page.goto(input.challenge);\n${waitProduct}${firstProduct}`, { allowedHosts: [SPA, CHALLENGE_200], input: { challenge: `${base(CHALLENGE_200)}/` } });
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'blocked_by_protection', detail: 'self_navigation' } });
    expect(out.items).toEqual([]);
    expect(out.violations).toEqual([]);
    expect((await client.stats()).hosts[CHALLENGE_200]?.paths['/']).toBe(1);
  }, 60_000);

  // Revue de 1.7 : une navigation qui chevauche un ctx.page.evaluate (le script attend dans la page) ou l'attente du
  // sélecteur d'un clic n'est pas imputée au script : seule part la navigation de ctx.page.goto ou du dispatch d'un clic.
  test.each([
    ['evaluate qui attend dans la page (try/catch), rechargement immédiat', 'evaluate', 0],
    ['evaluate qui attend dans la page (try/catch), rechargement après 300 ms', 'evaluate', 300],
    ['clic qui attend son sélecteur, rechargement immédiat', 'click', 0],
    ['clic qui attend son sélecteur, rechargement après 300 ms', 'click', 300],
  ])('assert_no_circumvention (E3 script, revue de 1.7) : défi JS silencieux servi en 200, page de départ, %s → blocked_by_protection (self_navigation), 0 élément, la page « franchie » jamais servie', async (_name, how, delay) => {
    await client.control({ op: 'site', site: 'challenge_200', variant: 'silent' });
    await client.control({ op: 'site', site: 'challenge_200', resolve_after_ms: delay });
    const wait =
      how === 'evaluate'
        ? `try { await ctx.page.evaluate(() => new Promise((r) => setTimeout(() => r(1), 1500))); } catch (e) { /* attente */ }\n${waitProduct}`
        : "await ctx.page.click('h1.product', { timeoutMs: 3000 }).catch(() => null);\n";
    const out = await script(`${wait}${firstProduct}`, { allowedHosts: [CHALLENGE_200], startUrl: `${base(CHALLENGE_200)}/` });
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'blocked_by_protection', detail: 'self_navigation' } });
    expect(out.items).toEqual([]);
    expect(out.violations).toEqual([]);
    expect((await client.stats()).hosts[CHALLENGE_200]?.paths['/']).toBe(1);
  }, 60_000);

  test('limite assumée (INV6, revue de 1.7) : navigation lancée par le code d’un ctx.page.evaluate (location.href vers l’API) → blocked_by_protection (self_navigation), la cible jamais demandée ; naviguer passe par ctx.page.goto', async () => {
    const out = await script(`await ctx.page.evaluate((u) => { location.href = u; return 1; }, input.next).catch(() => null);\nawait ctx.page.waitForSelector('h1', { timeout: 3000 }).catch(() => null);\n${firstProduct}`, {
      allowedHosts: [SSR],
      startUrl: `${base(SSR)}/`,
      input: { next: `${base(SSR)}/zz_test_next` },
    });
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'blocked_by_protection', detail: 'self_navigation' } });
    expect(out.items).toEqual([]);
    expect((await client.stats()).hosts[SSR]?.paths['/zz_test_next'] ?? 0).toBe(0);
  }, 60_000);

  test('assert_no_circumvention (E3 script) : la page envoie le cadre principal vers un hôte hors API (éditeur de défi) → blocked_by_protection (self_navigation), 0 requête vers cet hôte', async () => {
    await client.control({ op: 'site', site: 'challenge_200', variant: 'offsite' });
    const out = await script(`${waitProduct}${firstProduct}`, { allowedHosts: [CHALLENGE_200], startUrl: `${base(CHALLENGE_200)}/` });
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'blocked_by_protection', detail: 'self_navigation' } });
    expect(out.items).toEqual([]);
    expect((await client.stats()).hosts[EVIL]?.total ?? 0).toBe(0);
  }, 60_000);

  test('assert_no_circumvention (E3 script, revue de 1.7) : défi muet qui envoie le cadre principal vers un hôte hors API PENDANT un ctx.page.evaluate → blocked_by_protection (self_navigation), jamais code_error ni réparation ; violation journalisée, enfant tué, 0 requête vers cet hôte', async () => {
    await client.control({ op: 'site', site: 'challenge_200', variant: 'offsite' });
    await client.control({ op: 'site', site: 'challenge_200', resolve_after_ms: 1_000 });
    logged.length = 0;
    const out = await script(`await ctx.page.evaluate(() => new Promise((r) => setTimeout(() => r(1), 5000))).catch(() => null);\n${waitProduct}${firstProduct}`, {
      allowedHosts: [CHALLENGE_200],
      startUrl: `${base(CHALLENGE_200)}/`,
    });
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'blocked_by_protection', detail: 'self_navigation' } });
    expect(failureRoute((out.result as { failure: ExecFailure }).failure.failure_class).agent).toBe(false);
    // La navigation est bien partie PENDANT l'evaluate : imputée au guet (violation journalisée, D-29), enfant tué.
    expect(out.violations.find((v) => v.reason === 'domain_not_allowed')?.detail).toBe(EVIL);
    expect(logged.some((l) => l.event === 'sandbox_violation' && l.reason === 'domain_not_allowed')).toBe(true);
    expect(out.killed).toBe(true);
    expect(out.items).toEqual([]);
    expect((await client.stats()).hosts[EVIL]?.total ?? 0).toBe(0);
  }, 60_000);

  test('assert_no_circumvention (E3 script) : en-tête de défi, corps lent qui réécrit le document puis recharge pendant ctx.page.goto → refus d’en-tête retenu dès la réponse (challenge_header), rechargement jamais parti', async () => {
    await client.control({ op: 'site', site: 'challenge_200', variant: 'slow_header' });
    const out = await script(`await ctx.page.goto(input.challenge);\n${firstProduct}`, { allowedHosts: [SPA, CHALLENGE_200], input: { challenge: `${base(CHALLENGE_200)}/` } });
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'blocked_by_protection', detail: 'challenge_header' } });
    expect(out.items).toEqual([]);
    expect((await client.stats()).hosts[CHALLENGE_200]?.paths['/']).toBe(1);
  }, 60_000);

  test('limite assumée (INV6, revue de 1.7) : page SAINE déplacée par meta refresh (E3 script) → blocked_by_protection (self_navigation), la cible du refresh jamais demandée', async () => {
    const out = await script(firstProduct, { allowedHosts: [SSR], startUrl: `${base(SSR)}/moved` });
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'blocked_by_protection', detail: 'self_navigation' } });
    const paths = (await client.stats()).hosts[SSR]?.paths ?? {};
    expect(paths['/moved']).toBe(1);
    expect(paths['/'] ?? 0).toBe(0);
  }, 60_000);

  test('assert_script_paced (1.9) : chaque ctx.fetch et ctx.page.goto réservent un créneau (écart ≥ min_delay_ms) ; un 429 arrête l’essai (rate_limited) et son Retry-After allonge la cadence du run suivant', async () => {
    await client.control({ op: 'site', site: '429', retry_after: 1, limit: 100 });
    const inner = domainRequestPacer(new DomainPacer(memoryPacingStore()), { minDelayMs: 300, maxWaitMs: 20_000 });
    const grants: { url: string; at: number }[] = [];
    const reports: number[] = [];
    const pacer: RequestPacer = {
      acquire: async (url) => {
        const slot = await inner.acquire(url);
        if (slot.granted) grants.push({ url, at: Date.now() });
        return slot;
      },
      report: async (url, response) => {
        reports.push(response.status);
        await inner.report(url, response);
      },
    };
    const opts = { allowedHosts: [LIMITED], startUrl: `${base(LIMITED)}/`, input: { base: base(LIMITED) }, pacer };
    const out = await script(
      `for (const path of ['/', '/']) await ctx.fetch(input.base + path);
       await ctx.page.goto(input.base + '/');
       ctx.emit({ title: 'avant', price: 1 });
       await ctx.fetch(input.base + '/always');
       await ctx.fetch(input.base + '/');
       ctx.emit({ title: 'jamais', price: 1 });`,
      opts,
    );
    expect(out.violations).toEqual([]);
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'rate_limited', retryable: true, detail: 'http_429' } });
    // Page de départ, 2 ctx.fetch, ctx.page.goto, ctx.fetch en 429 : 5 créneaux, 5 comptes rendus ; rien après le 429.
    expect(grants).toHaveLength(5);
    expect(reports).toEqual([200, 200, 200, 200, 429]);
    const gaps = grants.slice(1).map((g, i) => g.at - grants[i]!.at);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(290);
    // Run suivant sur le domaine : sa page de départ attend le Retry-After (1 s) du 429.
    const next = await script(`ctx.emit({ title: 'après', price: 1 });`, opts);
    expectConform(next.result, SCHEMA_PRODUCT, 1);
    expect(grants).toHaveLength(6);
    expect(grants[5]!.at - grants[4]!.at).toBeGreaterThanOrEqual(990);
  }, 60_000);

  test('assert_script_paced (max_requests_per_run) : ctx.fetch et ctx.page partagent le plafond ; au-delà, refus sans violation (request_cap), sortie tronquée', async () => {
    const out = await script(
      `let ok = 0; let refused = '';
       for (let i = 0; i < 5; i++) { try { await ctx.fetch(input.url); ok++; } catch (e) { refused = e.message; } }
       try { await ctx.page.goto(input.page); } catch (e) { refused += '|' + e.message; }
       ctx.emit({ title: ok + ':' + refused, price: 1 });`,
      { input: { url: `${base(SPA)}/api/items.json`, page: `${base(SPA)}/items/2` }, maxRequests: 3 },
    );
    expect(out.violations).toEqual([]);
    expect(out.result).toMatchObject({ ok: true, truncated: true, stop: 'max_requests_per_run', requests: 3 });
    // Page de départ (et son app.js non comptée, XHR /api/items.json comptée) : le plafond tombe au premier ctx.fetch.
    expect(out.result.ok && out.result.records[0]?.['title']).toMatch(/^[0-2]:request_cap\|page_failed$/);
    const paths = (await client.stats()).hosts[SPA]?.paths ?? {};
    expect((paths['/'] ?? 0) + (paths['/api/items.json'] ?? 0) + (paths['/items/2'] ?? 0)).toBeLessThanOrEqual(3);
  }, 60_000);

  test.each([
    ['clic sur un bouton d’envoi', `document.body.innerHTML = '<form method="post" action="/zz_test_write"><input name="q" value="1"><button id="b">Envoyer</button></form>'; return 1;`, `await ctx.page.click('#b');`],
    ['soumission par le code injecté', `document.body.innerHTML = '<form id="f" method="post" action="/zz_test_write"><input name="q" value="1"></form>'; setTimeout(() => document.getElementById('f').submit(), 100); return 1;`, `await new Promise(() => {});`],
  ])('assert_write_action_blocked (08 §4, sans allow_write_actions) : %s → write_action_blocked (violation), 0 requête POST reçue', async (_name, setup, act) => {
    const out = await script(`await ctx.page.evaluate(() => { ${setup} }); ${act}\nctx.emit({ title: 'jamais', price: 1 });`);
    expect(out.result).toMatchObject({ ok: false, failure: { detail: 'sandbox_violation' } });
    expect(out.violations.map((v) => v.reason)).toContain('write_action_blocked');
    expect(out.killed).toBe(true);
    expect((await client.stats()).hosts[SPA]?.paths['/zz_test_write'] ?? 0).toBe(0);
  }, 60_000);

  test('assert_write_action_blocked (témoin) : avec allow_write_actions, le clic d’envoi part (témoin)', async () => {
    const out = await script(
      `await ctx.page.evaluate(() => { document.body.innerHTML = '<form method="post" action="/zz_test_write"><button id="b">Envoyer</button></form>'; });
       await ctx.page.click('#b');
       await ctx.page.waitForSelector('body');
       ctx.emit({ title: 'envoyé', price: 1 });`,
      { allowWriteActions: true },
    );
    expect(out.violations).toEqual([]);
    expect(out.result.ok).toBe(true);
    expect((await client.stats()).hosts[SPA]?.paths['/zz_test_write'] ?? 0).toBe(1);
  }, 60_000);

  test('assert_no_personal_data_in_logs (E3 en script) : ctx.log de données extraites → jamais dans le journal du worker, gardé en mémoire pour l’essai', async () => {
    const lines: string[] = [];
    const capture = {
      info: (o: unknown) => void lines.push(JSON.stringify(o)),
      warn: (o: unknown) => void lines.push(JSON.stringify(o)),
      error: (o: unknown) => void lines.push(JSON.stringify(o)),
      debug: (o: unknown) => void lines.push(JSON.stringify(o)),
      child: () => capture,
    } as unknown as Logger;
    const out = await script(
      `const names = await ctx.page.textAll('tr.person td.name');
       const emails = await ctx.page.textAll('tr.person td.email');
       const phones = await ctx.page.textAll('tr.person td.phone');
       ctx.log('premier contact', names[0], emails[0], phones[0]);
       ctx.emit({ title: 'n' + names.length, price: 1 });`,
      { allowedHosts: [PERSONAL], startUrl: `${base(PERSONAL)}/`, logger: capture },
    );
    expect(out.result.ok).toBe(true);
    expect(out.logs).toHaveLength(1);
    expect(out.logs[0]?.[2]).toBe('zz_test_person_001@example.invalid');
    const text = lines.join('\n');
    for (const motif of ['zz_test_person_001', 'example.invalid', 'Zztest001', '+33 1 99']) expect(text).not.toContain(motif);
    expect(text).toContain('sandbox_log');
  }, 60_000);

});

test('recyclage réel : un Chromium neuf après N runs, l’ancien fermé', async () => {
  const local: BrowserPoolEvent[] = [];
  const recycled = new BrowserPool({ size: 1, launch: playwrightLauncher(launchProxy.url, process.env), recycleAfterRuns: 1, onEvent: (e) => local.push(e) });
  try {
    const versions: string[] = [];
    let first: Browser | undefined;
    await recycled.run(signal, async (browser) => {
      first = browser;
      versions.push(browser.version());
    });
    await recycled.run(signal, async (browser) => {
      expect(browser).not.toBe(first);
      versions.push(browser.version());
    });
    expect(first?.isConnected()).toBe(false);
    expect(local.filter((e) => e.kind === 'launch')).toHaveLength(2);
    expect(versions[0]).toMatch(/^153\./);
  } finally {
    await recycled.close();
  }
}, 60_000);

describe('assert_no_circumvention (Chromium, tâche 1.7) : garde de classification PAR DÉFAUT avant extraction, E2 et E3', () => {
  /** Stratégie qui SAIT extraire la page de défi (titre `h1`) : sans la garde, l'essai « réussirait ». */
  const heading = (host: string, path = '/'): DeclarativeSpec =>
    valid(
      {
        schema_version: 1,
        kind: 'declarative',
        request: { method: 'GET', url: `${base(host)}${path}`, allowed_hosts: [host] },
        sources: [{ id: 'dom', from: 'html', records: 'h1' }],
        fields: { name: { attr: 'text', type: 'string', required: true } },
      },
      { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    );
  const e3 = (spec: DeclarativeSpec) => withEgress({ mode: 'direct' }, (egress) => runPlaywrightExecutor({ pool, egress, guard, spec, input: {}, signal }), { allowedHosts: spec.request.allowed_hosts });
  const e2 = (spec: DeclarativeSpec) => withEgress({ mode: 'direct' }, (egress) => runFetchInPageExecutor({ pool, egress, guard, spec, input: {}, signal }), { allowedHosts: spec.request.allowed_hosts });

  test('E3 : défi servi en 200 (DOM rendu) → blocked_by_protection, rien d’extrait, aucune requête de plus', async () => {
    const out = await e3(heading(CHALLENGE_200));
    expect(out).toMatchObject({ ok: false, requests: 1, pages: 0, failure: { failure_class: 'blocked_by_protection', detail: 'challenge_page' } });
    expect((await client.stats()).hosts[CHALLENGE_200]?.paths['/']).toBe(1);
  }, 60_000);

  /** Stratégie qui vise la page de contenu servie APRÈS le défi (titres `h1.product`) : elle ne réussit que si le défi a été franchi. */
  const products = (): DeclarativeSpec => {
    const spec = heading(CHALLENGE_200);
    return { ...spec, sources: [{ ...spec.sources[0]!, records: 'h1.product' }] } as DeclarativeSpec;
  };

  test.each([
    ['après 300 ms', 300],
    ['immédiatement', 0],
  ])('E3 : défi servi en 200 qui se résout seul en JS (%s) → blocked_by_protection AVANT toute attente du rendu, 0 élément, la page « franchie » jamais servie', async (_name, delay) => {
    await client.control({ op: 'site', site: 'challenge_200', resolve_after_ms: delay });
    const out = await e3(products());
    expect(out).toMatchObject({ ok: false, pages: 0, failure: { failure_class: 'blocked_by_protection' } });
    expect((await client.stats()).hosts[CHALLENGE_200]?.paths['/']).toBe(1);
  }, 60_000);

  test('E3 : navigation du cadre principal lancée par la page pendant l’attente du rendu → refusée, blocked_by_protection (self_navigation) ; le classifieur fourni sert aussi avant le rendu', async () => {
    await client.control({ op: 'site', site: 'challenge_200', resolve_after_ms: 300 });
    // Classifieur qui ne lit que le statut : le corps brut passe, seule la garde de navigation peut arrêter l'essai.
    const statusOnly = (exchange: HttpExchange): ExecFailure | null => (exchange.status >= 200 && exchange.status < 300 ? null : { failure_class: 'forbidden', retryable: false, detail: `http_${exchange.status}` });
    const spec = products();
    const out = await withEgress({ mode: 'direct' }, (egress) => runPlaywrightExecutor({ pool, egress, guard, spec, input: {}, signal, classify: statusOnly }), { allowedHosts: spec.request.allowed_hosts });
    expect(out).toMatchObject({ ok: false, pages: 0, failure: { failure_class: 'blocked_by_protection', detail: 'self_navigation' } });
    expect((await client.stats()).hosts[CHALLENGE_200]?.paths['/']).toBe(1);
  }, 60_000);

  test('E3 : défi JS silencieux servi en 200 (ni titre, ni phrase, ni widget ; cookie puis rechargement) → blocked_by_protection (self_navigation), 0 élément, la page « franchie » jamais servie', async () => {
    await client.control({ op: 'site', site: 'challenge_200', variant: 'silent' });
    const out = await e3(products());
    expect(out).toMatchObject({ ok: false, pages: 0, failure: { failure_class: 'blocked_by_protection', detail: 'self_navigation' } });
    expect((await client.stats()).hosts[CHALLENGE_200]?.paths['/']).toBe(1);
  }, 60_000);

  test('E3 : navigation lancée par la page vers un hôte hors API (éditeur de défi) → blocked_by_protection (self_navigation), 0 requête vers cet hôte, jamais extraction ni code_error', async () => {
    await client.control({ op: 'site', site: 'challenge_200', variant: 'offsite' });
    const out = await e3(products());
    expect(out).toMatchObject({ ok: false, pages: 0, failure: { failure_class: 'blocked_by_protection', detail: 'self_navigation' } });
    expect((await client.stats()).hosts[EVIL]?.total ?? 0).toBe(0);
  }, 60_000);

  test('E3 : défi compressé (gzip) qui réécrit aussitôt son document → reconnu sur son corps brut DÉCODÉ (taille décodée connue par CDP avant lecture) : blocked_by_protection (challenge_page)', async () => {
    await client.control({ op: 'site', site: 'challenge_200', variant: 'gzip_rewrite' });
    const out = await e3(products());
    expect(out).toMatchObject({ ok: false, pages: 0, failure: { failure_class: 'blocked_by_protection', detail: 'challenge_page' } });
  }, 60_000);

  test('limite assumée (INV6, revue de 1.7) : page SAINE déplacée par meta refresh (redirection de langue, URL canonique) → blocked_by_protection (self_navigation) en E3, la cible du refresh jamais demandée', async () => {
    const spec = valid(
      {
        schema_version: 1,
        kind: 'declarative',
        request: { method: 'GET', url: `${base(SSR)}/moved`, allowed_hosts: [SSR] },
        sources: [{ id: 'dom', from: 'html', records: 'article.product' }],
        fields: { name: { css: 'h2.title', attr: 'text', type: 'string', required: true } },
      },
      { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    );
    const out = await e3(spec);
    expect(out).toMatchObject({ ok: false, pages: 0, failure: { failure_class: 'blocked_by_protection', detail: 'self_navigation' } });
    const paths = (await client.stats()).hosts[SSR]?.paths ?? {};
    expect(paths['/moved']).toBe(1);
    expect(paths['/'] ?? 0).toBe(0);
  }, 60_000);

  test('E2 : page d’accueil en défi qui se résout seul (rechargement immédiat) → blocked_by_protection, aucune requête de données', async () => {
    await client.control({ op: 'site', site: 'challenge_200', resolve_after_ms: 0 });
    const spec = valid(
      {
        schema_version: 1,
        kind: 'declarative',
        request: { method: 'GET', url: `${base(CHALLENGE_200)}/api/items`, allowed_hosts: [CHALLENGE_200] },
        sources: [{ id: 'api', from: 'response', records: '$.items[*]' }],
        fields: { name: { path: '$.name', type: 'string', required: true } },
      },
      { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    );
    const out = await e2(spec);
    expect(out).toMatchObject({ ok: false, pages: 0, failure: { failure_class: 'blocked_by_protection' } });
    const paths = (await client.stats()).hosts[CHALLENGE_200]?.paths ?? {};
    expect(paths['/']).toBe(1);
    expect(paths['/api/items'] ?? 0).toBe(0);
  }, 60_000);

  test('E3 : 403 signé → blocked_by_protection ; 403 nu → forbidden ; redirection vers /login → auth_required ; jamais network', async () => {
    const cases: [DeclarativeSpec, string, string][] = [
      [heading(SIGNED403), 'blocked_by_protection', 'protection_signature'],
      [heading(SIGNED403, '/plain-forbidden'), 'forbidden', 'http_403'],
      [heading(LOGIN, '/account'), 'auth_required', 'login_redirect'],
    ];
    for (const [spec, cls, detail] of cases) {
      const out = await e3(spec);
      expect(out, cls).toMatchObject({ ok: false, pages: 0, failure: { failure_class: cls, detail } });
    }
  }, 90_000);

  test('E2 : page d’accueil en défi servi en 200 → blocked_by_protection avant toute requête de données', async () => {
    const spec = valid(
      {
        schema_version: 1,
        kind: 'declarative',
        request: { method: 'GET', url: `${base(CHALLENGE_200)}/api/items`, allowed_hosts: [CHALLENGE_200] },
        sources: [{ id: 'api', from: 'response', records: '$.items[*]' }],
        fields: { name: { path: '$.name', type: 'string', required: true } },
      },
      { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    );
    const out = await e2(spec);
    expect(out).toMatchObject({ ok: false, pages: 0, failure: { failure_class: 'blocked_by_protection', detail: 'challenge_page' } });
    expect((await client.stats()).hosts[CHALLENGE_200]?.paths['/api/items'] ?? 0).toBe(0);
  }, 60_000);
});
