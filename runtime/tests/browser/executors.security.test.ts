// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.6, livrable vérifiable (10-taches) : « Chaque exécuteur produit une sortie conforme sur les fixtures API,
// SSR et SPA. Chromium à vide : 0 requête sortante. » Étage S (seul job qui installe Chromium) : vrai Chromium 153
// (Playwright 1.63) lancé par le pool du worker, proxy de lancement fermé, proxy d'egress par essai (garde SSRF),
// chaînage au proxy BYO (CONNECT, SOCKS5), politique de domaines en seconde couche, `request.newContext` avec proxy.
import { request as playwrightRequest, type Browser } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { BrowserPool, playwrightLauncher, type BrowserPoolEvent } from '../../apps/worker/src/browser/pool.ts';
import { newEgressRequestContext, openRunContext } from '../../apps/worker/src/browser/run-context.ts';
import { runFetchInPageExecutor, runPlaywrightExecutor } from '../../apps/worker/src/exec/browser-executors.ts';
import { BridgeError, createScriptBridges } from '../../apps/worker/src/exec/script.ts';
import { startClient, type Client } from '../../fixtures/src/test-helpers.ts';
// Paquets construits, comme le worker : mêmes classes (erreurs de garde, DslError) des deux côtés.
import { Secret, validateDeclarativeSpec, validateOutput, type DeclarativeSpec } from '@runtime/core';
import { runFetchExecutor, type DeclarativeRunResult } from '@runtime/core/exec';
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
import { startConnectProxy, startSocks5Proxy, type UpstreamTestProxy } from '../helpers/upstream-proxies.ts';

const API = 'zz_test_api_json.localhost';
const SSR = 'zz_test_ssr.localhost';
const SPA = 'zz_test_spa.localhost';
const SLOW = 'zz_test_slow.localhost';
const HOSTS = [API, SSR, SPA, SLOW];

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

test('E3 en script : ponts du bac à sable en liste fermée, domaines de l’API seulement, valeurs en JSON', async () => {
  await pool.run(signal, (browser) =>
    withEgress({ mode: 'direct' }, async (egress) => {
      const rc = await openRunContext(browser, { egressServer: egress.server, allowedHosts: [SPA] });
      const session = openNetworkSession({ rung: { mode: 'direct' }, guard });
      try {
        const set = createScriptBridges({ page: rc.page, guard, allowedHosts: [SPA], session, maxItems: 5, maxResponseBytes: 1_000_000 });
        expect(Object.keys(set.bridges).sort()).toEqual(['emit', 'fetch', 'log', 'page.content', 'page.goto', 'page.textAll', 'page.waitForSelector']);
        expect(JSON.parse(await set.bridges['page.goto']!(JSON.stringify({ url: `${base(SPA)}/` })))).toEqual({ status: 200 });
        await set.bridges['page.waitForSelector']!(JSON.stringify({ selector: 'div.spa-item', timeoutMs: 10_000 }));
        const { texts } = JSON.parse(await set.bridges['page.textAll']!(JSON.stringify({ selector: 'div.spa-item' }))) as { texts: string[] };
        expect(texts).toHaveLength(5);
        const fetched = JSON.parse(await set.bridges['fetch']!(JSON.stringify({ url: `${base(SPA)}/api/items.json` }))) as { status: number };
        expect(fetched.status).toBe(200);
        await set.bridges['emit']!(JSON.stringify({ item: { title: 'zz', price: 1 } }));
        expect(set.items).toEqual([{ title: 'zz', price: 1 }]);
        // Hors des domaines de l'API : refus avant toute requête.
        await expect(set.bridges['fetch']!(JSON.stringify({ url: `${base(SSR)}/` }))).rejects.toBeInstanceOf(BridgeError);
        await expect(set.bridges['page.goto']!(JSON.stringify({ url: `${base(SSR)}/` }))).rejects.toBeInstanceOf(BridgeError);
        await expect(set.bridges['page.goto']!(JSON.stringify({ url: 'file:///etc/passwd' }))).rejects.toBeInstanceOf(BridgeError);
        await expect(set.bridges['emit']!('[1]')).rejects.toBeInstanceOf(BridgeError);
        await expect(set.bridges['log']!('x'.repeat(70_000))).rejects.toBeInstanceOf(BridgeError);
      } finally {
        await session.close();
        await rc.close();
      }
    }),
  );
  expect((await client.stats()).hosts[SSR]?.total ?? 0).toBe(0);
}, 60_000);

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
