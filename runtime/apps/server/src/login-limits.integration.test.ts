// Relecture sym-security de 0.3b : débit de connexion (par IP réelle ET par compte), réponse d'échec uniforme,
// IP de session, re-hachage argon2, limite de ré-authentification, assistant limité par IP (13 § 4-5, ASVS 6.1.1, 6.3.8).
import { hashPassword, passwordHashParams } from '@runtime/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { withClient } from '../../../tests/helpers/pg.js';
import { createUser, PUBLIC_URL, runSetup, signIn, startTestServer, type TestServer } from '../../../tests/helpers/server.js';

let srv: TestServer;
beforeAll(async () => {
  srv = await startTestServer('limits');
  await runSetup(srv);
});
afterAll(async () => {
  await srv.close();
});

function login(email: string, password: string, remoteAddress: string, headers: Record<string, string> = {}) {
  return srv.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    remoteAddress,
    headers: { origin: PUBLIC_URL, ...headers },
    payload: { email, password },
  });
}

describe('assert_login_rate_limited : débit de /api/auth/sign-in/email', () => {
  test('X-Forwarded-For varié par le client ne contourne pas la limite par IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await login(`zz_test_nobody_${i}@example.test`, 'zz_test_wrong_pw', '198.51.100.10', { 'x-forwarded-for': `203.0.113.${i + 1}` });
      statuses.push(res.statusCode);
    }
    expect(statuses).toContain(429);
  });

  test('une IP qui s’épuise sans X-Forwarded-For ne bloque pas un utilisateur légitime d’une autre IP', async () => {
    const legit = await createUser(srv, 'zz_test_legit@example.test');
    for (let i = 0; i < 12; i += 1) await login(`zz_test_ghost_${i}@example.test`, 'zz_test_wrong_pw', '198.51.100.11');
    expect((await login('zz_test_ghost_x@example.test', 'zz_test_wrong_pw', '198.51.100.11')).statusCode).toBe(429);
    expect((await login(legit.email, legit.password, '198.51.100.21')).statusCode).toBe(200);
  });

  test('limite par compte : échecs répartis sur des IP différentes → 429 pour ce compte, pas pour un autre', async () => {
    const target = await createUser(srv, 'zz_test_target@example.test');
    const other = await createUser(srv, 'zz_test_other@example.test');
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await login(target.email, 'zz_test_wrong_pw', `192.0.2.${i + 1}`)).statusCode);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    // Adresse écrite autrement (casse, espaces) : même compte.
    expect((await login(` ${target.email.toUpperCase()} `, target.password, '192.0.2.200')).statusCode).toBe(429);
    expect((await login(other.email, other.password, '192.0.2.201')).statusCode).toBe(200);
  });
});

describe('réponses et état de session', () => {
  test('échec uniforme : compte désactivé + bon mot de passe = mauvais mot de passe = compte inconnu', async () => {
    const disabled = await createUser(srv, 'zz_test_off@example.test', 'member', 'disabled');
    const a = await login(disabled.email, disabled.password, '192.0.2.50');
    const b = await login(disabled.email, 'zz_test_wrong_pw', '192.0.2.51');
    const c = await login('zz_test_unknown@example.test', 'zz_test_wrong_pw', '192.0.2.52');
    expect(a.statusCode).toBe(401);
    expect([b.statusCode, c.statusCode]).toEqual([401, 401]);
    expect(a.json()).toEqual(b.json());
    expect(c.json()).toEqual(b.json());
    expect(b.json()).toMatchObject({ code: 'INVALID_EMAIL_OR_PASSWORD' });
  });

  test('auth_sessions.ip = IP de la connexion (request.ip), jamais un X-Forwarded-For du client', async () => {
    const user = await createUser(srv, 'zz_test_ip@example.test');
    const res = await login(user.email, user.password, '198.51.100.77', { 'x-forwarded-for': '203.0.113.99', 'x-real-ip': '203.0.113.98', forwarded: 'for=203.0.113.97' });
    expect(res.statusCode).toBe(200);
    const ips = await withClient(srv.db.url, async (c) => (await c.query('SELECT ip FROM auth_sessions WHERE user_id = $1', [user.id])).rows.map((r) => r.ip));
    expect(ips).toEqual(['198.51.100.77']);
  });

  test('re-hachage à la connexion si les paramètres argon2 ont changé', async () => {
    const user = await createUser(srv, 'zz_test_rehash@example.test');
    const old = await hashPassword(user.password, { memory: 8192, passes: 1, parallelism: 1, tagLength: 32 });
    await withClient(srv.db.url, (c) => c.query('UPDATE auth_accounts SET password_hash = $1 WHERE user_id = $2', [old, user.id]));
    expect((await login(user.email, user.password, '192.0.2.60')).statusCode).toBe(200);
    const stored = await withClient(srv.db.url, async (c) =>
      (await c.query<{ password_hash: string }>('SELECT password_hash FROM auth_accounts WHERE user_id = $1', [user.id])).rows[0]!.password_hash,
    );
    expect(passwordHashParams(stored)).toEqual({ memory: 19_456, passes: 2, parallelism: 1 });
    expect((await login(user.email, user.password, '192.0.2.61')).statusCode).toBe(200);
  });

  test('ré-authentification de création de clé : 429 après le seuil, puis session révoquée', async () => {
    const user = await createUser(srv, 'zz_test_reauth@example.test');
    const cookie = await signIn(srv, user);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await srv.app.inject({
        method: 'POST',
        url: '/api/api-keys',
        headers: { cookie, origin: PUBLIC_URL },
        payload: { label: 'zz_test', scopes: ['apis:read'], currentPassword: 'zz_test_wrong_pw' },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 4)).toEqual([403, 403, 403, 403]);
    expect(statuses[4]).toBe(429);
    // Session fermée au seuil : les requêtes suivantes ne sont plus authentifiées.
    expect(statuses[5]).toBe(401);
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });
});

describe('assistant : limite par IP réelle', () => {
  test('5 jetons faux d’une IP → 429 même en variant X-Forwarded-For ; une autre IP termine l’assistant', async () => {
    const fresh = await startTestServer('setuplimit');
    try {
      const attempt = (remoteAddress: string, token: string, xff?: string) =>
        fresh.app.inject({
          method: 'POST',
          url: '/api/setup',
          remoteAddress,
          headers: xff ? { 'x-forwarded-for': xff } : {},
          payload: { token, email: 'zz_test_owner@example.test', password: 'zz_test_long_password_ok' },
        });
      for (let i = 0; i < 5; i += 1) expect((await attempt('198.51.100.40', `zz_test_wrong_token_${i}_000000000000000`)).statusCode).toBe(403);
      expect((await attempt('198.51.100.40', 'zz_test_wrong_token_x_000000000000000', '203.0.113.5')).statusCode).toBe(429);
      expect((await attempt('198.51.100.41', fresh.bootstrapToken)).statusCode).toBe(201);
    } finally {
      await fresh.close();
    }
  });
});
