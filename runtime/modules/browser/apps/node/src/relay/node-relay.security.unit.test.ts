// SPDX-License-Identifier: AGPL-3.0-only
// Audit de sécurité 5.3 (docs/audit-securite.md) : robustesse du relais du nœud.
// - S06 : un identifiant de session mal encodé (`%E0%A4%A`) répond 404, sans exception qui ferait tomber le processus.
// - S07 : tant que le navigateur n'a pas accepté la connexion, les messages en attente sont bornés (plafond d'un message) ;
//   au-delà, fermeture 1008 et rien transmis.
// Sécurité : aucun processus lancé ici ; le « navigateur muet » est un serveur TCP local qui n'achève jamais l'upgrade.
import { createServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { createNodeRelay, type NodeSessionEndpoints } from './index.js';

const NODE_TOKEN = 't'.repeat(40);
const SESSION = '6f1c0a52-3d1e-4c0b-9a52-2f0d9d7c1b11';

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

/** Navigateur muet : accepte la connexion TCP et ne répond jamais à l'upgrade. */
async function silentBrowser(): Promise<{ url: string; bytes: () => number }> {
  let bytes = 0;
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('data', (chunk) => (bytes += chunk.length));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/devtools/browser/x`, bytes: () => bytes };
}

async function relayOn(endpoint: string, maxMessageBytes: number) {
  const session: NodeSessionEndpoints = { type: 'dedicated', playwright: endpoint, cdp: endpoint, egressProxyUrl: 'http://127.0.0.1:1', downloadsDir: `/data/sessions/${SESSION}/downloads`, release: async () => undefined };
  const relay = createNodeRelay({ nodeToken: NODE_TOKEN, sessions: { get: (id) => (id === SESSION ? session : undefined) }, maxMessageBytes });
  const server: Server = createServer((req, res) => {
    if (!relay.handleRequest(req, res)) res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket, head) => {
    if (!relay.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    await relay.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function upgradeStatus(host: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`http://${host}${path}`, {
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', authorization: `Bearer ${NODE_TOKEN}` },
    });
    req.on('response', (res) => (res.resume(), resolve(res.statusCode ?? 0)));
    req.on('upgrade', (_res, socket) => (socket.destroy(), resolve(101)));
    req.on('error', reject);
    req.end();
  });
}

describe('audit 5.3 : relais du nœud', () => {
  test('S06 : identifiant mal encodé → 404 (upgrade et json/version), le serveur reste debout', async () => {
    const browser = await silentBrowser();
    const host = await relayOn(browser.url, 1024);
    expect(await upgradeStatus(host, '/internal/sessions/%E0%A4%A/cdp')).toBe(404);
    const discovery = await fetch(`http://${host}/internal/sessions/%E0%A4%A/cdp/json/version`, { headers: { authorization: `Bearer ${NODE_TOKEN}` } });
    expect(discovery.status).toBe(404);
    expect(await upgradeStatus(host, `/internal/sessions/${SESSION}/nimporte`)).toBe(404);
  });

  test('S07 : navigateur muet, messages en attente au-delà d’un plafond → 1008, rien transmis', async () => {
    const browser = await silentBrowser();
    const host = await relayOn(browser.url, 1024);
    const ws = new WebSocket(`ws://${host}/internal/sessions/${SESSION}/cdp`, { headers: { authorization: `Bearer ${NODE_TOKEN}` } });
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => (ws.once('open', () => resolve()), ws.once('error', reject)));
    const message = JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'x'.repeat(900) } });
    for (let i = 0; i < 20; i += 1) ws.send(message);
    expect(await closed).toBe(1008);
  });
});
