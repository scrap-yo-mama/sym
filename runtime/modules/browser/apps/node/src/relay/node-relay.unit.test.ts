// SPDX-License-Identifier: AGPL-3.0-only
// Relais du nœud (cdc/sym-browser 04b § 8, 04f § 4, tâche 2.3) contre de faux points Chromium (serveurs WebSocket locaux).
//   assert_access_authenticated (P12) : sans NODE_TOKEN valide, 401 avant toute lecture et aucune connexion vers Chromium.
//   Réécritures CDP, liste fermée de 04f § 4 : Target.createBrowserContext forcé sur l'egress de la session,
//   setDownloadBehavior ramené au dossier de la session, Browser.close = libération. Toute autre commande passe telle quelle,
//   re-sérialisée (une clé en double ne peut pas tromper le navigateur) ; un message illisible ferme la connexion (1007).
// Sécurité : aucun processus lancé ici.
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { createNodeRelay, type NodeSessionEndpoints } from './index.js';

const NODE_TOKEN = 'n'.repeat(40);
const DEDICATED = '6f1c0a52-3d1e-4c0b-9a52-2f0d9d7c1b11';
const SHARED = '0d3f2c1a-6b7e-4a5f-9c8d-1e2f3a4b5c6d';
const EGRESS = 'http://127.0.0.1:41234';
const DOWNLOADS = '/data/sessions/6f1c0a52-3d1e-4c0b-9a52-2f0d9d7c1b11/downloads';

type FakeBrowser = { url: string; received: string[]; connections: number; close: () => Promise<void> };

/** Faux Chromium : journalise chaque message reçu et répond `{id, result: {}}` à chaque commande. */
async function fakeBrowser(): Promise<FakeBrowser> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const state: FakeBrowser = {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/devtools/browser/x`,
    received: [],
    connections: 0,
    close: () => new Promise<void>((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => resolve());
    }),
  };
  wss.on('connection', (socket) => {
    state.connections += 1;
    socket.on('message', (data: RawData) => {
      const text = data.toString();
      state.received.push(text);
      try {
        const message = JSON.parse(text) as { id?: number };
        if (typeof message.id === 'number') socket.send(JSON.stringify({ id: message.id, result: {} }));
      } catch {
        // Le faux Chromium ignore ce qu'il ne lit pas.
      }
    });
  });
  return state;
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function setup(options: { maxMessageBytes?: number } = {}) {
  const cdp = await fakeBrowser();
  const playwright = await fakeBrowser();
  const released: string[] = [];
  const activity: string[] = [];
  const sessions = new Map<string, NodeSessionEndpoints>([
    [DEDICATED, { type: 'dedicated', playwright: playwright.url, cdp: cdp.url, egressProxyUrl: EGRESS, downloadsDir: DOWNLOADS, release: async () => void released.push(DEDICATED) }],
    [SHARED, { type: 'shared', playwright: playwright.url, cdp: null, egressProxyUrl: EGRESS, downloadsDir: null, release: async () => void released.push(SHARED) }],
  ]);
  const relay = createNodeRelay({
    nodeToken: NODE_TOKEN,
    sessions: { get: (id) => sessions.get(id) },
    onActivity: (id) => activity.push(id),
    ...(options.maxMessageBytes === undefined ? {} : { maxMessageBytes: options.maxMessageBytes }),
  });
  const server: Server = createServer((_req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    if (!relay.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(async () => {
    await relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await cdp.close();
    await playwright.close();
  });
  return { base, cdp, playwright, released, activity };
}

/** Upgrade brut : statut HTTP de refus (aucune WebSocket ouverte). */
function refusal(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url.replace(/^ws/, 'http'), { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('error', reject);
    req.end();
  });
}

function open(url: string): Promise<{ ws: WebSocket; messages: unknown[]; closed: Promise<{ code: number; reason: string }> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${NODE_TOKEN}` } });
    const messages: unknown[] = [];
    const closed = new Promise<{ code: number; reason: string }>((done) => ws.on('close', (code, reason) => done({ code, reason: reason.toString() })));
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    ws.once('open', () => resolve({ ws, messages, closed }));
    ws.once('error', reject);
  });
}

