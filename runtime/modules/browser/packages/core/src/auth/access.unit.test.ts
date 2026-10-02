// SPDX-License-Identifier: AGPL-3.0-only
// assert_access_authenticated (BINV7), tâche 2.1 : décision d'accès REST (clé d'API en `Authorization: Bearer`, scope requis)
// et décision d'ouverture d'une connexion (jeton de session en query ou en Bearer, clé d'API en Bearer), prises avant tout
// contact avec un navigateur. Le relais WSS (2.3) et l'API REST (2.2) appellent ces deux fonctions.
// Complément BINV6 (assert_secrets_protected) : aucune clé ni aucun jeton dans les journaux.
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createLogger } from '../service/service.js';
import { generateMasterKey, MasterKey } from '../crypto/master-key.js';
import {
  ApiKeyAuthenticator,
  authorizeConnection,
  authorizeRequest,
  bearerOf,
  ConnectTokens,
  newApiKey,
  truncateCredential,
  type ApiKeyRecord,
  type ApiKeyStore,
  type ApiScope,
  type ConnectionDeps,
  type SessionAccess,
} from './index.js';

class MemoryStore implements ApiKeyStore {
  readonly rows = new Map<string, ApiKeyRecord>();
  async findByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    return this.rows.get(prefix) ?? null;
  }
  async touch(): Promise<void> {}
}

type Fixture = { store: MemoryStore; auth: ApiKeyAuthenticator; key: (name: string) => string };

async function fixture(keys: Record<string, { tenantId: string; scopes: ApiScope[]; expiresAt?: Date | null; revokedAt?: Date | null }>): Promise<Fixture> {
  const store = new MemoryStore();
  const clear = new Map<string, string>();
  for (const [name, spec] of Object.entries(keys)) {
    const created = await newApiKey({ scopes: spec.scopes });
    store.rows.set(created.prefix, {
      id: `id-${name}`, tenantId: spec.tenantId, keyHash: created.keyHash, scopes: created.scopes,
      expiresAt: spec.expiresAt ?? null, revokedAt: spec.revokedAt ?? null, lastUsedAt: null,
    });
    clear.set(name, created.key.reveal());
  }
  return { store, auth: new ApiKeyAuthenticator(store), key: (name) => clear.get(name)! };
}

const past = () => new Date(Date.now() - 1000);

