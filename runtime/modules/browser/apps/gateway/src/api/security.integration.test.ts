// SPDX-License-Identifier: AGPL-3.0-only
// Audit de sécurité 5.3 (docs/audit-securite.md) : passerelle, sur la base réelle (banc de 2.2) et un nœud simulé.
// - S09 (BINV7, assert_access_authenticated) : une clé `sessions:read` lit la session mais ne reçoit aucun moyen de la
//   piloter (`connectUrls`) ; la vue en direct en lecture seule reste servie.
// - S10 (BINV6, assert_secrets_protected) : aucun jeton de connexion ni de vue au repos dans `idempotency_keys` ; un rejeu
//   rend des jetons neufs et valides.
// - S11 (BINV6, assert_secrets_protected) : en-têtes HTTP et `storageState` de la demande jamais en clair dans
//   `sessions.options` ; le nœud les reçoit intacts.
// - S12 : en-têtes de sécurité sur chaque réponse (nosniff, aucune référence, aucun cadre).
// - S13 : relais WSS vers un nœud muet : messages en attente bornés (1008), rien ne s'accumule en mémoire.
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { LiveTokens, MasterKey } from '@sym-browser/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { createHarness, type Harness } from '../../test/helpers/harness.js';

const NODE_TOKEN = 'nodetoken-'.repeat(4);
const sockets = new Set<Socket>();
const silent = createTcpServer((socket) => {
  sockets.add(socket);
  socket.on('error', () => undefined);
});
let h: Harness;
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const liveTokens = new LiveTokens(MasterKey.generate());
  h = await createHarness({ nodeUrl: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`, relay: { nodeToken: NODE_TOKEN, cdpMaxMessageBytes: 1024, liveTokens } });
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  base = `ws://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await h?.close();
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => silent.close(() => resolve()));
});

describe('audit 5.3 S09 : assert_access_authenticated, une clé de lecture ne pilote pas', () => {
  test('GET et liste avec sessions:read : pas de connectUrls ; liveViewUrl (lecture seule) servie ; sessions:write : connectUrls', async () => {
    const id = (await h.call({ method: 'POST', url: '/v1/sessions', body: {} })).body.id as string;
    const read = await h.call({ method: 'GET', url: `/v1/sessions/${id}`, key: 'aRead' });
    expect(read.status).toBe(200);
    expect(read.body.state).toBe('running');
    expect(read.body.connectUrls).toBeUndefined();
    expect(read.body.liveViewUrl).toMatch(/\/live\?t=/);
    const listed = await h.call({ method: 'GET', url: '/v1/sessions?state=running', key: 'aRead' });
    for (const s of listed.body.data) expect(s.connectUrls).toBeUndefined();
    expect((await h.call({ method: 'GET', url: `/v1/sessions/${id}` })).body.connectUrls.cdp).toMatch(/token=symt_/);
  });
});

describe('audit 5.3 S10 : assert_secrets_protected, Idempotency-Key sans jeton au repos', () => {
  test('aucun symt_ ni t= dans idempotency_keys ; rejeu : jetons neufs de la même session', async () => {
    const headers = { 'idempotency-key': 'zz_test_idem_0001' };
    const first = await h.call({ method: 'POST', url: '/v1/sessions', body: { metadata: { k: 'v' } }, headers });
    expect(first.status).toBe(201);
    const stored = (await h.pool.query<{ body: string }>('SELECT response_body::text AS body FROM idempotency_keys')).rows.map((r) => r.body ?? '').join('\n');
    expect(stored).not.toMatch(/symt_|[?&]t=/);
    const replay = await h.call({ method: 'POST', url: '/v1/sessions', body: { metadata: { k: 'v' } }, headers });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);
    const tokenOf = (url: string) => new URL(url).searchParams.get('token') ?? '';
    expect(tokenOf(replay.body.connectUrls.cdp)).toMatch(/^symt_/);
    expect(h.tokens.verify(tokenOf(replay.body.connectUrls.cdp), { sessionId: first.body.id, protocol: 'cdp' })).toMatchObject({ ok: true });
  });
});

describe('audit 5.3 S11 : assert_secrets_protected, options sensibles jamais en clair en base', () => {
  test('extraHTTPHeaders et storageState masqués dans sessions.options ; le nœud reçoit les valeurs', async () => {
    const body = {
      extraHTTPHeaders: { Authorization: 'Bearer zz_test_canary_header_77', 'X-Trace': 'visible' },
      storageState: { cookies: [{ name: 'sid', value: 'zz_test_canary_cookie_77', domain: 'fixtures.local', path: '/' }], origins: [{ origin: 'https://fixtures.local', localStorage: [{ name: 'k', value: 'zz_test_canary_storage_77' }] }] },
    };
    const res = await h.call({ method: 'POST', url: '/v1/sessions', body });
    expect(res.status).toBe(201);
    const row = (await h.pool.query<{ options: string }>('SELECT options::text AS options FROM sessions WHERE id = $1', [res.body.id])).rows[0]!;
    expect(row.options).not.toContain('zz_test_canary');
    expect(row.options).toContain('Authorization');
    const sent = h.launcher.requests.get(res.body.id)!.options;
    expect(JSON.stringify(sent)).toContain('zz_test_canary_header_77');
    expect(JSON.stringify(sent)).toContain('zz_test_canary_cookie_77');
  });
});

describe('audit 5.3 S12 : en-têtes de sécurité', () => {
  test.each([['GET', '/v1/version', null], ['GET', '/v1/sessions', 'a'], ['GET', '/v1/sessions', null]] as const)('%s %s (clé %s)', async (method, url, key) => {
    const res = await h.call({ method, url, key });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('audit 5.3 S13 : relais WSS vers un nœud muet', () => {
  test('messages en attente au-delà du plafond : fermeture 1008', async () => {
    const id = (await h.call({ method: 'POST', url: '/v1/sessions', body: {} })).body.id as string;
    const token = new URL((await h.call({ method: 'GET', url: `/v1/sessions/${id}` })).body.connectUrls.cdp).searchParams.get('token');
    const ws = new WebSocket(`${base}/v1/sessions/${id}/cdp?token=${encodeURIComponent(token ?? '')}`);
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => (ws.once('open', () => resolve()), ws.once('error', reject)));
    const message = JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'x'.repeat(900) } });
    for (let i = 0; i < 20; i += 1) ws.send(message);
    expect(await closed).toBe(1008);
  }, 20_000);
});
