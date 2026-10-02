// SPDX-License-Identifier: AGPL-3.0-only
// assert_cdp_client_compat (BINV8, 04f § 9 F3 à F5 ; tâche 2.3) de bout en bout sur un vrai Chromium 153 :
//   client → relais WSS de la passerelle (jeton court) → relais du nœud (NODE_TOKEN, réécritures CDP) → Chromium dedicated
//   du pool (1.1, 1.4), lancé sur l'egress de sa session (1.5) ; destination : site de test de la tâche 0.5.
// Clients : Playwright `connectOverCDP` (jeton en query, puis en `Authorization: Bearer`, F4), Playwright `connect` natif
// (client 1.63, contrôle de version), client CDP brut au sens de Puppeteer `connect({browserWSEndpoint})` (Puppeteer n'est
// pas au catalogue du dépôt), Stagehand `cdpUrl` (mode LOCAL, sans LLM ni API distante).
// Réécritures (04f § 4) : un contexte créé avec le `proxyServer` d'un tiers sort quand même par l'egress (0 connexion vers le
// tiers) ; `Browser.close` libère la session. La déconnexion d'un client laisse la session vivante.
// Prérequis : utilisateur non root (bac à sable de Chromium), `playwright install chromium`. Sécurité : Chromium est arrêté
// par le pool (groupe de processus enregistré à son lancement), jamais par un signal à un autre pid.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Stagehand } from '@browserbasehq/stagehand';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import Fastify, { type FastifyInstance } from 'fastify';
import { createConnectTokens } from '../packages/core/src/index.ts';
import { ApiProblem } from '../apps/gateway/src/api/errors.ts';
import { registerRelay } from '../apps/gateway/src/relay/index.ts';
import { dedicatedLauncher, sessionDir } from '../apps/node/src/dedicated/index.ts';
import { createEgressGuard, startSessionEgress, type EgressTarget, type SessionEgress } from '../apps/node/src/egress/index.ts';
import { BrowserPool, OwnedProcessGroups, PROVISIONAL_CAPACITY, type PoolLease } from '../apps/node/src/pool/index.ts';
import { createNodeRelay } from '../apps/node/src/relay/index.ts';
import { startCountingRelay, startSink, type CountingRelay, type Sink } from '../apps/node/src/testing/egress-fixtures.ts';
import { startSite, type SiteHandle } from '../fixtures/src/site.ts';

const NODE_TOKEN = randomBytes(24).toString('base64url');
const SESSION = '6f1c0a52-3d1e-4c0b-9a52-2f0d9d7c1b11';
const tokens = createConnectTokens(randomBytes(32));

let site: SiteHandle;
let siteA: CountingRelay;
let trap: Sink;
let egress: SessionEgress;
const egressRequests: EgressTarget[] = [];
let dataDir: string;
let pool: BrowserPool;
let lease: PoolLease;
let released = 0;
let nodeServer: Server;
let gateway: FastifyInstance;
let gatewayBase: string;