const until = async (predicate: () => boolean, ms = 2_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('délai dépassé');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('assert_access_authenticated (P12) : NODE_TOKEN à l’upgrade', () => {
  test('sans jeton, mauvais jeton ou jeton tronqué : 401, aucune connexion vers Chromium', async () => {
    const s = await setup();
    const url = `${s.base}/internal/sessions/${DEDICATED}/cdp`;
    expect(await refusal(url, {})).toBe(401);
    expect(await refusal(url, { authorization: `Bearer ${'x'.repeat(40)}` })).toBe(401);
    expect(await refusal(url, { authorization: `Bearer ${NODE_TOKEN.slice(1)}` })).toBe(401);
    expect(await refusal(url, { authorization: NODE_TOKEN })).toBe(401);
    expect(s.cdp.connections).toBe(0);
  });

  test('session inconnue du nœud : 404 ; CDP sur shared : 409 ; chemin hors relais : non traité', async () => {
    const s = await setup();
    const auth = { authorization: `Bearer ${NODE_TOKEN}` };
    expect(await refusal(`${s.base}/internal/sessions/00000000-0000-4000-8000-000000000000/cdp`, auth)).toBe(404);
    expect(await refusal(`${s.base}/internal/sessions/${SHARED}/cdp`, auth)).toBe(409);
    expect(await refusal(`${s.base}/internal/sessions/${DEDICATED}/bidi`, auth)).toBe(404);
    expect(s.cdp.connections + s.playwright.connections).toBe(0);
  });
});

describe('réécritures du relais CDP (04f § 4, liste fermée)', () => {
  test('Target.createBrowserContext : proxyServer forcé sur l’egress de la session, boucle locale seule exemptée', async () => {
    const s = await setup();
    const client = await open(`${s.base}/internal/sessions/${DEDICATED}/cdp`);
    client.ws.send(JSON.stringify({ id: 1, method: 'Target.createBrowserContext', params: { proxyServer: 'http://proxy-tiers.example:8080', proxyBypassList: '*', disposeOnDetach: true } }));
    await until(() => s.cdp.received.length === 1);
    expect(JSON.parse(s.cdp.received[0] ?? '')).toEqual({ id: 1, method: 'Target.createBrowserContext', params: { proxyServer: EGRESS, proxyBypassList: '<-loopback>', disposeOnDetach: true } });
    client.ws.send(JSON.stringify({ id: 2, method: 'Target.createBrowserContext' }));
    await until(() => s.cdp.received.length === 2);
    expect(JSON.parse(s.cdp.received[1] ?? '').params).toEqual({ proxyServer: EGRESS, proxyBypassList: '<-loopback>' });
  });

  test('setDownloadBehavior (Browser et Page, session cible comprise) : downloadPath = dossier de la session', async () => {
    const s = await setup();
    const client = await open(`${s.base}/internal/sessions/${DEDICATED}/cdp`);
    client.ws.send(JSON.stringify({ id: 1, method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', downloadPath: '/tmp', eventsEnabled: true } }));
    client.ws.send(JSON.stringify({ id: 2, method: 'Page.setDownloadBehavior', params: { behavior: 'allow' }, sessionId: 'T1' }));
    client.ws.send(JSON.stringify({ id: 3, method: 'Browser.setDownloadBehavior', params: { behavior: 'deny' } }));
    await until(() => s.cdp.received.length === 3);
    const [a, b, c] = s.cdp.received.map((m) => JSON.parse(m));
    expect(a.params).toEqual({ behavior: 'allow', downloadPath: DOWNLOADS, eventsEnabled: true });
    expect(b).toEqual({ id: 2, method: 'Page.setDownloadBehavior', params: { behavior: 'allow', downloadPath: DOWNLOADS }, sessionId: 'T1' });
    expect(c.params).toEqual({ behavior: 'deny' });
  });

  test('Browser.close : non transmis, réponse au client, session libérée', async () => {
    const s = await setup();
    const client = await open(`${s.base}/internal/sessions/${DEDICATED}/cdp`);
    client.ws.send(JSON.stringify({ id: 7, method: 'Browser.close' }));
    await until(() => s.released.length === 1);
    await until(() => client.messages.length === 1);
    expect(client.messages[0]).toEqual({ id: 7, result: {} });
    expect(s.cdp.received.filter((m) => m.includes('Browser.close'))).toEqual([]);
  });

  test('autres commandes : transmises re-sérialisées ; clé en double ramenée à la dernière valeur lue par le relais', async () => {
    const s = await setup();
    const client = await open(`${s.base}/internal/sessions/${DEDICATED}/cdp`);
    client.ws.send('{"id":1,"method":"Runtime.evaluate","params":{"expression":"1+1"}}');
    // Clé `method` en double : le relais lit la dernière (createBrowserContext) et réécrit ; le navigateur reçoit la forme canonique.
    client.ws.send('{"id":2,"method":"Target.getTargets","method":"Target.createBrowserContext","params":{"proxyServer":"http://x:1"}}');
    await until(() => s.cdp.received.length === 2);
    expect(s.cdp.received[0]).toBe('{"id":1,"method":"Runtime.evaluate","params":{"expression":"1+1"}}');
    expect(JSON.parse(s.cdp.received[1] ?? '')).toEqual({ id: 2, method: 'Target.createBrowserContext', params: { proxyServer: EGRESS, proxyBypassList: '<-loopback>' } });
    expect(s.cdp.received[1]).not.toContain('Target.getTargets');
    // Réponses et événements du navigateur : rendus au client tels quels.
    await until(() => client.messages.length === 2);
    expect(client.messages).toEqual([{ id: 1, result: {} }, { id: 2, result: {} }]);
  });

  test('message illisible (non JSON, binaire, tableau) : connexion fermée 1007, rien transmis', async () => {
    for (const bad of ['pas du json', '[1,2]', Buffer.from([0xff, 0x00])]) {
      const s = await setup();
      const client = await open(`${s.base}/internal/sessions/${DEDICATED}/cdp`);
      client.ws.send(bad);
      expect((await client.closed).code).toBe(1007);
      expect(s.cdp.received).toEqual([]);
    }
  });

  test('message au-delà du plafond : fermeture 1009, rien transmis', async () => {
    const s = await setup({ maxMessageBytes: 1024 });
    const client = await open(`${s.base}/internal/sessions/${DEDICATED}/cdp`);
    client.ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'x'.repeat(2048) } }));
    expect((await client.closed).code).toBe(1009);
    expect(s.cdp.received).toEqual([]);
  });

  test('chaque message du client compte comme activité (délai d’inactivité, tâche 1.2)', async () => {
    const s = await setup();
    const client = await open(`${s.base}/internal/sessions/${DEDICATED}/cdp`);
    client.ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate' }));
    client.ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate' }));
    await until(() => s.activity.length === 2);
    expect(s.activity).toEqual([DEDICATED, DEDICATED]);
  });
});

