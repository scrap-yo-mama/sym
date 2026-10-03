// SPDX-License-Identifier: AGPL-3.0-only
// Vue en direct de bout en bout sur un vrai Chromium 153 (tâche 3.2 ; recette étape 6 ; 04d D1 à D4 ; BINV7) :
//   visionneur (WebSocket) → relais WSS de la passerelle `/v1/sessions/{id}/live/stream?t=` (jeton de vue vérifié avant
//   l'upgrade, tâche 2.3) → relais interne du nœud `/internal/sessions/{id}/live` (NODE_TOKEN) → `LiveView` de la session
//   shared (screencast CDP du contexte tenu par le nœud, tâche 1.3).
// - D1 : URL expirée ou d'une autre session → 401 ;
// - D2 (`assert_access_authenticated`) : jeton ro, trames reçues, 50 messages souris et clavier → 0 événement d'entrée vu par
//   la page ;
// - D3 : option interactive et jeton rw → le clic atteint le bouton de la page ; `live.input` compte 1 ;
// - D4 (`live_view_slow_viewer`) : visionneur lent sur une page animée → au plus 2 trames en vol, chaque trame acquittée.
// Pages servies par `route.fulfill` (le proxy de lancement reste fermé). Utilisateur non root exigé ; Chromium arrêté par le
// pool (groupe de processus enregistré), jamais par un signal à un autre pid.
import { randomBytes } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ApiProblem } from '../apps/gateway/src/api/errors.ts';
import { registerRelay } from '../apps/gateway/src/relay/index.ts';
import { LiveViews, type LiveChannel, type LiveEvent, type LiveServerMessage } from '../apps/node/src/live/index.ts';
import { BrowserPool, OwnedProcessGroups, PROVISIONAL_CAPACITY, playwrightLauncher, startClosedLaunchProxy, type ClosedLaunchProxy } from '../apps/node/src/pool/index.ts';
import { createNodeRelay } from '../apps/node/src/relay/index.ts';
import { SharedSessions, type SharedSession } from '../apps/node/src/sessions/index.ts';
import { LiveTokens, MasterKey } from '../packages/core/src/index.ts';

const PAGE = `<!doctype html><title>Vue</title>
<style>body{margin:0}#b{position:absolute;left:200px;top:150px;width:200px;height:100px}#a{width:50px;height:50px;background:red;animation:m .5s infinite alternate}@keyframes m{to{transform:translateX(600px)}}</style>
<button id="b" onclick="window.__clicks++">Clique</button><div id="a"></div>
<script>window.__clicks=0;window.__inputs=0;for(const t of ['mousedown','mouseup','mousemove','click','keydown','keyup','wheel','input','beforeinput'])addEventListener(t,()=>window.__inputs++,true);</script>`;

const NODE_TOKEN = randomBytes(24).toString('base64url');
let now = Date.now();
const tokens = new LiveTokens(MasterKey.generate(), { now: () => new Date(now) });
const events: LiveEvent[] = [];
let proxy: ClosedLaunchProxy;
let pool: BrowserPool;
let sessions: SharedSessions;
let views: LiveViews;
let nodeServer: Server;
let nodeRelay: ReturnType<typeof createNodeRelay>;
let gateway: FastifyInstance;
let gatewayBase: string;