beforeAll(async () => {
  site = await startSite({ host: '127.0.0.1' });
  siteA = await startCountingRelay(site.port);
  trap = await startSink();
  egress = await startSessionEgress(
    { allowedHosts: ['site-a.test'], ports: [siteA.port] },
    {
      guard: createEgressGuard({ privateHosts: ['site-a.test'], resolver: async (host) => (host === 'site-a.test' ? [{ address: '127.0.0.1', family: 4 as const }] : Promise.reject(new Error('ENOTFOUND'))) }),
      onRequest: (target) => egressRequests.push(target),
    },
  );
  dataDir = await mkdtemp(join(tmpdir(), 'zz_symb_compat_'));
  const groups = new OwnedProcessGroups();
  const launch = dedicatedLauncher({ dataDir, launchProxyUrl: egress.url, groups });
  pool = new BrowserPool({ slotsTotal: 2, launch, launchDedicated: launch, warmBrowsers: 0, constants: PROVISIONAL_CAPACITY, sweepIntervalMs: 0 });
  await pool.start();
  lease = await pool.acquire({ sessionId: SESSION, type: 'dedicated', tenantId: 't1' });

  // Nœud : relais interne sur l'annuaire d'une session.
  const nodeRelay = createNodeRelay({
    nodeToken: NODE_TOKEN,
    sessions: {
      get: (id) =>
        id === SESSION && !lease.signal.aborted && released === 0
          ? {
              type: 'dedicated',
              playwright: lease.wsEndpoint,
              cdp: lease.cdpEndpoint ?? null,
              egressProxyUrl: egress.url,
              downloadsDir: sessionDir(dataDir, SESSION).downloads,
              release: async () => {
                released += 1;
                await lease.release();
              },
            }
          : undefined,
    },
  });
  nodeServer = createServer((_req, res) => res.writeHead(404).end());
  nodeServer.on('upgrade', (req, socket, head) => {
    if (!nodeRelay.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => nodeServer.listen(0, '127.0.0.1', resolve));
  const nodeUrl = `http://127.0.0.1:${(nodeServer.address() as AddressInfo).port}`;

  // Passerelle : relais public ; le résolveur vérifie le jeton court (session et protocole) et route vers le nœud.
  gateway = Fastify({ logger: false });
  await registerRelay(gateway, {
    nodeToken: NODE_TOKEN,
    resolver: {
      async authorize({ sessionId, protocol, secret }) {
        const check = secret === null ? undefined : tokens.verify(secret);
        if (!check?.ok || check.sessionId !== sessionId || check.protocol !== protocol) return { ok: false, problem: new ApiProblem('unauthorized', 'Invalid connect token.') };
        return { ok: true, nodeUrl, sessionId };
      },
    },
  });
  await gateway.listen({ host: '127.0.0.1', port: 0 });
  gatewayBase = `ws://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await gateway?.close();
  if (nodeServer) await new Promise<void>((resolve) => nodeServer.close(() => resolve()));
  await pool?.close();
  await egress?.close();
  await trap?.close();
  await siteA?.close();
  await site?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}, 120_000);

const cdpUrl = (query = true) => `${gatewayBase}/v1/sessions/${SESSION}/cdp${query ? `?token=${tokens.issue({ sessionId: SESSION, protocol: 'cdp', ttlSeconds: 300 })}` : ''}`;
const siteUrl = (path = '/') => `http://site-a.test:${siteA.port}${path}`;
const alive = (): boolean => !lease.signal.aborted && released === 0;

/** Client CDP brut (forme de Puppeteer `connect({browserWSEndpoint})`) : commandes numérotées, réponses attendues. */
async function rawCdp(url: string) {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  let id = 0;
  const pending = new Map<number, (message: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString()) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
    if (message.id !== undefined) pending.get(message.id)?.(message);
  });
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      id += 1;
      pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result ?? {})));
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { ws, send, close: () => new Promise<void>((resolve) => (ws.once('close', () => resolve()), ws.close())) };
}

