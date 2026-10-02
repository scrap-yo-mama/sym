// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 3.2 (04d § 1.1, D1 ; BINV7) : vue en direct à la passerelle, sur la base réelle (banc de 2.2) et un nœud simulé.
// - La réponse d'une session `running` porte `liveViewUrl` = `{publicUrl}/v1/sessions/{id}/live?t=<jeton ro, 15 min>`.
// - `WSS /v1/sessions/{id}/live/stream?t=<jeton>` : jeton vérifié dans `preValidation`, avant l'upgrade et avant tout
//   contact avec le nœud ; absent, illisible, expiré, d'une autre session, ou session terminée → 401, 0 connexion au nœud.
// - Jeton valide : relais vers `WS /internal/sessions/{id}/live` du nœud porteur avec `NODE_TOKEN` et le mode du jeton
//   (`x-symb-live-mode`) ; le jeton du visionneur n'est jamais transmis au nœud.
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LiveTokens, MasterKey } from '@sym-browser/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createHarness, type Harness } from '../../test/helpers/harness.js';

const NODE_TOKEN = 'nodetoken-'.repeat(4);

type NodeConnection = { path: string; authorization: string | undefined; mode: string | undefined };

async function fakeNode() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: (info: { req: { headers: Record<string, unknown> } }) => info.req.headers.authorization === `Bearer ${NODE_TOKEN}` });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const connections: NodeConnection[] = [];
  wss.on('connection', (socket, req) => {
    connections.push({ path: req.url ?? '', authorization: req.headers.authorization, mode: req.headers['x-symb-live-mode'] as string | undefined });
    socket.send(JSON.stringify({ t: 'meta', mode: req.headers['x-symb-live-mode'] }));
  });
  return {
    url: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}

let now = Date.now();
const liveTokens = new LiveTokens(MasterKey.generate(), { now: () => new Date(now) });
let h: Harness;
let node: Awaited<ReturnType<typeof fakeNode>>;
let base: string;
let session: string;
let other: string;

beforeAll(async () => {
  node = await fakeNode();
  h = await createHarness({ nodeUrl: node.url, relay: { nodeToken: NODE_TOKEN, liveTokens } });
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  base = `ws://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  session = (await h.call({ method: 'POST', url: '/v1/sessions', body: { type: 'shared', liveView: { interactive: true } } })).body.id;
  other = (await h.call({ method: 'POST', url: '/v1/sessions', body: {} })).body.id;
});
afterAll(async () => {
  await h?.close();
  await node?.close();
});

function status(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url.replace(/^ws/, 'http'), { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'), ...headers } });
    req.on('response', (res) => (res.resume(), resolve(res.statusCode ?? 0)));
    req.on('upgrade', (_res, socket) => (socket.destroy(), resolve(101)));
    req.on('error', reject);
    req.end();
  });
}

const stream = (id: string, token?: string) => `${base}/v1/sessions/${id}/live/stream${token === undefined ? '' : `?t=${encodeURIComponent(token)}`}`;

describe('vue en direct à la passerelle (04d § 1.1)', () => {
  test('liveViewUrl : …/v1/sessions/{id}/live?t=<jeton ro de 15 min> dans la réponse d’une session running', async () => {
    const { body } = await h.call({ method: 'GET', url: `/v1/sessions/${session}` });
    const url = new URL(body.liveViewUrl as string);
    expect(`${url.origin}${url.pathname}`).toBe(`https://b.example.com/v1/sessions/${session}/live`);
    const check = liveTokens.verify(url.searchParams.get('t')!, session);
    expect(check).toMatchObject({ ok: true, mode: 'ro' });
    expect(check.ok && check.expiresAt.getTime() - now).toBeGreaterThan(14 * 60_000);
  });

  test('assert_access_authenticated (D1) : jeton absent, illisible, d’une autre session, expiré, clé d’API, session terminée → 401 avant tout contact avec le nœud', async () => {
    const before = node.connections.length;
    expect(await status(stream(session))).toBe(401);
    expect(await status(stream(session, 'pas-un-jeton'))).toBe(401);
    expect(await status(stream(session, liveTokens.issue({ sessionId: other, mode: 'rw' }).token))).toBe(401);
    expect(await status(stream(session), { authorization: `Bearer ${h.keys.a}` })).toBe(401);
    const short = liveTokens.issue({ sessionId: session, mode: 'ro', ttlSeconds: 1 }).token;
    now += 2_000;
    expect(await status(stream(session, short))).toBe(401);
    const ended = (await h.call({ method: 'POST', url: '/v1/sessions', body: {} })).body.id as string;
    const endedToken = liveTokens.issue({ sessionId: ended, mode: 'ro' }).token;
    await h.call({ method: 'DELETE', url: `/v1/sessions/${ended}` });
    expect(await status(stream(ended, endedToken))).toBe(401);
    expect(node.connections.length).toBe(before);
  });

  test('jeton valide : relais vers /internal/sessions/{id}/live avec NODE_TOKEN et le mode du jeton, jamais le jeton du visionneur', async () => {
    for (const mode of ['ro', 'rw'] as const) {
      const ws = new WebSocket(stream(session, liveTokens.issue({ sessionId: session, mode }).token));
      const first = new Promise<string>((resolve) => ws.once('message', (data) => resolve(data.toString())));
      await new Promise<void>((resolve, reject) => (ws.once('open', () => resolve()), ws.once('error', reject)));
      expect(JSON.parse(await first)).toEqual({ t: 'meta', mode });
      ws.close();
    }
    expect(node.connections.slice(-2)).toEqual([
      { path: `/internal/sessions/${session}/live`, authorization: `Bearer ${NODE_TOKEN}`, mode: 'ro' },
      { path: `/internal/sessions/${session}/live`, authorization: `Bearer ${NODE_TOKEN}`, mode: 'rw' },
    ]);
  });
});
