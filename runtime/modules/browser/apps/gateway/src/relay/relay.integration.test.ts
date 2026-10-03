// SPDX-License-Identifier: AGPL-3.0-only
// Relais WSS `/v1/sessions/{id}/playwright` et `/cdp` de la passerelle (cdc/sym-browser 04 § 7 et § 8, 04f § 2 et § 3,
// tâche 2.3) sur PostgreSQL réel, devant un faux nœud qui compte ses connexions et vérifie NODE_TOKEN.
//   assert_access_authenticated (BINV7, A6, F4) : sans jeton, jeton expiré, jeton d'une autre session ou d'un autre
//     protocole, clé d'un autre client → 401 ; clé sans scope → 403 ; dans tous ces cas, 0 connexion vers le nœud.
//     Jeton en query OU en `Authorization: Bearer`, clé d'API en Bearer : relayés.
//   session_default_dedicated (F2) : `/cdp` sur une session shared → 409 protocol_not_served, 0 octet vers le nœud.
//   version_gate (A7) : client Playwright 1.62 → 428 playwright_version_mismatch ; 1.63 → relayé.
//   disconnect_not_release (A8) : la fermeture de la WebSocket laisse la session running ; la même URL se rouvre.
// Sécurité : aucun processus lancé ici (faux nœud en WebSocket local).
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConnectTokens, generateMasterKey, MasterKey } from '@sym-browser/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createHarness, type Harness } from '../../test/helpers/harness.js';

const NODE_TOKEN = 'nodetoken-'.repeat(4);

type FakeNode = {
  url: string;
  connections: { path: string; authorization: string | undefined }[];
  /** Requêtes HTTP reçues (découverte json/version, tâche 2.8). */
  requests: { path: string; authorization: string | undefined }[];
  received: string[];
  closedWith: number[];
  close: () => Promise<void>;
};

/** Ce que le nœud rend pour `json/version` : les champs de Chromium, SANS point WebSocket (la passerelle pose le sien). */
const NODE_VERSION = { Browser: 'Chrome/153.0.8010.12', 'Protocol-Version': '1.3', 'User-Agent': 'Mozilla/5.0 HeadlessChrome/153.0.8010.12', 'V8-Version': '15.3', 'WebKit-Version': '537.36' };

/**
 * Faux nœud : vérifie le jeton de nœud, journalise chemin, messages et code de fermeture ; répond « echo:<message> ». En HTTP,
 * sert `/internal/sessions/{id}/cdp/json/version` avec un `webSocketDebuggerUrl` LOCAL piégé, que la passerelle doit écarter.
 */