describe('assert_cdp_client_compat (BINV8) sur vrai Chromium, au travers des deux relais', () => {
  test('F3 : Playwright connectOverCDP ouvre la fixture, lit le titre, clique, évalue, se déconnecte ; la session reste vivante', async () => {
    const browser = await chromium.connectOverCDP(cdpUrl());
    const context = browser.contexts()[0];
    expect(context).toBeDefined();
    const page = await context!.newPage();
    await page.goto(siteUrl('/'));
    expect(await page.title()).toBe('SYM Browser fixtures');
    await page.click('a[href="/static/about.html"]');
    await page.waitForURL(/about\.html$/);
    expect(await page.title()).toBe('À propos');
    expect(await page.evaluate(() => 6 * 7)).toBe(42);
    await page.close();
    await browser.close();
    expect(alive()).toBe(true);
    expect(egressRequests.some((r) => r.host === 'site-a.test')).toBe(true);
  });

  test('F4 : URL sans query, jeton en Authorization: Bearer (option headers) ; jeton d’un autre protocole refusé', async () => {
    const bearer = tokens.issue({ sessionId: SESSION, protocol: 'cdp', ttlSeconds: 300 });
    const browser = await chromium.connectOverCDP(cdpUrl(false), { headers: { Authorization: `Bearer ${bearer}` } });
    expect(browser.contexts()).toHaveLength(1);
    await browser.close();
    const wrong = tokens.issue({ sessionId: SESSION, protocol: 'playwright', ttlSeconds: 300 });
    await expect(chromium.connectOverCDP(cdpUrl(false), { headers: { Authorization: `Bearer ${wrong}` }, timeout: 10_000 })).rejects.toThrow(/401/);
    expect(alive()).toBe(true);
  });

  test('Playwright connect natif (client 1.63, contrôle de version de la passerelle) : connecté, puis déconnecté sans libérer', async () => {
    const token = tokens.issue({ sessionId: SESSION, protocol: 'playwright', ttlSeconds: 300 });
    const browser = await chromium.connect(`${gatewayBase}/v1/sessions/${SESSION}/playwright?token=${token}`);
    expect(browser.version()).toMatch(/^153\./);
    await browser.close();
    expect(alive()).toBe(true);
  });

  test('client CDP brut (Puppeteer browserWSEndpoint) : cible créée, attachée en mode flatten, titre évalué', async () => {
    const cdp = await rawCdp(cdpUrl());
    const { targetId } = (await cdp.send('Target.createTarget', { url: siteUrl('/static/about.html') })) as { targetId: string };
    const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
    let title = '';
    for (let i = 0; i < 50 && title !== 'À propos'; i += 1) {
      const evaluated = (await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId)) as { result: { value: string } };
      title = evaluated.result.value;
      if (title !== 'À propos') await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(title).toBe('À propos');
    await cdp.send('Target.closeTarget', { targetId });
    await cdp.close();
    expect(alive()).toBe(true);
  });

  test('réécriture : contexte créé avec le proxyServer d’un tiers → sort par l’egress, 0 connexion vers le tiers', async () => {
    const cdp = await rawCdp(cdpUrl());
    const { browserContextId } = (await cdp.send('Target.createBrowserContext', { proxyServer: `http://127.0.0.1:${trap.tcpPort}`, proxyBypassList: '*' })) as { browserContextId: string };
    const before = egressRequests.length;
    const { targetId } = (await cdp.send('Target.createTarget', { url: siteUrl('/'), browserContextId })) as { targetId: string };
    const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
    let title = '';
    for (let i = 0; i < 50 && title !== 'SYM Browser fixtures'; i += 1) {
      title = ((await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId)) as { result: { value: string } }).result.value;
      if (title !== 'SYM Browser fixtures') await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(title).toBe('SYM Browser fixtures');
    expect(egressRequests.length).toBeGreaterThan(before);
    expect(trap.tcpConnections()).toBe(0);
    await cdp.send('Target.disposeBrowserContext', { browserContextId });
    await cdp.close();
  });

  test('Stagehand cdpUrl (mode LOCAL, sans LLM) : page de la fixture ouverte et lue', async () => {
    const stagehand = new Stagehand({
      env: 'LOCAL',
      localBrowserLaunchOptions: { cdpUrl: cdpUrl() },
      disableAPI: true,
      disablePino: true,
      verbose: 0,
      logger: () => undefined,
      model: { modelName: 'openai/gpt-4o-mini', apiKey: 'sk-test-factice-sans-appel' },
    } as ConstructorParameters<typeof Stagehand>[0]);
    await stagehand.init();
    const page = stagehand.context.pages()[0] ?? (await stagehand.context.newPage());
    await page.goto(siteUrl('/'));
    expect(await page.title()).toBe('SYM Browser fixtures');
    expect(await page.evaluate('document.querySelectorAll("li").length')).toBe(7);
    await stagehand.close();
    // Stagehand peut terminer par Browser.close : le relais en fait une libération (04f § 4), jamais un plantage.
    expect(lease.signal.aborted && released === 0).toBe(false);
  }, 120_000);

  test('Browser.close d’un client CDP = libération de la session (04f § 4)', async () => {
    if (!alive()) {
      // Déjà libérée par Browser.close du client précédent (Stagehand) : même chemin du relais, une seule libération.
      expect(released).toBe(1);
      return;
    }
    const cdp = await rawCdp(cdpUrl());
    await cdp.send('Browser.close');
    const deadline = Date.now() + 10_000;
    while (released === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(released).toBe(1);
  });
});
