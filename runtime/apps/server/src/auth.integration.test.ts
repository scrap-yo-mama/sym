// SPDX-License-Identifier: AGPL-3.0-only
// Auth noyau (tâche 0.3b, 13 § 4-9) sur base réelle : démarrage, assistant, sessions hachées, clés d'API, audit.
import { createHash } from 'node:crypto';
import { generateMasterKey, passwordHashParams } from '@runtime/core';
import { migrateUp } from '@runtime/db';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, withClient } from '../../../tests/helpers/pg.js';
import {
  createKey,
  createUser,
  PUBLIC_URL,
  runSetup,
  serverEnv,
  sessionCookie,
  signIn,
  startTestServer,
  type TestServer,
  type TestUser,
} from '../../../tests/helpers/server.js';
import { ROUTES } from './routes/registry.js';
import { prepareServer } from './start.js';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

async function auditRows(srv: TestServer, action: string) {
  return withClient(srv.db.url, async (c) =>
    (await c.query<{ actor_user_id: string | null; outcome: string; target_id: string | null; meta: Record<string, unknown> }>(
      'SELECT actor_user_id, outcome, target_id, meta FROM audit_events WHERE action = $1 ORDER BY id',
      [action],
    )).rows,
  );
}

/** Toutes les valeurs texte de toutes les tables publiques, concaténées (recherche d'un secret en clair). */
async function wholeDatabaseText(url: string): Promise<string> {
  return withClient(url, async (c) => {
    const { rows } = await c.query<{ t: string }>(
      "SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition",
    );
    let out = '';
    for (const { t } of rows) out += (await c.query<{ x: string | null }>(`SELECT string_agg(to_jsonb(r)::text, '\n') AS x FROM ${t} r`)).rows[0]?.x ?? '';
    return out;
  });
}

describe('démarrage (13 § 4, 14 § 7)', () => {
  test('premier démarrage sans ADMIN_BOOTSTRAP_TOKEN : refus clair, aucune route ouverte', async () => {
    const db = await createTestDatabase('noboot');
    try {
      await migrateUp({ connectionString: db.url });
      await expect(prepareServer(serverEnv(db.url, generateMasterKey(), null))).rejects.toThrow(/premier démarrage sans ADMIN_BOOTSTRAP_TOKEN/);
    } finally {
      await db.drop();
    }
  });

  test('keyCheck avant d’écouter : une autre MASTER_KEY est refusée avec un message clair', async () => {
    const db = await createTestDatabase('keyck');
    try {
      await migrateUp({ connectionString: db.url });
      const token = 'zz_test_' + 'x'.repeat(40);
      const first = await prepareServer(serverEnv(db.url, generateMasterKey(), token));
      await first.close();
      await expect(prepareServer(serverEnv(db.url, generateMasterKey(), token))).rejects.toThrow(/MASTER_KEY ne correspond pas à cette base/);
    } finally {
      await db.drop();
    }
  });

  test('schéma pas à jour : démarrage en mode dégradé (14 § 5), aucune route hors sondes, `/api/ready` = 503', async () => {
    const db = await createTestDatabase('noschema');
    try {
      const started = await prepareServer(serverEnv(db.url, generateMasterKey(), 'zz_test_' + 'y'.repeat(40)), { schemaPollMs: 60_000 });
      try {
        expect((await started.app.inject({ method: 'GET', url: '/api/ready' })).statusCode).toBe(503);
        expect((await started.app.inject({ method: 'GET', url: '/api/auth/get-session' })).statusCode).toBe(503);
      } finally {
        await started.close();
      }
    } finally {
      await db.drop();
    }
  });
});

describe('assistant de premier démarrage', () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startTestServer('setup');
  });
  afterAll(async () => {
    await srv.close();
  });

  test('avant l’owner : 503 partout sauf santé, disponibilité et /api/setup', async () => {
    expect((await srv.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    expect((await srv.app.inject({ method: 'GET', url: '/api/ready' })).statusCode).toBe(200);
    for (const route of ROUTES.filter((r) => !r.beforeInit)) {
      const res = await srv.app.inject({ method: route.method, url: route.url.replace(':id', '00000000-0000-0000-0000-000000000000'), payload: route.method === 'GET' || route.method === 'DELETE' ? undefined : {} });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(503);
    }
  });

  test('assert_bootstrap_once : mauvais jeton refusé et audité, bon jeton crée l’owner, second passage 404', async () => {
    const bad = await srv.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: 'zz_test_wrong_token_value_0123456789', email: 'zz_test_owner@example.test', password: 'zz_test_long_password' },
    });
    expect(bad.statusCode).toBe(403);
    expect((await auditRows(srv, 'setup.attempt')).map((r) => r.outcome)).toEqual(['denied']);

    const weak = await srv.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: srv.bootstrapToken, email: 'zz_test_owner@example.test', password: 'password1234' },
    });
    expect(weak.statusCode).toBe(400);

    const res = await srv.app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { 'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8' },
      payload: { token: srv.bootstrapToken, email: 'zz_test_owner@example.test', password: 'zz_test_long_password_ok' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ userId: string; keyFingerprint: string; reminder: string }>();
    expect(body.keyFingerprint).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(body.reminder).toMatch(/MASTER_KEY/);
    expect(res.body).not.toContain(srv.bootstrapToken);
    expect(await auditRows(srv, 'setup.owner_created')).toEqual([expect.objectContaining({ actor_user_id: body.userId, outcome: 'success' })]);
    // Langue du navigateur de l'assistant retenue pour l'owner (F-20261001-UX01) : sans elle, `users.locale` vaudrait `en` et
    // écraserait la langue du navigateur à la connexion.
    const owner = await withClient(srv.db.url, async (c) => (await c.query<{ locale: string }>("SELECT locale FROM users WHERE role = 'owner'")).rows);
    expect(owner).toEqual([{ locale: 'fr' }]);

    const again = await srv.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: srv.bootstrapToken, email: 'zz_test_other@example.test', password: 'zz_test_long_password_ok' },
    });
    expect(again.statusCode).toBe(404);
    const owners = await withClient(srv.db.url, async (c) => (await c.query("SELECT email FROM users WHERE role = 'owner'")).rows);
    expect(owners).toEqual([{ email: 'zz_test_owner@example.test' }]);
    // Le jeton n'est stocké nulle part.
    expect(await wholeDatabaseText(srv.db.url)).not.toContain(srv.bootstrapToken);
  });
});