describe('assert_access_authenticated (BINV7) : REST, clé d’API en Bearer', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture({
      writer: { tenantId: 'tA', scopes: ['sessions:write', 'sessions:read'] },
      reader: { tenantId: 'tA', scopes: ['sessions:read'] },
      expired: { tenantId: 'tA', scopes: ['sessions:write', 'sessions:read'], expiresAt: past() },
      revoked: { tenantId: 'tA', scopes: ['sessions:write', 'sessions:read'], revokedAt: past() },
    });
  });

  test('bearerOf : schéma Bearer insensible à la casse, une seule valeur ; sinon null', () => {
    expect(bearerOf('Bearer abc')).toBe('abc');
    expect(bearerOf('bearer   abc')).toBe('abc');
    for (const bad of [undefined, '', 'Bearer', 'Bearer ', 'Basic abc', 'abc', 'Bearer a b', ['Bearer a', 'Bearer b']]) expect(bearerOf(bad), String(bad)).toBeNull();
  });

  test('clé valide avec le scope : principal', async () => {
    const decision = await authorizeRequest(f.auth, { authorization: `Bearer ${f.key('writer')}` }, 'sessions:write');
    expect(decision).toEqual({ ok: true, principal: { tenantId: 'tA', apiKeyId: 'id-writer', scopes: ['sessions:write', 'sessions:read'] } });
  });

  test.each([
    ['sans en-tête', () => ({})],
    ['schéma Basic', () => ({ authorization: `Basic ${Buffer.from('a:b').toString('base64')}` })],
    ['clé inconnue', () => ({ authorization: 'Bearer symb_AAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })],
    ['clé expirée', () => ({ authorization: `Bearer ${f.key('expired')}` })],
    ['clé révoquée', () => ({ authorization: `Bearer ${f.key('revoked')}` })],
    ['jeton de connexion à la place d’une clé', () => ({ authorization: `Bearer ${new ConnectTokens({ current: MasterKey.parse(generateMasterKey()) }).issue({ sessionId: randomUUID(), protocol: 'cdp' })}` })],
  ])('%s : 401 unauthorized', async (_label, headers) => {
    expect(await authorizeRequest(f.auth, headers(), 'sessions:read')).toMatchObject({ ok: false, status: 401, code: 'unauthorized' });
  });

  test('scope manquant : 403 forbidden avec le scope requis', async () => {
    expect(await authorizeRequest(f.auth, { authorization: `Bearer ${f.key('reader')}` }, 'sessions:write')).toEqual({
      ok: false, status: 403, code: 'forbidden', reason: 'missing_scope', requiredScope: 'sessions:write',
    });
  });

  describe('sur le fil (node:http) : clé expirée → 401', () => {
    let url = '';
    const server = createServer((req, res) => {
      void authorizeRequest(f.auth, req.headers, 'sessions:read').then((d) => {
        res.writeHead(d.ok ? 200 : d.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(d.ok ? { tenantId: d.principal.tenantId } : { error: { code: d.code } }));
      });
    });
    beforeAll(async () => {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/sessions`;
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const get = (authorization?: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(url, { headers: authorization ? { authorization } : {} }, (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
      });

    test('valide 200, expirée 401, révoquée 401, absente 401', async () => {
      expect((await get(`Bearer ${f.key('reader')}`)).status).toBe(200);
      const expired = await get(`Bearer ${f.key('expired')}`);
      expect(expired).toEqual({ status: 401, body: JSON.stringify({ error: { code: 'unauthorized' } }) });
      expect((await get(`Bearer ${f.key('revoked')}`)).status).toBe(401);
      expect((await get()).status).toBe(401);
    });
  });
});

describe('assert_access_authenticated (BINV7) : ouverture de connexion (Playwright, CDP, vue en direct)', () => {
  const master = MasterKey.parse(generateMasterKey());
  const tokens = new ConnectTokens({ current: master });
  const own = randomUUID();
  const other = randomUUID();
  const foreign = randomUUID();
  const ended = randomUUID();
  const sessions = new Map<string, SessionAccess>([
    [own, { tenantId: 'tA', state: 'running' }],
    [other, { tenantId: 'tA', state: 'running' }],
    [foreign, { tenantId: 'tB', state: 'running' }],
    [ended, { tenantId: 'tA', state: 'ended' }],
  ]);
  let f: Fixture;
  let deps: ConnectionDeps;
  const lookups: string[] = [];
  beforeAll(async () => {
    f = await fixture({
      writer: { tenantId: 'tA', scopes: ['sessions:write', 'sessions:read'] },
      reader: { tenantId: 'tA', scopes: ['sessions:read'] },
      expired: { tenantId: 'tA', scopes: ['sessions:write'], expiresAt: past() },
    });
    deps = {
      auth: f.auth,
      tokens,
      session: async (id) => {
        lookups.push(id);
        return sessions.get(id) ?? null;
      },
    };
  });

  test('jeton de session en query ou en Authorization: Bearer : accepté', async () => {
    const token = tokens.issue({ sessionId: own, protocol: 'cdp' });
    expect(await authorizeConnection(deps, { sessionId: own, protocol: 'cdp', query: { token } })).toMatchObject({ ok: true, via: 'connect_token', tenantId: 'tA', expiresAt: expect.any(Date) });
    expect(await authorizeConnection(deps, { sessionId: own, protocol: 'cdp', headers: { authorization: `Bearer ${token}` } })).toMatchObject({ ok: true, via: 'connect_token', tenantId: 'tA', expiresAt: expect.any(Date) });
  });

  test('sans jeton : 401 avant toute lecture de session', async () => {
    lookups.length = 0;
    expect(await authorizeConnection(deps, { sessionId: own, protocol: 'playwright' })).toMatchObject({ ok: false, status: 401, reason: 'missing' });
    expect(await authorizeConnection(deps, { sessionId: own, protocol: 'playwright', query: { token: '' } })).toMatchObject({ ok: false, status: 401 });
    expect(lookups).toEqual([]);
  });

  test('jeton d’une autre session, d’un autre protocole, expiré ou falsifié : 401 avant toute lecture de session', async () => {
    lookups.length = 0;
    const forOther = tokens.issue({ sessionId: other, protocol: 'playwright' });
    expect(await authorizeConnection(deps, { sessionId: own, protocol: 'playwright', query: { token: forOther } })).toMatchObject({ ok: false, status: 401, reason: 'wrong_session' });
    const live = tokens.issue({ sessionId: own, protocol: 'live' });
    expect(await authorizeConnection(deps, { sessionId: own, protocol: 'cdp', query: { token: live } })).toMatchObject({ ok: false, status: 401, reason: 'wrong_protocol' });
    const stale = new ConnectTokens({ current: master }, { now: () => Date.now() - 301_000 }).issue({ sessionId: own, protocol: 'cdp' });
    expect(await authorizeConnection(deps, { sessionId: own, protocol: 'cdp', query: { token: stale } })).toMatchObject({ ok: false, status: 401, reason: 'expired' });
    const forged = new ConnectTokens({ current: MasterKey.parse(generateMasterKey()) }).issue({ sessionId: own, protocol: 'cdp' });
    expect(await authorizeConnection(deps, { sessionId: own, protocol: 'cdp', query: { token: forged } })).toMatchObject({ ok: false, status: 401, reason: 'bad_signature' });
    expect(lookups).toEqual([]);
  });

  test('jeton valide d’une session terminée ou inconnue : 401', async () => {
    const token = tokens.issue({ sessionId: ended, protocol: 'cdp' });
    expect(await authorizeConnection(deps, { sessionId: ended, protocol: 'cdp', query: { token } })).toMatchObject({ ok: false, status: 401, reason: 'session_not_running' });
    const ghost = randomUUID();
    expect(await authorizeConnection(deps, { sessionId: ghost, protocol: 'cdp', query: { token: tokens.issue({ sessionId: ghost, protocol: 'cdp' }) } })).toMatchObject({ ok: false, status: 401, reason: 'session_not_found' });
  });

  test('clé d’API en Bearer : ouvre les sessions de son client selon ses scopes', async () => {
    const bearer = (name: string) => ({ authorization: `Bearer ${f.key(name)}` });
    expect(await authorizeConnection(deps, { sessionId: own, protocol: 'playwright', headers: bearer('writer') })).toEqual({ ok: true, via: 'api_key', tenantId: 'tA', apiKeyId: 'id-writer' });
    expect(await authorizeConnection(deps, { sessionId: foreign, protocol: 'playwright', headers: bearer('writer') })).toMatchObject({ ok: false, status: 401, reason: 'session_not_found' });
    expect(await authorizeConnection(deps, { sessionId: own, protocol: 'cdp', headers: bearer('reader') })).toMatchObject({ ok: false, status: 403, reason: 'missing_scope', requiredScope: 'sessions:write' });
    expect(await authorizeConnection(deps, { sessionId: own, protocol: 'live', headers: bearer('reader') })).toMatchObject({ ok: true, via: 'api_key' });
    expect(await authorizeConnection(deps, { sessionId: own, protocol: 'cdp', headers: bearer('expired') })).toMatchObject({ ok: false, status: 401, reason: 'expired' });
  });

  test('clé d’API dans l’URL : refusée (une clé ne voyage jamais en query)', async () => {
    expect(await authorizeConnection(deps, { sessionId: own, protocol: 'cdp', query: { token: f.key('writer') } })).toMatchObject({ ok: false, status: 401, reason: 'api_key_in_query' });
  });

  test('en-tête et query présents : l’en-tête fait foi (un en-tête invalide n’est pas rattrapé par la query)', async () => {
    const token = tokens.issue({ sessionId: own, protocol: 'cdp' });
    expect(await authorizeConnection(deps, { sessionId: own, protocol: 'cdp', headers: { authorization: `Bearer ${f.key('writer')}` }, query: { token } })).toMatchObject({ ok: true, via: 'api_key' });
    expect(await authorizeConnection(deps, { sessionId: own, protocol: 'cdp', headers: { authorization: 'Bearer symt_faux' }, query: { token } })).toMatchObject({ ok: false, status: 401 });
  });

  test('query en tableau (token répété) : refusée', async () => {
    const token = tokens.issue({ sessionId: own, protocol: 'cdp' });
    expect(await authorizeConnection(deps, { sessionId: own, protocol: 'cdp', query: { token: [token, token] } })).toMatchObject({ ok: false, status: 401, reason: 'malformed' });
  });
});

describe('assert_secrets_protected (BINV6) : clés et jetons hors des journaux', () => {
  test('createLogger masque clés d’API, jetons de connexion, Bearer et query token', async () => {
    const { key } = await newApiKey({ scopes: ['sessions:read'] });
    const token = new ConnectTokens({ current: MasterKey.parse(generateMasterKey()) }).issue({ sessionId: randomUUID(), protocol: 'cdp' });
    const lines: string[] = [];
    const log = createLogger('info', (line) => lines.push(line));
    log('info', `clé reçue ${key.reveal()} et jeton ${token}`, {
      url: `wss://b.example.com/v1/sessions/x/cdp?token=${token}`,
      headers: { authorization: `Bearer ${key.reveal()}` },
      key,
    });
    const out = lines.join('\n');
    expect(out).not.toContain(key.reveal());
    expect(out).not.toContain(token);
    expect(out).not.toContain(token.slice(5, 40));
    expect(out).toContain('[REDACTED]');
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });

  test('truncateCredential : préfixe affiché d’une clé, début d’un jeton, rien du secret', async () => {
    const created = await newApiKey({ scopes: ['sessions:read'] });
    expect(truncateCredential(created.key.reveal())).toBe(`${created.prefix}…`);
    const token = new ConnectTokens({ current: MasterKey.parse(generateMasterKey()) }).issue({ sessionId: randomUUID(), protocol: 'cdp' });
    expect(truncateCredential(token)).toBe(`${token.slice(0, 9)}…`);
    expect(truncateCredential('quelconque-secret-de-40-caracteres-xxxxx')).toBe('…');
  });
});
