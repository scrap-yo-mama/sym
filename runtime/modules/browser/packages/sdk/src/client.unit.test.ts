// SPDX-License-Identifier: MIT
// SDK (cdc/sym-browser 04 § 10, tâche 3.4) contre un serveur bouchon : chemins, méthodes, corps et en-têtes de chaque
// appel REST (client généré depuis l'OpenAPI), erreurs typées (04 § 6), flux SSE (`events`), profils et fichiers,
// `await using`, contrôle de version de `connect()` avant toute WebSocket, `connectCDP()` refusé sur une session shared.
import type { ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { SymBrowser, SymBrowserError, type SessionEvent } from './index.js';
import { sendJson, startStubServer, type SeenRequest, type StubServer } from './testing/stub-server.js';

const ID = '6f1c0a52-3d1e-4c0b-9a52-2f0d9d7c1b11';
const VERSION = { product: 'sym-browser', api: '1', contract: '1.0.0', playwright: '1.63.0', chromium: '153.0.8010.12', platform: 'linux', minSdk: '1.0.0' };
const session = (over: Record<string, unknown> = {}) => ({
  id: ID,
  state: 'running',
  type: 'shared',
  connectUrls: { cdp: null, playwright: `ws://127.0.0.1:1/v1/sessions/${ID}/playwright?token=symt_x`, bidi: null },
  expiresAt: '2026-10-02T10:02:00.000Z',
  createdAt: '2026-10-02T10:00:00.000Z',
  metadata: {},
  ...over,
});

let stub: StubServer;
let symb: SymBrowser;

beforeAll(async () => {
  stub = await startStubServer();
  symb = new SymBrowser({ url: stub.url, apiKey: 'symb_test_key', releaseOnExit: false });
});
afterAll(async () => {
  await stub.close();
});
afterEach(() => {
  stub.requests.length = 0;
});

/** Routeur minimal : « MÉTHODE /chemin » → réponse. */
function route(table: Record<string, (req: SeenRequest, res: ServerResponse) => void>): void {
  stub.handle((req, res) => {
    const hit = table[`${req.method} ${req.path}`];
    if (hit) hit(req, res);
    else sendJson(res, 404, { error: { code: 'session_not_found', message: 'nf', retryable: false, what_to_do: 'x', requestId: 'r' } });
  });
}

describe('configuration', () => {
  test('url et apiKey lus dans SYMB_URL et SYMB_API_KEY si omis ; absents : erreur claire', () => {
    const saved = { url: process.env.SYMB_URL, key: process.env.SYMB_API_KEY };
    try {
      process.env.SYMB_URL = 'https://b.example.com/';
      process.env.SYMB_API_KEY = 'symb_env';
      expect(new SymBrowser({ releaseOnExit: false }).url).toBe('https://b.example.com');
      delete process.env.SYMB_URL;
      expect(() => new SymBrowser({ releaseOnExit: false })).toThrow(/SYMB_URL/);
      process.env.SYMB_URL = 'https://b.example.com';
      delete process.env.SYMB_API_KEY;
      expect(() => new SymBrowser({ releaseOnExit: false })).toThrow(/SYMB_API_KEY/);
    } finally {
      if (saved.url === undefined) delete process.env.SYMB_URL;
      else process.env.SYMB_URL = saved.url;
      if (saved.key === undefined) delete process.env.SYMB_API_KEY;
      else process.env.SYMB_API_KEY = saved.key;
    }
  });

  test('la clé ne figure jamais dans le message d’une erreur ni dans la représentation du client', () => {
    const client = new SymBrowser({ url: stub.url, apiKey: 'symb_secret_value', releaseOnExit: false });
    expect(JSON.stringify(client)).not.toContain('symb_secret_value');
    expect(String(Object.keys(client))).not.toContain('symb_secret_value');
  });
});

describe('sessions (client généré depuis l’OpenAPI)', () => {
  test('create : POST /v1/sessions, Bearer, JSON, Idempotency-Key et wait=false transmis', async () => {
    route({ 'POST /v1/sessions': (_req, res) => sendJson(res, 201, session()) });
    const created = await symb.sessions.create({ type: 'shared', timeoutSeconds: 120, metadata: { job: 'demo' } }, { idempotencyKey: 'cle-idem-1', wait: false });
    expect(created.id).toBe(ID);
    const [req] = stub.requests;
    expect(req?.headers.authorization).toBe('Bearer symb_test_key');
    expect(req?.headers['content-type']).toMatch(/^application\/json/);
    expect(req?.headers['idempotency-key']).toBe('cle-idem-1');
    expect(req?.query.get('wait')).toBe('false');
    expect(JSON.parse(req?.body ?? '')).toEqual({ type: 'shared', timeoutSeconds: 120, metadata: { job: 'demo' } });
    // La session rendue reste un objet `Session` sérialisable : les méthodes ajoutées ne sont pas énumérables.
    expect(JSON.parse(JSON.stringify(created))).toEqual(session());
  });

  test('get, list (filtres, metadata.{clé}, curseur), release, extend', async () => {
    route({
      [`GET /v1/sessions/${ID}`]: (_req, res) => sendJson(res, 200, session()),
      'GET /v1/sessions': (_req, res) => sendJson(res, 200, { data: [session()], nextCursor: 'c2' }),
      [`DELETE /v1/sessions/${ID}`]: (_req, res) => sendJson(res, 200, session({ state: 'ended', endReason: 'released', connectUrls: undefined })),
      [`POST /v1/sessions/${ID}/extend`]: (_req, res) => sendJson(res, 200, session()),
    });
    expect((await symb.sessions.get(ID)).state).toBe('running');
    const page = await symb.sessions.list({ state: 'running', type: 'shared', limit: 10, cursor: 'c1', metadata: { job: 'demo' } });
    expect(page.nextCursor).toBe('c2');
    expect(page.data).toHaveLength(1);
    const ended = await symb.sessions.release(ID);
    expect([ended.state, ended.endReason]).toEqual(['ended', 'released']);
    await symb.sessions.extend(ID, 60);
    const [, list, del, extend] = stub.requests;
    expect(Object.fromEntries(list?.query ?? [])).toEqual({ state: 'running', type: 'shared', limit: '10', cursor: 'c1', 'metadata.job': 'demo' });
    expect(del?.method).toBe('DELETE');
    expect(JSON.parse(extend?.body ?? '')).toEqual({ timeoutSeconds: 60 });
  });

  test('erreur typée (04 § 6) : code, statut, retryable, what_to_do, requestId, details, Retry-After', async () => {
    route({
      'POST /v1/sessions': (_req, res) =>
        sendJson(res, 429, { error: { code: 'quota_exceeded', message: 'Quota.', retryable: true, what_to_do: 'Attends.', requestId: 'req_9a', details: { limit: 2 } } }, { 'retry-after': '7' }),
    });
    const error = await symb.sessions.create({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SymBrowserError);
    expect(error).toMatchObject({ code: 'quota_exceeded', status: 429, retryable: true, whatToDo: 'Attends.', requestId: 'req_9a', details: { limit: 2 }, retryAfterSeconds: 7 });
    expect(String(error)).not.toContain('symb_test_key');
  });

  test('réponse non JSON ou réseau coupé : SymBrowserError sans code d’API', async () => {
    stub.handle((_req, res) => void res.writeHead(502, { 'content-type': 'text/html' }).end('<html>bad gateway</html>'));
    await expect(symb.sessions.get(ID)).rejects.toMatchObject({ name: 'SymBrowserError', status: 502, code: 'http_error' });
    const offline = new SymBrowser({ url: 'http://127.0.0.1:1', apiKey: 'k', releaseOnExit: false });
    await expect(offline.version()).rejects.toMatchObject({ name: 'SymBrowserError', code: 'network_error', retryable: true });
  });

  test('version() sans clé ; egress.get et egress.put', async () => {
    route({
      'GET /v1/version': (_req, res) => sendJson(res, 200, VERSION),
      [`GET /v1/sessions/${ID}/egress`]: (_req, res) => sendJson(res, 200, { epoch: 0, requests: 3, blocked: 1, bytesIn: 10, bytesOut: 5, budgetExceeded: false }),
      [`PUT /v1/sessions/${ID}/egress`]: (_req, res) => sendJson(res, 200, { epoch: 1, requests: 0, blocked: 0, bytesIn: 0, bytesOut: 0, budgetExceeded: false }),
    });
    expect(await symb.version()).toEqual(VERSION);
    expect(stub.requests[0]?.headers.authorization).toBeUndefined();
    expect((await symb.sessions.egress.get(ID)).blocked).toBe(1);
    expect((await symb.sessions.egress.put(ID, { allowedHosts: ['example.com'] })).epoch).toBe(1);
    expect(JSON.parse(stub.requests[2]?.body ?? '')).toEqual({ allowedHosts: ['example.com'] });
  });
});

describe('await using et release()', () => {
  test('la sortie du bloc libère la session (DELETE), une seule fois même après release() explicite', async () => {
    route({
      'POST /v1/sessions': (_req, res) => sendJson(res, 201, session()),
      [`DELETE /v1/sessions/${ID}`]: (_req, res) => sendJson(res, 200, session({ state: 'ended', endReason: 'released', connectUrls: undefined })),
    });
    {
      await using created = await symb.sessions.create({ type: 'shared' });
      expect(created.state).toBe('running');
    }
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /v1/sessions', `DELETE /v1/sessions/${ID}`]);
    stub.requests.length = 0;
    {
      await using created = await symb.sessions.create({ type: 'shared' });
      const ended = await created.release();
      expect(ended.state).toBe('ended');
    }
    expect(stub.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
  });

  test('close() libère toutes les sessions créées par ce client et encore vivantes', async () => {
    route({
      'POST /v1/sessions': (_req, res) => sendJson(res, 201, session()),
      [`DELETE /v1/sessions/${ID}`]: (_req, res) => sendJson(res, 200, session({ state: 'ended', endReason: 'released', connectUrls: undefined })),
    });
    const client = new SymBrowser({ url: stub.url, apiKey: 'k', releaseOnExit: false });
    await client.sessions.create({});
    await client.close();
    expect(stub.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
  });
});

describe('events() : flux SSE', () => {
  test('événements typés, données sur plusieurs lignes, commentaires ignorés, fin après un état terminal', async () => {
    stub.handle((req, res) => {
      expect(req.path).toBe(`/v1/sessions/${ID}/events`);
      expect(req.headers.accept).toBe('text/event-stream');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const at = '2026-10-02T10:00:01.000Z';
      res.write(': keepalive\n\n');
      res.write(`id: 1\nevent: state\ndata: {"type":"state","sessionId":"${ID}","at":"${at}",\ndata: "data":{"state":"running"}}\n\n`);
      res.write(`id: 2\nevent: egress.blocked\ndata: ${JSON.stringify({ type: 'egress.blocked', sessionId: ID, at, data: { host: 'x.test', reason: 'domain_not_allowed', count: 2 } })}\n\n`);
      res.write(`id: 3\nevent: state\ndata: ${JSON.stringify({ type: 'state', sessionId: ID, at, data: { state: 'ended', endReason: 'released' } })}\n\n`);
      // Le serveur garde le flux ouvert : l'itérateur doit s'arrêter seul après l'état terminal.
    });
    const seen: SessionEvent[] = [];
    for await (const event of symb.events(ID)) seen.push(event);
    expect(seen.map((e) => e.type)).toEqual(['state', 'egress.blocked', 'state']);
    expect(seen[1]).toMatchObject({ data: { host: 'x.test', count: 2 } });
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer symb_test_key');
  });

  test('reprise après coupure avec Last-Event-ID ; signal d’abandon respecté', async () => {
    let calls = 0;
    stub.handle((req, res) => {
      calls += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const at = '2026-10-02T10:00:01.000Z';
      if (calls === 1) {
        res.end(`id: 7\ndata: ${JSON.stringify({ type: 'state', sessionId: ID, at, data: { state: 'running' } })}\n\n`);
      } else {
        expect(req.headers['last-event-id']).toBe('7');
        res.write(`id: 8\ndata: ${JSON.stringify({ type: 'download', sessionId: ID, at, data: { id: 'f1', name: 'a.pdf', state: 'started', bytes: 0 } })}\n\n`);
      }
    });
    const controller = new AbortController();
    const seen: string[] = [];
    for await (const event of symb.events(ID, { signal: controller.signal, retryDelayMs: 10 })) {
      seen.push(event.type);
      if (event.type === 'download') controller.abort();
    }
    expect(seen).toEqual(['state', 'download']);
    expect(calls).toBe(2);
  });

  test('flux de toutes les sessions du client (GET /v1/events) ; erreur HTTP typée', async () => {
    stub.handle((_req, res) => sendJson(res, 403, { error: { code: 'forbidden', message: 'scope', retryable: false, what_to_do: 'x', requestId: 'r' } }));
    const iterator = symb.events()[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect(stub.requests[0]?.path).toBe('/v1/events');
  });
});

describe('profils et fichiers (04c § 4.4, § 5)', () => {
  test('routes, méthodes et corps', async () => {
    stub.handle((req, res) => {
      if (req.path.endsWith('/files/f1') && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="a.pdf"' });
        res.end(Buffer.from('%PDF-1.7'));
        return;
      }
      if (req.path.endsWith('/uploads')) return sendJson(res, 201, { id: 'u1', path: '/data/sessions/x/uploads/u1', size: 5, sha256: 'ab' });
      if (req.path.endsWith('/files')) return sendJson(res, 200, { data: [{ id: 'f1', name: 'a.pdf', size: 8, sha256: 'cd', createdAt: 'x', expiresAt: 'y' }] });
      sendJson(res, req.method === 'POST' && req.path === '/v1/profiles' ? 201 : 200, { id: 'p1', name: 'compte' });
    });
    await symb.profiles.create({ name: 'compte' });
    await symb.profiles.list();
    await symb.profiles.get('p1');
    await symb.profiles.import('p1', { cookies: [], origins: [] });
    await symb.profiles.storageState('p1');
    await symb.profiles.delete('p1');
    expect((await symb.files.list(ID)).data[0]?.name).toBe('a.pdf');
    const file = await symb.files.download(ID, 'f1');
    expect(Buffer.from(file.data).toString()).toBe('%PDF-1.7');
    expect(file.contentType).toBe('application/pdf');
    await symb.files.delete(ID, 'f1');
    const uploaded = await symb.files.upload(ID, { name: 'b.txt', data: new TextEncoder().encode('hello') });
    expect(uploaded.path).toMatch(/uploads/);
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /v1/profiles',
      'GET /v1/profiles',
      'GET /v1/profiles/p1',
      'POST /v1/profiles/p1/import',
      'GET /v1/profiles/p1/storage-state',
      'DELETE /v1/profiles/p1',
      `GET /v1/sessions/${ID}/files`,
      `GET /v1/sessions/${ID}/files/f1`,
      `DELETE /v1/sessions/${ID}/files/f1`,
      `POST /v1/sessions/${ID}/uploads`,
    ]);
    const upload = stub.requests.at(-1);
    expect(upload?.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(upload?.body).toContain('filename="b.txt"');
    expect(upload?.body).toContain('hello');
  });
});

describe('connect() et connectCDP()', () => {
  test('connect : version Playwright du serveur lue d’abord ; mineure différente → playwright_version_mismatch, aucune WebSocket', async () => {
    route({ 'GET /v1/version': (_req, res) => sendJson(res, 200, { ...VERSION, playwright: '1.62.0' }) });
    const client = new SymBrowser({ url: stub.url, apiKey: 'k', releaseOnExit: false });
    await expect(client.connect(session() as never)).rejects.toMatchObject({ code: 'playwright_version_mismatch' });
    expect(stub.requests.map((r) => r.path)).toEqual(['/v1/version']);
  });

  test('connectCDP sur une session shared : protocol_not_served sans connexion', async () => {
    await expect(symb.connectCDP(session() as never)).rejects.toMatchObject({ code: 'protocol_not_served' });
  });

  test('connect sur une session terminée : relue, puis erreur claire (session_not_running)', async () => {
    route({
      'GET /v1/version': (_req, res) => sendJson(res, 200, VERSION),
      [`GET /v1/sessions/${ID}`]: (_req, res) => sendJson(res, 200, session({ state: 'ended', endReason: 'timeout', connectUrls: undefined })),
    });
    await expect(symb.connect(ID)).rejects.toMatchObject({ code: 'session_not_running' });
  });
});