describe('sessions et clés d’API', () => {
  let srv: TestServer;
  let owner: TestUser;
  let member: TestUser;
  beforeAll(async () => {
    srv = await startTestServer('auth');
    owner = await runSetup(srv);
    member = await createUser(srv, 'zz_test_member@example.test');
  });
  afterAll(async () => {
    await srv.close();
  });

  test('assert_auth_baseline : hash argon2id aux paramètres cibles, connexion auditée', async () => {
    const stored = await withClient(srv.db.url, async (c) =>
      (await c.query<{ password_hash: string }>('SELECT password_hash FROM auth_accounts WHERE user_id = $1', [owner.id])).rows[0]!.password_hash,
    );
    expect(stored.startsWith('$argon2id$v=19$')).toBe(true);
    expect(passwordHashParams(stored)).toEqual({ memory: 19_456, passes: 2, parallelism: 1 });
    await signIn(srv, owner);
    expect((await auditRows(srv, 'auth.login')).at(-1)).toMatchObject({ actor_user_id: owner.id, outcome: 'success' });
  });

  test('échec de connexion : 401, audité, sans l’adresse ni le mot de passe dans meta', async () => {
    const res = await srv.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: PUBLIC_URL },
      payload: { email: member.email, password: 'zz_test_wrong_password' },
    });
    expect(res.statusCode).toBe(401);
    const row = (await auditRows(srv, 'auth.login_failed')).at(-1);
    expect(row).toMatchObject({ actor_user_id: member.id, outcome: 'denied' });
    expect(JSON.stringify(row?.meta)).not.toMatch(/zz_test_wrong_password|zz_test_member/);
  });

  test('jeton de session : seule son empreinte SHA-256 est en base, jamais le jeton', async () => {
    const res = await srv.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: PUBLIC_URL },
      payload: { email: member.email, password: member.password },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('token');
    const cookie = sessionCookie(res);
    const token = decodeURIComponent(cookie.split('=').slice(1).join('=')).split('.')[0]!;
    expect(token.length).toBeGreaterThanOrEqual(32);
    const hashes = await withClient(srv.db.url, async (c) =>
      (await c.query<{ token_hash: string }>('SELECT token_hash FROM auth_sessions WHERE user_id = $1', [member.id])).rows.map((r) => r.token_hash),
    );
    expect(hashes).toContain(sha256(token));
    expect(await wholeDatabaseText(srv.db.url)).not.toContain(token);
    // Le cookie fonctionne (recherche par empreinte) ; la déconnexion supprime la session.
    const me = await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: member.id, role: 'member', via: 'ui' });
    const out = await srv.app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: { cookie, origin: PUBLIC_URL }, payload: {} });
    expect(out.statusCode).toBe(200);
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    expect((await auditRows(srv, 'auth.logout')).at(-1)).toMatchObject({ actor_user_id: member.id });
  });

  test('compte désactivé : connexion refusée et session existante rejetée', async () => {
    const user = await createUser(srv, 'zz_test_disabled@example.test');
    const cookie = await signIn(srv, user);
    await withClient(srv.db.url, (c) => c.query("UPDATE users SET status = 'disabled' WHERE id = $1", [user.id]));
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    const res = await srv.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: PUBLIC_URL },
      payload: { email: user.email, password: user.password },
    });
    expect(res.statusCode).not.toBe(200);
  });

  test('durée absolue dépassée : 401 et session supprimée', async () => {
    const cookie = await signIn(srv, member);
    await withClient(srv.db.url, (c) => c.query("UPDATE auth_sessions SET absolute_expires_at = now() - interval '1 second' WHERE user_id = $1", [member.id]));
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  test('assert_api_key_scopes : clé affichée une fois, SHA-256 en base, route hors scope → 403, révoquée ou expirée → 401', async () => {
    const cookie = await signIn(srv, member);
    const created = await createKey(srv, cookie, member, ['apis:read']);
    expect(created.key).toMatch(/^sy_live_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/);
    expect(created.key.startsWith(created.prefix)).toBe(true);
    const list = await srv.app.inject({ method: 'GET', url: '/api/api-keys', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(created.key);
    expect(list.body).not.toMatch(/key_hash|keyHash/);
    const text = await wholeDatabaseText(srv.db.url);
    expect(text).not.toContain(created.key);
    expect(text).toContain(sha256(created.key));

    const bearer = { authorization: `Bearer ${created.key}` };
    const me = await srv.app.inject({ method: 'GET', url: '/api/me', headers: bearer });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: member.id, via: 'apikey', scopes: ['apis:read'] });
    // Routes de gestion (api_keys:*, jamais accordable) : 403 et audit denied.
    expect((await srv.app.inject({ method: 'GET', url: '/api/api-keys', headers: bearer })).statusCode).toBe(403);
    expect((await auditRows(srv, 'access.denied')).at(-1)).toMatchObject({ actor_user_id: member.id, outcome: 'denied' });
    expect(await auditRows(srv, 'apikey.first_use')).toHaveLength(1);

    // Expirée → 401.
    await withClient(srv.db.url, (c) => c.query("UPDATE api_keys SET expires_at = now() - interval '1 second' WHERE id = $1", [created.id]));
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: bearer })).statusCode).toBe(401);
    await withClient(srv.db.url, (c) => c.query("UPDATE api_keys SET expires_at = now() + interval '1 day' WHERE id = $1", [created.id]));
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: bearer })).statusCode).toBe(200);

    // Révoquée → 401, révocation idempotente et auditée.
    const del = await srv.app.inject({ method: 'DELETE', url: `/api/api-keys/${created.id}`, headers: { cookie, origin: PUBLIC_URL } });
    expect(del.statusCode).toBe(204);
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: bearer })).statusCode).toBe(401);
    expect((await srv.app.inject({ method: 'DELETE', url: `/api/api-keys/${created.id}`, headers: { cookie, origin: PUBLIC_URL } })).statusCode).toBe(204);
    expect(await auditRows(srv, 'apikey.revoked')).toHaveLength(1);

    // Format invalide, clé inconnue → 401.
    for (const value of ['Bearer nope', `Bearer sy_live_AAAAAAAA_${'A'.repeat(43)}`, 'Basic abc']) {
      expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: value } })).statusCode).toBe(401);
    }
    // Aucun secret dans l'audit.
    const created2 = await auditRows(srv, 'apikey.created');
    expect(JSON.stringify(created2)).not.toContain(created.key);
    expect(created2.at(-1)?.meta).toMatchObject({ prefix: created.prefix, scopes: ['apis:read'] });
  });

  test('création de clé : ré-authentification exigée, scope non accordable refusé, Origin contrôlée', async () => {
    const cookie = await signIn(srv, member);
    const wrongPassword = await srv.app.inject({
      method: 'POST',
      url: '/api/api-keys',
      headers: { cookie, origin: PUBLIC_URL },
      payload: { label: 'zz_test', scopes: ['apis:read'], currentPassword: 'zz_test_not_the_password' },
    });
    expect(wrongPassword.statusCode).toBe(403);
    for (const scopes of [['users:invite'], ['settings:llm'], ['api_keys:write'], ['tunnel:pair']]) {
      const res = await srv.app.inject({
        method: 'POST',
        url: '/api/api-keys',
        headers: { cookie, origin: PUBLIC_URL },
        payload: { label: 'zz_test', scopes, currentPassword: member.password },
      });
      expect(res.statusCode, scopes.join()).toBe(400);
    }
    const foreignOrigin = await srv.app.inject({
      method: 'POST',
      url: '/api/api-keys',
      headers: { cookie, origin: 'https://evil.example' },
      payload: { label: 'zz_test', scopes: ['apis:read'], currentPassword: member.password },
    });
    expect(foreignOrigin.statusCode).toBe(403);
    const noOrigin = await srv.app.inject({
      method: 'POST',
      url: '/api/api-keys',
      headers: { cookie },
      payload: { label: 'zz_test', scopes: ['apis:read'], currentPassword: member.password },
    });
    expect(noOrigin.statusCode).toBe(403);
  });

  test('chemins de la bibliothèque hors liste blanche : 404 (inscription, admin, impersonation…)', async () => {
    for (const url of ['/api/auth/sign-up/email', '/api/auth/admin/impersonate-user', '/api/auth/list-sessions', '/api/auth/request-password-reset', '/api/auth/reset-password', '/api/auth/two-factor/enable']) {
      const res = await srv.app.inject({ method: 'POST', url, headers: { origin: PUBLIC_URL }, payload: {} });
      expect(res.statusCode, url).toBe(404);
    }
  });
});
