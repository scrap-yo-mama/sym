// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 3.2 (04d § 1.2, 04b § 8) : vue en direct derrière le relais interne du nœud (tâche 2.3), `WS
// /internal/sessions/{id}/live`, ouvert par la passerelle seule. `NODE_TOKEN` vérifié avant toute lecture (401, aucune vue
// touchée) ; session sans vue en direct : 404 ; mode transmis par la passerelle (`x-symb-live-mode`, qui a vérifié le jeton
// de vue) : `ro` par défaut, `rw` seulement s'il est annoncé ; visionneur rattaché à la `LiveView` de la session.
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BrowserContext } from 'playwright-core';
import { afterEach, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { createNodeRelay } from '../relay/index.js';
import { LiveViews, type LiveServerMessage } from './index.js';

const NODE_TOKEN = 'nodetoken-'.repeat(4);
const SESSION = '6f1c0a52-3d1e-4c0b-9a52-2f0d9d7c1b11';

const page = { url: () => 'https://zz.invalid/a', title: () => Promise.resolve('A'), viewportSize: () => ({ width: 1280, height: 720 }), isClosed: () => false, on: () => undefined, off: () => undefined };
const inputs: string[] = [];
const cdp = { send: (method: string) => (method.startsWith('Input.') && inputs.push(method), Promise.resolve({})), on: () => undefined, off: () => undefined, detach: () => Promise.resolve() };
const context = { pages: () => [page], on: () => undefined, off: () => undefined, newCDPSession: () => Promise.resolve(cdp) } as unknown as BrowserContext;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  inputs.length = 0;
});

async function setup(interactive: boolean) {
  const views = new LiveViews();
  const view = views.open({ sessionId: SESSION, context, interactive });
  let attached = 0;
  const attach = view.attach.bind(view);
  view.attach = (...args) => ((attached += 1), attach(...args));
  const relay = createNodeRelay({ nodeToken: NODE_TOKEN, sessions: { get: () => undefined }, live: views });
  const server: Server = createServer((_req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    if (!relay.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(async () => {
    await relay.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { views, view, base, attached: () => attached };
}

function status(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url.replace(/^ws/, 'http'), { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
    req.on('response', (res) => (res.resume(), resolve(res.statusCode ?? 0)));
    req.on('upgrade', (_res, socket) => (socket.destroy(), resolve(101)));
    req.on('error', reject);
    req.end();
  });
}

async function open(url: string, headers: Record<string, string>) {
  const ws = new WebSocket(url, { headers });
  const messages: LiveServerMessage[] = [];
  const closed = new Promise<{ code: number; reason: string }>((done) => ws.on('close', (code, reason) => done({ code, reason: reason.toString() })));
  ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as LiveServerMessage));
  await new Promise<void>((resolve, reject) => (ws.once('open', () => resolve()), ws.once('error', reject)));
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 10));
  };
  return { ws, messages, closed, until };
}

describe('vue en direct derrière le relais interne du nœud', () => {
  test('sans NODE_TOKEN ou avec un autre : 401, aucune vue touchée ; session sans vue : 404', async () => {
    const { base, attached } = await setup(false);
    expect(await status(`${base}/internal/sessions/${SESSION}/live`, {})).toBe(401);
    expect(await status(`${base}/internal/sessions/${SESSION}/live`, { authorization: 'Bearer autre-jeton' })).toBe(401);
    expect(await status(`${base}/internal/sessions/0a9f2a52-3d1e-4c0b-9a52-2f0d9d7c1b22/live`, { authorization: `Bearer ${NODE_TOKEN}` })).toBe(404);
    expect(attached()).toBe(0);
  });

  test('mode lecture seule par défaut : meta ro, entrées écartées, ping → pong ; fin de session → closed et fermeture', async () => {
    const { base, views, attached } = await setup(true);
    const v = await open(`${base}/internal/sessions/${SESSION}/live`, { authorization: `Bearer ${NODE_TOKEN}`, 'x-symb-live-mode': 'n-importe' });
    await v.until(() => v.messages.length > 0);
    expect(attached()).toBe(1);
    expect(v.messages[0]).toMatchObject({ t: 'meta', mode: 'ro', interactive: true });
    v.ws.send(JSON.stringify({ t: 'mouse', type: 'click', x: 1, y: 1 }));
    v.ws.send(JSON.stringify({ t: 'ping' }));
    await v.until(() => v.messages.some((m) => m.t === 'pong'));
    expect(inputs).toEqual([]);
    await views.close(SESSION, 'released');
    expect((await v.closed).code).toBe(1000);
    expect(v.messages.at(-1)).toEqual({ t: 'closed', reason: 'released' });
  });

  test('mode rw annoncé par la passerelle sur une session interactive : entrées transmises au navigateur', async () => {
    const { base } = await setup(true);
    const v = await open(`${base}/internal/sessions/${SESSION}/live`, { authorization: `Bearer ${NODE_TOKEN}`, 'x-symb-live-mode': 'rw' });
    await v.until(() => v.messages.length > 0);
    expect(v.messages[0]).toMatchObject({ t: 'meta', mode: 'rw' });
    v.ws.send(JSON.stringify({ t: 'mouse', type: 'click', x: 1, y: 1 }));
    await v.until(() => inputs.length >= 2);
    expect(inputs).toEqual(['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent']);
    v.ws.close();
  });
});