beforeAll(async () => {
  if (process.getuid?.() === 0) throw new Error('tests Chromium : lance-les sous un utilisateur non root (le bac à sable de Chromium refuse root, 03 § 7).');
  proxy = await startClosedLaunchProxy();
  const groups = new OwnedProcessGroups();
  pool = new BrowserPool({ slotsTotal: 4, warmBrowsers: 1, launch: playwrightLauncher({ launchProxyUrl: proxy.url, groups }), constants: PROVISIONAL_CAPACITY, sweep: () => groups.sweep() });
  await pool.start();
  views = new LiveViews({ onEvent: (e) => events.push(e) });
  sessions = new SharedSessions({ pool, liveViews: views });

  nodeRelay = createNodeRelay({ nodeToken: NODE_TOKEN, sessions: { get: () => undefined }, live: views });
  nodeServer = createServer((_req, res) => res.writeHead(404).end());
  nodeServer.on('upgrade', (req, socket, head) => {
    if (!nodeRelay.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => nodeServer.listen(0, '127.0.0.1', resolve));
  const nodeUrl = `http://127.0.0.1:${(nodeServer.address() as AddressInfo).port}`;

  // Passerelle : le résolveur vérifie le jeton de vue (session, mode, échéance) et route vers le nœud porteur.
  gateway = Fastify({ logger: false });
  await registerRelay(gateway, {
    nodeToken: NODE_TOKEN,
    resolver: {
      async authorize({ sessionId, protocol, query }) {
        const secret = typeof query.t === 'string' && query.t !== '' ? query.t : null;
        if (protocol !== 'live' || secret === null) return { ok: false, problem: new ApiProblem('unauthorized', 'Invalid live token.') };
        const check = tokens.verify(secret, sessionId);
        if (!check.ok || views.get(sessionId) === undefined) return { ok: false, problem: new ApiProblem('unauthorized', 'Invalid live token.') };
        return { ok: true, nodeUrl, sessionId, liveMode: check.mode };
      },
    },
  });
  await gateway.listen({ host: '127.0.0.1', port: 0 });
  gatewayBase = `ws://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await gateway?.close();
  await nodeRelay?.close();
  if (nodeServer) {
    nodeServer.closeAllConnections();
    await new Promise<void>((resolve) => nodeServer.close(() => resolve()));
  }
  await pool?.close();
  await proxy?.close();
}, 120_000);

async function openSession(id: string, interactive: boolean): Promise<SharedSession> {
  const session = await sessions.create({ sessionId: id, tenantId: 'tenant-a', options: {}, liveView: { interactive } });
  await session.context.route('https://zz-live.invalid/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
  const page = await session.context.newPage();
  await page.goto('https://zz-live.invalid/');
  return session;
}

const streamUrl = (sessionId: string, token: string) => `${gatewayBase}/v1/sessions/${sessionId}/live/stream?t=${encodeURIComponent(token)}`;

function upgradeStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url.replace(/^ws/, 'http'), { agent: false, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } });
    req.on('response', (res) => (res.resume(), resolve(res.statusCode ?? 0)));
    req.on('upgrade', (res, socket) => (socket.destroy(), resolve(res.statusCode ?? 0)));
    req.on('error', reject);
    req.end();
  });
}

async function viewer(sessionId: string, mode: 'ro' | 'rw') {
  const ws = new WebSocket(streamUrl(sessionId, tokens.issue({ sessionId, mode }).token));
  const messages: LiveServerMessage[] = [];
  ws.onmessage = (m) => messages.push(JSON.parse(String(m.data)) as LiveServerMessage);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  const until = async (predicate: () => boolean, label: string) => {
    for (let i = 0; i < 200 && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 25));
    if (!predicate()) throw new Error(`délai dépassé : ${label}`);
  };
  return { ws, messages, until, send: (message: unknown) => ws.send(JSON.stringify(message)) };
}

describe('vue en direct de bout en bout (recette étape 6)', () => {
  test('D1 : URL expirée ou liée à une autre session → 401 à la passerelle', async () => {
    const session = await openSession('11111111-1111-4111-8111-111111111111', false);
    try {
      const expiring = tokens.issue({ sessionId: session.sessionId, mode: 'ro', ttlSeconds: 1 }).token;
      expect(await upgradeStatus(streamUrl(session.sessionId, expiring))).toBe(101);
      now += 2_000;
      expect(await upgradeStatus(streamUrl(session.sessionId, expiring))).toBe(401);
      expect(await upgradeStatus(streamUrl(session.sessionId, tokens.issue({ sessionId: '22222222-2222-4222-8222-222222222222', mode: 'ro' }).token))).toBe(401);
    } finally {
      await session.release();
    }
  });

  test('assert_access_authenticated (D2) : lecture seule, trames reçues, 50 messages souris et clavier → 0 événement d’entrée vu par la page', async () => {
    const session = await openSession('33333333-3333-4333-8333-333333333333', true);
    try {
      const v = await viewer(session.sessionId, 'ro');
      await v.until(() => v.messages.some((m) => m.t === 'frame'), 'première trame');
      const frame = v.messages.find((m): m is Extract<LiveServerMessage, { t: 'frame' }> => m.t === 'frame')!;
      expect(Buffer.from(frame.data, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8');
      expect(v.messages[0]).toMatchObject({ t: 'meta', url: 'https://zz-live.invalid/', title: 'Vue', mode: 'ro' });
      // Relevé avant les messages du visionneur : Chromium émet lui-même un mousemove synthétique au chargement d'une page.
      const page = session.context.pages()[0]!;
      const counters = () => page.evaluate(() => ({ clicks: (globalThis as unknown as { __clicks: number }).__clicks, inputs: (globalThis as unknown as { __inputs: number }).__inputs }));
      const before = await counters();
      for (let i = 0; i < 50; i += 1) v.send(i % 2 === 0 ? { t: 'mouse', type: 'click', x: 300, y: 200 } : { t: 'key', type: 'down', key: 'a' });
      v.send({ t: 'text', text: 'bonjour' });
      v.send({ t: 'ping' });
      await v.until(() => v.messages.some((m) => m.t === 'pong'), 'pong');
      // 0 événement d'entrée transmis : rien ne s'ajoute au relevé, aucun clic.
      expect(await counters()).toEqual({ clicks: 0, inputs: before.inputs });
      expect(v.messages.some((m) => m.t === 'notice')).toBe(true);
      v.ws.close();
    } finally {
      await session.release();
    }
  });

  test('D3 : option interactive et jeton rw → le clic atteint la page ; live.input compte 1', async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    const session = await openSession(id, true);
    const page = session.context.pages()[0]!;
    const box = await page.locator('#b').boundingBox();
    const v = await viewer(id, 'rw');
    await v.until(() => v.messages.some((m) => m.t === 'frame'), 'première trame');
    v.send({ t: 'mouse', type: 'click', x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
    const clicks = () => page.evaluate(() => (globalThis as unknown as { __clicks: number }).__clicks);
    for (let i = 0; i < 100 && (await clicks()) === 0; i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(await clicks()).toBe(1);
    await session.release();
    expect(events.filter((e) => e.sessionId === id)).toEqual([{ type: 'live.input', sessionId: id, count: 1, windowStart: expect.any(String) as string }]);
    await v.until(() => v.messages.at(-1)?.t === 'closed', 'closed');
  });

  test('live_view_slow_viewer (D4) : page animée, visionneur lent → au plus 2 trames en vol, chaque trame acquittée', async () => {
    const id = '55555555-5555-4555-8555-555555555555';
    const session = await openSession(id, false);
    let inFlight = 0;
    let maxInFlight = 0;
    let delivered = 0;
    const slow: LiveChannel = {
      send: (message) => {
        if (message.t !== 'frame') return Promise.resolve();
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) =>
          setTimeout(() => {
            inFlight -= 1;
            delivered += 1;
            resolve();
          }, 400),
        );
      },
      close: () => undefined,
    };
    const view = views.get(id)!;
    await view.attach(slow, 'ro');
    await new Promise((r) => setTimeout(r, 3_000));
    const stats = view.stats();
    await session.release();
    expect(stats.frames).toBeGreaterThan(20);
    expect(stats.acks).toBe(stats.frames);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(delivered).toBeLessThan(stats.frames);
  });
});