describe('relais Playwright natif', () => {
  test('messages transmis ; newContext forcé sur l’egress de la session (BINV2), quel que soit le proxy demandé', async () => {
    const s = await setup();
    const client = await open(`${s.base}/internal/sessions/${SHARED}/playwright`);
    client.ws.send(JSON.stringify({ id: 1, guid: 'browser@1', method: 'newContext', params: { viewport: null, proxy: { server: 'socks5://tiers:1080' } }, metadata: {} }));
    client.ws.send(JSON.stringify({ id: 2, guid: 'page@1', method: 'goto', params: { url: 'https://example.com' }, metadata: {} }));
    await until(() => s.playwright.received.length === 2);
    expect(JSON.parse(s.playwright.received[0] ?? '').params).toEqual({ viewport: null, proxy: { server: EGRESS, bypass: '<-loopback>' } });
    expect(JSON.parse(s.playwright.received[1] ?? '')).toEqual({ id: 2, guid: 'page@1', method: 'goto', params: { url: 'https://example.com' }, metadata: {} });
  });

  test('fermeture : codes propagés dans les deux sens, aucune libération (déconnexion ≠ libération)', async () => {
    const s = await setup();
    const client = await open(`${s.base}/internal/sessions/${DEDICATED}/playwright`);
    await until(() => s.playwright.connections === 1);
    client.ws.close(4001, 'fin client');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(s.released).toEqual([]);
  });
});