async function fakeNode(): Promise<FakeNode> {
  const authorized = (headers: Record<string, unknown>): boolean => headers.authorization === `Bearer ${NODE_TOKEN}`;
  const server = createServer((req, res) => {
    node.requests.push({ path: req.url ?? '', authorization: req.headers.authorization });
    if (!authorized(req.headers)) return void res.writeHead(401).end();
    if (/^\/internal\/sessions\/[^/]+\/cdp\/json\/version$/.test(req.url ?? '')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ ...NODE_VERSION, webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/piege' }));
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server, verifyClient: (info: { req: { headers: Record<string, unknown> } }) => authorized(info.req.headers) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const node: FakeNode = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    connections: [],
    requests: [],
    received: [],
    closedWith: [],
    close: () => new Promise<void>((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => server.close(() => resolve()));
      server.closeAllConnections();
    }),
  };
  wss.on('connection', (socket, req) => {
    node.connections.push({ path: req.url ?? '', authorization: req.headers.authorization });
    socket.on('message', (data) => {
      const text = data.toString();
      node.received.push(text);
      if (text === 'ferme-4000') socket.close(4000, 'fin du nœud');
      else socket.send(`echo:${text}`);
    });
    socket.on('close', (code) => node.closedWith.push(code));
  });
  return node;
}

let now = Date.now();
const tokens = new ConnectTokens({ current: MasterKey.parse(generateMasterKey()) }, { now: () => now });
let h: Harness;
let node: FakeNode;
let base: string;
let dedicated: string;
let shared: string;

beforeAll(async () => {
  node = await fakeNode();
  h = await createHarness({ nodeUrl: node.url, tokens, relay: { nodeToken: NODE_TOKEN, pingIntervalMs: 100, cdpMaxMessageBytes: 4096 } });
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  base = `ws://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  dedicated = (await h.call({ method: 'POST', url: '/v1/sessions', body: {} })).body.id;
  shared = (await h.call({ method: 'POST', url: '/v1/sessions', body: { type: 'shared' } })).body.id;
});
afterAll(async () => {
  await h?.close();
  await node?.close();
});

type Attempt = { status: number; body: { error?: { code: string } } } | { status: 101; ws: WebSocket; messages: string[]; closed: Promise<{ code: number; reason: string }> };

/** Upgrade WebSocket : refus (statut et corps d'erreur typé) ou connexion ouverte. */
function attempt(path: string, headers: Record<string, string> = {}, options: { autoPong?: boolean } = {}): Promise<Attempt> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}${path}`, { headers, autoPong: options.autoPong ?? true });
    const messages: string[] = [];
    const closed = new Promise<{ code: number; reason: string }>((done) => ws.on('close', (code, reason) => done({ code, reason: reason.toString() })));
    ws.on('message', (data) => messages.push(data.toString()));
    ws.once('open', () => resolve({ status: 101, ws, messages, closed }));
    ws.once('unexpected-response', (_req, res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
    });
    ws.once('error', (error) => {
      if (!/Unexpected server response/.test(error.message)) reject(error);
    });
  });
}

const until = async (predicate: () => boolean, ms = 3_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('délai dépassé');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const token = (sessionId: string, protocol: 'cdp' | 'playwright', ttlSeconds = 300) => tokens.issue({ sessionId, protocol, ttlSeconds });
const PLAYWRIGHT_UA = { 'user-agent': 'Playwright/1.63.0 (x64; ubuntu 24.04) node/24.21' };

describe('assert_access_authenticated (BINV7) : refus à l’upgrade, 0 connexion vers le nœud', () => {
  test.each([
    ['sans jeton ni clé', () => `/v1/sessions/${dedicated}/cdp`, {}, 401, 'unauthorized'],
    ['jeton d’une autre session', () => `/v1/sessions/${dedicated}/cdp?token=${token(shared, 'cdp')}`, {}, 401, 'unauthorized'],
    ['jeton d’un autre protocole', () => `/v1/sessions/${dedicated}/cdp?token=${token(dedicated, 'playwright')}`, {}, 401, 'unauthorized'],
    ['jeton falsifié', () => `/v1/sessions/${dedicated}/cdp?token=${token(dedicated, 'cdp').slice(0, -2)}xx`, {}, 401, 'unauthorized'],
    ['clé d’API inconnue en Bearer', () => `/v1/sessions/${dedicated}/cdp`, { authorization: 'Bearer symb_inconnue' }, 401, 'unauthorized'],
    ['clé d’API d’un autre client', () => `/v1/sessions/${dedicated}/cdp`, () => ({ authorization: `Bearer ${h.keys.b}` }), 401, 'unauthorized'],
    ['clé d’API sans sessions:write', () => `/v1/sessions/${dedicated}/cdp`, () => ({ authorization: `Bearer ${h.keys.aRead}` }), 403, 'forbidden'],
    ['clé d’API en query (refusée : en-tête seulement)', () => `/v1/sessions/${dedicated}/cdp?token=${h.keys.a}`, {}, 401, 'unauthorized'],
    ['session inconnue', () => `/v1/sessions/00000000-0000-4000-8000-000000000000/cdp?token=${token('00000000-0000-4000-8000-000000000000', 'cdp')}`, {}, 401, 'unauthorized'],
  ] as const)('%s → %i %s', async (_name, path, headers, status, code) => {
    const before = node.connections.length;
    const res = await attempt(path(), typeof headers === 'function' ? headers() : headers);
    expect(res.status).toBe(status);
    expect('body' in res && res.body.error?.code).toBe(code);
    expect(node.connections.length).toBe(before);
  });

  test('jeton expiré → 401 ; session terminée → 401 (jeton refusé dès la fin de la session)', async () => {
    const before = node.connections.length;
    const short = token(dedicated, 'cdp', 1);
    now += 1_001;
    try {
      expect((await attempt(`/v1/sessions/${dedicated}/cdp?token=${short}`)).status).toBe(401);
    } finally {
      now -= 1_001;
    }
    const ended = (await h.call({ method: 'POST', url: '/v1/sessions', body: {} })).body.id as string;
    const valid = token(ended, 'cdp');
    await h.call({ method: 'DELETE', url: `/v1/sessions/${ended}` });
    expect((await attempt(`/v1/sessions/${ended}/cdp?token=${valid}`)).status).toBe(401);
    expect(node.connections.length).toBe(before);
  });

  test('jeton en query, jeton en Authorization: Bearer (F4) et clé d’API en Bearer : relayés vers le nœud avec NODE_TOKEN, sans le secret du client', async () => {
    const ways: [string, Record<string, string>][] = [
      [`/v1/sessions/${dedicated}/cdp?token=${token(dedicated, 'cdp')}`, {}],
      [`/v1/sessions/${dedicated}/cdp`, { authorization: `Bearer ${token(dedicated, 'cdp')}` }],
      [`/v1/sessions/${dedicated}/cdp`, { authorization: `Bearer ${h.keys.a}` }],
    ];
    for (const [path, headers] of ways) {
      const before = node.connections.length;
      const res = await attempt(path, headers);
      expect(res.status).toBe(101);
      if (res.status !== 101 || !('ws' in res)) throw new Error('connexion attendue');
      res.ws.send('{"id":1,"method":"Browser.getVersion"}');
      await until(() => res.messages.length === 1);
      expect(res.messages[0]).toBe('echo:{"id":1,"method":"Browser.getVersion"}');
      const seen = node.connections[before];
      expect(seen).toEqual({ path: `/internal/sessions/${dedicated}/cdp`, authorization: `Bearer ${NODE_TOKEN}` });
      res.ws.close();
      await res.closed;
    }
  });
});

describe('session_default_dedicated (F2) et version_gate (A7)', () => {
  test('/cdp sur une session shared : 409 protocol_not_served, 0 connexion vers le nœud ; /playwright sur shared : relayé', async () => {
    const before = node.connections.length;
    const res = await attempt(`/v1/sessions/${shared}/cdp?token=${token(shared, 'cdp')}`);
    expect(res.status).toBe(409);
    expect('body' in res && res.body.error?.code).toBe('protocol_not_served');
    expect(node.connections.length).toBe(before);
    const pw = await attempt(`/v1/sessions/${shared}/playwright?token=${token(shared, 'playwright')}`, PLAYWRIGHT_UA);
    expect(pw.status).toBe(101);
    // La connexion vers le nœud s'ouvre après l'upgrade du client : attendue avant de fermer (mesures suivantes).
    await until(() => node.connections.length === before + 1);
    expect(node.connections.at(-1)?.path).toBe(`/internal/sessions/${shared}/playwright`);
    if ('ws' in pw) pw.ws.close();
  });

  test('client Playwright 1.62 ou sans version → 428 playwright_version_mismatch ; 1.63.x → relayé ; /cdp ne contrôle pas le client', async () => {
    const before = node.connections.length;
    for (const ua of ['Playwright/1.62.0 (x64; ubuntu 24.04) node/24.21', 'Playwright/2.63.0', 'curl/8.5', '']) {
      const res = await attempt(`/v1/sessions/${dedicated}/playwright?token=${token(dedicated, 'playwright')}`, ua ? { 'user-agent': ua } : {});
      expect(res.status, ua).toBe(428);
      expect('body' in res && res.body.error?.code).toBe('playwright_version_mismatch');
    }
    expect(node.connections.length).toBe(before);
    const ok = await attempt(`/v1/sessions/${dedicated}/playwright?token=${token(dedicated, 'playwright')}`, { 'user-agent': 'Playwright/1.63.7 (arm64; darwin 24.1) node/24.0' });
    expect(ok.status).toBe(101);
    if ('ws' in ok) ok.ws.close();
    const cdp = await attempt(`/v1/sessions/${dedicated}/cdp?token=${token(dedicated, 'cdp')}`, { 'user-agent': 'Puppeteer/24' });
    expect(cdp.status).toBe(101);
    if ('ws' in cdp) cdp.ws.close();
  });
});

describe('relais : fermeture, ping, plafond, reconnexion', () => {
  test('codes de fermeture propagés dans les deux sens', async () => {
    const a = await attempt(`/v1/sessions/${dedicated}/cdp?token=${token(dedicated, 'cdp')}`);
    if (!('ws' in a)) throw new Error('connexion attendue');
    a.ws.send('ferme-4000');
    expect((await a.closed).code).toBe(4000);

    const b = await attempt(`/v1/sessions/${dedicated}/cdp?token=${token(dedicated, 'cdp')}`);
    if (!('ws' in b)) throw new Error('connexion attendue');
    const count = node.closedWith.length;
    b.ws.close(4001, 'fin du client');
    await until(() => node.closedWith.length > count);
    expect(node.closedWith.at(-1)).toBe(4001);
  });

  test('ping toutes les pingIntervalMs : deux pongs manquants ferment (1001) ; un client qui répond reste connecté', async () => {
    const silent = await attempt(`/v1/sessions/${dedicated}/cdp?token=${token(dedicated, 'cdp')}`, {}, { autoPong: false });
    const alive = await attempt(`/v1/sessions/${dedicated}/cdp?token=${token(dedicated, 'cdp')}`);
    if (!('ws' in silent) || !('ws' in alive)) throw new Error('connexions attendues');
    expect((await silent.closed).code).toBe(1001);
    expect(alive.ws.readyState).toBe(WebSocket.OPEN);
    alive.ws.close();
  });

  test('message CDP au-delà de SYMB_CDP_MAX_MESSAGE_BYTES : fermeture 1008 (04f § 4), rien relayé ; au plafond : relayé', async () => {
    const res = await attempt(`/v1/sessions/${dedicated}/cdp?token=${token(dedicated, 'cdp')}`);
    if (!('ws' in res)) throw new Error('connexion attendue');
    await until(() => node.connections.some((c) => c.path.endsWith(`/${dedicated}/cdp`)));
    const before = node.received.length;
    res.ws.send('y'.repeat(4096));
    await until(() => node.received.length === before + 1);
    res.ws.send('x'.repeat(4097));
    expect((await res.closed).code).toBe(1008);
    expect(node.received.length).toBe(before + 1);
  });

  test('disconnect_not_release (A8) : la fermeture laisse la session running ; la même URL se rouvre ; GET rend un jeton neuf valable', async () => {
    const url = `/v1/sessions/${dedicated}/cdp?token=${token(dedicated, 'cdp')}`;
    const first = await attempt(url);
    if (!('ws' in first)) throw new Error('connexion attendue');
    first.ws.close();
    await first.closed;
    expect((await h.call({ method: 'GET', url: `/v1/sessions/${dedicated}` })).body.state).toBe('running');
    const again = await attempt(url);
    expect(again.status).toBe(101);
    if ('ws' in again) again.ws.close();
    const fresh = (await h.call({ method: 'GET', url: `/v1/sessions/${dedicated}` })).body.connectUrls.cdp as string;
    const viaFresh = await attempt(new URL(fresh).pathname + new URL(fresh).search);
    expect(viaFresh.status).toBe(101);
    if ('ws' in viaFresh) viaFresh.ws.close();
  });

  test('nœud injoignable : la connexion du client est fermée 1011', async () => {
    const lonely = await createHarness({ nodeUrl: 'http://127.0.0.1:1', tokens, relay: { nodeToken: NODE_TOKEN } });
    try {
      await lonely.app.listen({ host: '127.0.0.1', port: 0 });
      const id = (await lonely.call({ method: 'POST', url: '/v1/sessions', body: {} })).body.id as string;
      const port = (lonely.app.server.address() as AddressInfo).port;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/sessions/${id}/cdp?token=${token(id, 'cdp')}`);
      const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
      expect(code).toBe(1011);
    } finally {
      await lonely.close();
    }
  });

  test('requête HTTP ordinaire (sans upgrade) sur la route WebSocket : 426 refusé, aucun relais', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${base.replace('ws', 'http')}/v1/sessions/${dedicated}/cdp?token=${token(dedicated, 'cdp')}`, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect([400, 404, 426]).toContain(status);
  });
});

describe('découverte json/version (F5, tâche 2.8)', () => {
  const discover = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base.replace('ws', 'http')}${path}`, { headers });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: { code: string } } };
  };

  test('jeton en query ou en Bearer : champs de Chromium, webSocketDebuggerUrl vers la passerelle avec un jeton NEUF de la même session', async () => {
    const variants: Record<string, string>[] = [{}, { authorization: `Bearer ${token(dedicated, 'cdp')}` }];
    for (const headers of variants) {
      const given = token(dedicated, 'cdp');
      const path = Object.keys(headers).length > 0 ? `/v1/sessions/${dedicated}/cdp/json/version` : `/v1/sessions/${dedicated}/cdp/json/version?token=${given}`;
      const res = await discover(path, headers);
      expect(res.status).toBe(200);
      const { webSocketDebuggerUrl, ...fields } = res.body;
      expect(fields).toEqual(NODE_VERSION);
      const ws = new URL(String(webSocketDebuggerUrl));
      expect(`${ws.protocol}//${ws.host}${ws.pathname}`).toBe(`wss://b.example.com/v1/sessions/${dedicated}/cdp`);
      const fresh = ws.searchParams.get('token') ?? '';
      expect(fresh).not.toBe(given);
      expect(tokens.verify(fresh, { sessionId: dedicated, protocol: 'cdp' }).ok).toBe(true);
      expect(String(webSocketDebuggerUrl)).not.toContain('piege');
    }
    expect(node.requests.at(-1)).toEqual({ path: `/internal/sessions/${dedicated}/cdp/json/version`, authorization: `Bearer ${NODE_TOKEN}` });
  });

  test('audit 5.3 S14 (assert_access_authenticated) : la découverte par jeton ne prolonge jamais ce jeton ; par clé d’API : durée normale', async () => {
    const given = token(dedicated, 'cdp', 60);
    const res = await discover(`/v1/sessions/${dedicated}/cdp/json/version?token=${given}`);
    expect(res.status).toBe(200);
    const fresh = new URL(String(res.body.webSocketDebuggerUrl)).searchParams.get('token') ?? '';
    const givenCheck = tokens.verify(given, { sessionId: dedicated, protocol: 'cdp' });
    const freshCheck = tokens.verify(fresh, { sessionId: dedicated, protocol: 'cdp' });
    expect(freshCheck.ok && givenCheck.ok && freshCheck.expiresAt.getTime() <= givenCheck.expiresAt.getTime()).toBe(true);
    const viaKey = await discover(`/v1/sessions/${dedicated}/cdp/json/version`, { authorization: `Bearer ${h.keys.a}` });
    const keyFresh = tokens.verify(new URL(String(viaKey.body.webSocketDebuggerUrl)).searchParams.get('token') ?? '', { sessionId: dedicated, protocol: 'cdp' });
    expect(keyFresh.ok && keyFresh.expiresAt.getTime() - now).toBeGreaterThan(200_000);
  });

  test('sans jeton, jeton d’une autre session : 401 ; session shared : 409 protocol_not_served ; 0 requête vers le nœud', async () => {
    const before = node.requests.length;
    expect((await discover(`/v1/sessions/${dedicated}/cdp/json/version`)).status).toBe(401);
    expect((await discover(`/v1/sessions/${dedicated}/cdp/json/version?token=${token(shared, 'cdp')}`)).status).toBe(401);
    const sharedRes = await discover(`/v1/sessions/${shared}/cdp/json/version?token=${token(shared, 'cdp')}`);
    expect(sharedRes.status).toBe(409);
    expect(sharedRes.body.error?.code).toBe('protocol_not_served');
    expect(node.requests.length).toBe(before);
  });
});
