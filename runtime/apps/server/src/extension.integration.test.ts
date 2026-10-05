// SPDX-License-Identifier: AGPL-3.0-only
// Extension (tâche 2.6, 07 § 1-2, INV5, INV8, INV10) côté instance, étage I1 : appairage multi-appareils, jetons
// (expiration, révocation par l'utilisateur et par l'admin), consentement par domaine, cookies en écriture seule,
// révocation d'un domaine (0 cookie en base), et résolution des cookies d'un run liée au propriétaire
// (assert_identity_pinned). Le parcours dans un vrai Chromium est dans apps/extension/e2e (étage E2).
import { kekFor, MasterKey, openSecret, siteSessionAad, type SiteCookie } from '@runtime/core';
import { decodePairingCode } from '@runtime/core/tunnel';
import { siteCookiesForRun, withActor } from '@runtime/db';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { withClient } from '../../../tests/helpers/pg.js';
import { createUser, PUBLIC_URL, runSetup, sessionCookie, startTestServer, type TestServer, type TestUser } from '../../../tests/helpers/server.js';

let srv: TestServer;
let admin: TestUser;
let adminCookie: string;

type Paired = { token: string; expiresAt: string; email: string };

const SHOP = 'zz-test-shop.example';

const sessions = new Map<string, string>();
let ipSeq = 0;
/** Connexion mise en cache, une adresse source par connexion (la limite de connexion par IP n'est pas l'objet ici). */
async function signIn(_srv: TestServer, user: Pick<TestUser, 'email' | 'password'>): Promise<string> {
  const cached = sessions.get(user.email);
  if (cached) return cached;
  ipSeq += 1;
  const res = await srv.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    remoteAddress: `198.51.100.${ipSeq}`,
    headers: { origin: PUBLIC_URL },
    payload: { email: user.email, password: user.password },
  });
  const cookie = sessionCookie(res);
  sessions.set(user.email, cookie);
  return cookie;
}

async function pairingCode(cookie: string, password: string): Promise<string> {
  const res = await srv.app.inject({ method: 'POST', url: '/api/extension/pairing-codes', headers: { cookie, origin: PUBLIC_URL }, payload: { currentPassword: password } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ code: string }>().code;
}

async function pair(code: string, deviceId: string, deviceLabel = 'zz_test_device') {
  return srv.app.inject({ method: 'POST', url: '/api/extension/pair', payload: { code, deviceId, deviceLabel } });
}

async function pairUser(user: TestUser, cookie: string, deviceId: string): Promise<Paired> {
  const res = await pair(await pairingCode(cookie, user.password), deviceId);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Paired>();
}

const ext = (token: string) => ({ authorization: `Bearer ${token}` });

async function extCall(token: string, method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  return srv.app.inject({ method, url, headers: ext(token), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
}

const cookie = (name: string, value: string, domain = SHOP, extra: Partial<SiteCookie> = {}): SiteCookie => ({
  name,
  value,
  domain,
  path: '/',
  secure: false,
  httpOnly: true,
  ...extra,
});

async function sql<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return withClient(srv.db.url, async (c) => (await c.query<T>(text, params)).rows);
}

async function siteRows(domain: string): Promise<{ owner_id: string; ciphertext: Buffer | null; server_use_allowed: boolean }[]> {
  return sql('SELECT owner_id, ciphertext, server_use_allowed FROM site_sessions WHERE domain = $1', [domain]);
}

/** KEK `site_sessions` du serveur de test (identité système côté worker). */
const kek = () => kekFor(MasterKey.parse(srv.masterKey), 1, 'site_sessions');

async function runFor(apiOwner: string, caller = apiOwner): Promise<string> {
  const api = (await sql<{ id: string }>("INSERT INTO apis (slug, owner_id, requires_session) VALUES ($1, $2, true) RETURNING id", [`zz_test_${Math.random().toString(36).slice(2)}`, apiOwner]))[0]!.id;
  const run = await sql<{ id: string }>(
    "INSERT INTO runs (api_id, owner_id, api_owner_id, trigger) VALUES ($1, $2, $3, 'rest') RETURNING id",
    [api, caller, apiOwner],
  );
  return run[0]!.id;
}

beforeAll(async () => {
  srv = await startTestServer('ext');
  await runSetup(srv);
  admin = await createUser(srv, 'zz_test_ext_admin@example.test', 'admin');
  adminCookie = await signIn(srv, admin);
});
afterAll(async () => {
  await srv.close();
});

describe('appairage (07 § 1)', () => {
  test('générer un code exige la ré-authentification ; une clé d’API ou l’absence de session est refusée', async () => {
    const user = await createUser(srv, 'zz_test_ext_reauth@example.test');
    const cookieU = await signIn(srv, user);
    const wrong = await srv.app.inject({ method: 'POST', url: '/api/extension/pairing-codes', headers: { cookie: cookieU, origin: PUBLIC_URL }, payload: { currentPassword: 'zz_test_wrong_password' } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toMatchObject({ error: { code: 'reauth_failed', message: expect.any(String) } });
    expect(wrong.body).not.toMatch(/"code":"[0-9A-Z]{5}-/);
    // Champ vide (F-20261001-UX01) : validation de schéma, code stable `invalid_request` que la console traduit ; aucun code créé.
    const empty = await srv.app.inject({ method: 'POST', url: '/api/extension/pairing-codes', headers: { cookie: cookieU, origin: PUBLIC_URL }, payload: { currentPassword: '' } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ error: { code: 'invalid_request', message: expect.any(String) } });
    const none = await srv.app.inject({ method: 'POST', url: '/api/extension/pairing-codes', payload: { currentPassword: user.password } });
    expect(none.statusCode).toBe(401);
  });

  test('assert_pairing_single_paste (instance) — le code en un collage porte l’adresse de l’instance ET le code ; coller ce code (adresse lue dedans) puis l’échanger appaire', async () => {
    const user = await createUser(srv, 'zz_test_ext_onepaste@example.test');
    const cookieU = await signIn(srv, user);
    const res = await srv.app.inject({ method: 'POST', url: '/api/extension/pairing-codes', headers: { cookie: cookieU, origin: PUBLIC_URL }, payload: { currentPassword: user.password } });
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json<{ code: string; pairingCode: string; expiresAt: string }>();
    expect(created.pairingCode.startsWith('sym-pair:v1:')).toBe(true);
    // Un seul texte : l'extension n'a plus d'URL à saisir.
    const decoded = decodePairingCode(created.pairingCode);
    expect(decoded).toEqual({ ok: true, url: new URL(PUBLIC_URL).origin, code: created.code });
    // Le code lu dans le collage est exactement celui que la route d'échange accepte, une seule fois.
    const paired = await pair((decoded as { code: string }).code, 'zz_test_dev_onepaste');
    expect(paired.statusCode, paired.body).toBe(201);
    expect((await pair(created.code, 'zz_test_dev_onepaste_2')).statusCode).toBe(400);
    // Route nommée par le CDC (snake_case) : même contenu.
    const named = await srv.app.inject({ method: 'POST', url: '/api/tunnel/pairing-code', headers: { cookie: cookieU, origin: PUBLIC_URL }, payload: { current_password: user.password } });
    expect(named.statusCode, named.body).toBe(201);
    const body = named.json<{ code: string; pairing_code: string; expires_at: string }>();
    expect(decodePairingCode(body.pairing_code)).toEqual({ ok: true, url: new URL(PUBLIC_URL).origin, code: body.code });
    // Le code en un collage n'est jamais écrit dans l'audit ni stocké : seule l'empreinte du code l'est.
    expect(JSON.stringify(await sql('SELECT * FROM extension_pairing_codes WHERE owner_id = $1', [user.id]))).not.toContain(created.pairingCode);
  });

  test('assert_pairing_code_single_use : code utilisé, expiré ou inconnu → refus, aucun jeton', async () => {
    const user = await createUser(srv, 'zz_test_ext_single@example.test');
    const cookieU = await signIn(srv, user);
    const code = await pairingCode(cookieU, user.password);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    // Le code n'est stocké qu'en empreinte.
    expect(JSON.stringify(await sql('SELECT * FROM extension_pairing_codes WHERE owner_id = $1', [user.id]))).not.toContain(code.replace('-', ''));
    const first = await pair(code.toLowerCase(), 'zz_test_dev_single_1');
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json<Paired>().email).toBe(user.email);
    const again = await pair(code, 'zz_test_dev_single_2');
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: { code: 'invalid_pairing_code', message: expect.any(String) } });

    const expired = await pairingCode(cookieU, user.password);
    await sql("UPDATE extension_pairing_codes SET expires_at = now() - interval '1 second' WHERE used_at IS NULL AND owner_id = $1", [user.id]);
    expect((await pair(expired, 'zz_test_dev_single_3')).statusCode).toBe(400);
    expect((await pair('ZZZZZ-ZZZZZ', 'zz_test_dev_single_4')).statusCode).toBe(400);
    // Un seul appareil a été appairé.
    expect(await sql('SELECT device_id FROM tunnels WHERE owner_id = $1', [user.id])).toEqual([{ device_id: 'zz_test_dev_single_1' }]);
  });

  test('plusieurs appareils pour un utilisateur ; ré-appairer un appareil remplace son ancien jeton', async () => {
    const user = await createUser(srv, 'zz_test_ext_multi@example.test');
    const cookieU = await signIn(srv, user);
    const laptop = await pairUser(user, cookieU, 'zz_test_dev_laptop');
    const desktop = await pairUser(user, cookieU, 'zz_test_dev_desktop');
    for (const t of [laptop, desktop]) {
      const me = await extCall(t.token, 'GET', '/api/extension/session');
      expect(me.statusCode).toBe(200);
      expect(me.json<{ email: string }>().email).toBe(user.email);
    }
    const laptop2 = await pairUser(user, cookieU, 'zz_test_dev_laptop');
    expect((await extCall(laptop.token, 'GET', '/api/extension/session')).statusCode).toBe(401);
    expect((await extCall(laptop2.token, 'GET', '/api/extension/session')).statusCode).toBe(200);
    expect((await extCall(desktop.token, 'GET', '/api/extension/session')).statusCode).toBe(200);
    const devices = await srv.app.inject({ method: 'GET', url: '/api/extension/devices', headers: { cookie: cookieU } });
    const items = devices.json<{ items: { revokedAt: string | null }[] }>().items;
    expect(items).toHaveLength(3);
    expect(items.filter((d) => d.revokedAt === null)).toHaveLength(2);
    // Aucun jeton ni empreinte dans les réponses.
    expect(devices.body).not.toMatch(/sy_ext_|token/i);
  });

  test('jeton : 90 jours renouvelés à l’usage ; au-delà, refus ; jeton hors des routes de l’extension → 401', async () => {
    const user = await createUser(srv, 'zz_test_ext_expiry@example.test');
    const t = await pairUser(user, await signIn(srv, user), 'zz_test_dev_expiry');
    const days = (iso: string) => (new Date(iso).getTime() - Date.now()) / 86_400_000;
    expect(days(t.expiresAt)).toBeGreaterThan(89.9);
    await sql("UPDATE tunnels SET expires_at = now() + interval '10 days' WHERE owner_id = $1", [user.id]);
    expect((await extCall(t.token, 'GET', '/api/extension/session')).statusCode).toBe(200);
    const renewed = (await sql<{ expires_at: Date }>('SELECT expires_at FROM tunnels WHERE owner_id = $1', [user.id]))[0]!.expires_at;
    expect(days(renewed.toISOString())).toBeGreaterThan(89.9);
    await sql("UPDATE tunnels SET expires_at = now() - interval '1 second' WHERE owner_id = $1", [user.id]);
    expect((await extCall(t.token, 'GET', '/api/extension/session')).statusCode).toBe(401);
    // Le jeton d'un appareil n'ouvre ni l'interface ni l'API REST.
    const t2 = await pairUser(user, await signIn(srv, user), 'zz_test_dev_expiry_2');
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: ext(t2.token) })).statusCode).toBe(401);
    expect((await srv.app.inject({ method: 'GET', url: '/api/sites', headers: ext(t2.token) })).statusCode).toBe(401);
  });

  test('révocation par l’utilisateur (console ou appareil) et par l’admin, qui ne lit jamais le jeton (assert_admin_revoke_only)', async () => {
    const user = await createUser(srv, 'zz_test_ext_revoke@example.test');
    const cookieU = await signIn(srv, user);
    const a1 = await pairUser(user, cookieU, 'zz_test_dev_rev_1');
    const a2 = await pairUser(user, cookieU, 'zz_test_dev_rev_2');
    const a3 = await pairUser(user, cookieU, 'zz_test_dev_rev_3');
    const ids = Object.fromEntries((await sql<{ id: string; device_id: string }>('SELECT id, device_id FROM tunnels WHERE owner_id = $1', [user.id])).map((r) => [r.device_id, r.id]));

    const own = await srv.app.inject({ method: 'DELETE', url: `/api/extension/devices/${ids['zz_test_dev_rev_1']}`, headers: { cookie: cookieU, origin: PUBLIC_URL } });
    expect(own.statusCode).toBe(204);
    expect((await extCall(a1.token, 'GET', '/api/extension/session')).statusCode).toBe(401);

    expect((await extCall(a2.token, 'DELETE', '/api/extension/session')).statusCode).toBe(204);
    expect((await extCall(a2.token, 'GET', '/api/extension/session')).statusCode).toBe(401);

    const list = await srv.app.inject({ method: 'GET', url: '/api/admin/tunnels', headers: { cookie: adminCookie } });
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain(user.email);
    expect(list.body).not.toMatch(/sy_ext_|token|hash/i);
    const member = await createUser(srv, 'zz_test_ext_member@example.test');
    const memberCookie = await signIn(srv, member);
    expect((await srv.app.inject({ method: 'GET', url: '/api/admin/tunnels', headers: { cookie: memberCookie } })).statusCode).toBe(403);
    expect((await srv.app.inject({ method: 'DELETE', url: `/api/admin/tunnels/${ids['zz_test_dev_rev_3']}`, headers: { cookie: memberCookie, origin: PUBLIC_URL } })).statusCode).toBe(403);
    // Même refus en base, sous le rôle des requêtes : un membre ne voit ni ne révoque l'appareil d'autrui.
    const pool = srv.started.ctx.pool;
    await expect(withActor(pool, { userId: member.id, role: 'member' }, (db) => db.query('SELECT * FROM admin_revoke_tunnel($1)', [ids['zz_test_dev_rev_3']]))).rejects.toMatchObject({ code: '42501' });
    expect((await withActor(pool, { userId: member.id, role: 'member' }, (db) => db.query('SELECT * FROM admin_tunnel_metadata'))).rowCount).toBe(0);
    const adminMeta = await withActor(pool, { userId: admin.id, role: 'admin' }, (db) => db.query('SELECT * FROM admin_tunnel_metadata'));
    expect(adminMeta.fields.map((f) => f.name)).not.toEqual(expect.arrayContaining(['token_hash']));
    const byAdmin = await srv.app.inject({ method: 'DELETE', url: `/api/admin/tunnels/${ids['zz_test_dev_rev_3']}`, headers: { cookie: adminCookie, origin: PUBLIC_URL } });
    expect(byAdmin.statusCode).toBe(204);
    expect((await extCall(a3.token, 'GET', '/api/extension/session')).statusCode).toBe(401);
    expect(await sql('SELECT revoked_by FROM tunnels WHERE id = $1', [ids['zz_test_dev_rev_3']])).toEqual([{ revoked_by: admin.id }]);
    // Un compte désactivé perd ses jetons et ses cookies serveur (13 § 10 : « 0 cookie de lui en base »).
    const t4 = await pairUser(user, cookieU, 'zz_test_dev_rev_4');
    expect((await extCall(t4.token, 'PUT', '/api/extension/sites/zz-test-disabled.example', { serverUseAllowed: true })).statusCode).toBe(201);
    expect((await extCall(t4.token, 'PUT', '/api/extension/sites/zz-test-disabled.example/cookies', { cookies: [cookie('sid', 'zz_test_disabled', 'zz-test-disabled.example')] })).statusCode).toBe(204);
    await sql("UPDATE users SET status = 'disabled' WHERE id = $1", [user.id]);
    expect((await extCall(t4.token, 'GET', '/api/extension/session')).statusCode).toBe(401);
    expect(await sql('SELECT count(*)::int AS n FROM site_sessions WHERE owner_id = $1 AND ciphertext IS NOT NULL', [user.id])).toEqual([{ n: 0 }]);
    expect(await sql('SELECT count(*)::int AS n FROM tunnels WHERE owner_id = $1 AND revoked_at IS NULL', [user.id])).toEqual([{ n: 0 }]);
  });
});

describe('consentement et cookies (07 § 2)', () => {
  let user: TestUser;
  let token: string;

  beforeAll(async () => {
    user = await createUser(srv, 'zz_test_ext_cookies@example.test');
    token = (await pairUser(user, await signIn(srv, user), 'zz_test_dev_cookies')).token;
  });

  test('assert_consent_before_capture (instance) : aucun cookie accepté pour un domaine non connecté', async () => {
    const res = await extCall(token, 'PUT', `/api/extension/sites/zz-test-unconnected.example/cookies`, { cookies: [cookie('sid', 'zz_test_canary_unconsented', 'zz-test-unconnected.example')] });
    expect(res.statusCode).toBe(404);
    expect(await siteRows('zz-test-unconnected.example')).toEqual([]);
  });

  test('assert_no_cookie_in_tunnel_mode : mode tunnel par défaut, 0 cookie accepté ni stocké', async () => {
    const connect = await extCall(token, 'PUT', `/api/extension/sites/zz-test-tunnel.example`, { serverUseAllowed: false });
    expect(connect.statusCode).toBe(201);
    expect(connect.json()).toMatchObject({ domain: 'zz-test-tunnel.example', serverUseAllowed: false, hasServerCookies: false });
    const res = await extCall(token, 'PUT', `/api/extension/sites/zz-test-tunnel.example/cookies`, { cookies: [cookie('sid', 'zz_test_canary_tunnel', 'zz-test-tunnel.example')] });
    expect(res.statusCode).toBe(409);
    expect(await siteRows('zz-test-tunnel.example')).toEqual([{ owner_id: user.id, ciphertext: null, server_use_allowed: false }]);
    expect(JSON.stringify(await sql('SELECT * FROM audit_events'))).not.toContain('zz_test_canary_tunnel');
  });

  test('usage serveur : cookies scellés, jamais relus par le rôle des requêtes, jamais dans l’audit ni une réponse', async () => {
    expect((await extCall(token, 'PUT', `/api/extension/sites/${SHOP}`, { serverUseAllowed: true })).statusCode).toBe(201);
    const stored = await extCall(token, 'PUT', `/api/extension/sites/${SHOP}/cookies`, {
      cookies: [cookie('sid', 'zz_test_canary_value_123'), cookie('pref', 'zz_test_canary_pref', `.${SHOP}`, { httpOnly: false })],
    });
    expect(stored.statusCode, stored.body).toBe(204);
    const row = (await sql<{ ciphertext: Buffer; nonce: Buffer; dek_wrapped: Buffer; alg: string; key_version: number }>(
      'SELECT ciphertext, nonce, dek_wrapped, alg, key_version FROM site_sessions WHERE owner_id = $1 AND domain = $2',
      [user.id, SHOP],
    ))[0]!;
    expect(row.alg).toBe('aes-256-gcm');
    expect(row.ciphertext.toString('latin1')).not.toContain('zz_test_canary');
    // Écriture seule : runtime_app (requêtes) ne lit pas les colonnes chiffrées.
    await expect(withActor(srv.started.ctx.pool, { userId: user.id, role: 'member' }, (db) => db.query('SELECT ciphertext FROM site_sessions'))).rejects.toMatchObject({ code: '42501' });
    const views = [
      await extCall(token, 'GET', '/api/extension/session'),
      await srv.app.inject({ method: 'GET', url: '/api/sites', headers: { cookie: await signIn(srv, user) } }),
    ];
    for (const v of views) {
      expect(v.statusCode).toBe(200);
      expect(v.body).toContain(SHOP);
      expect(v.body).not.toMatch(/zz_test_canary|ciphertext|nonce/);
    }
    expect(JSON.stringify(await sql('SELECT * FROM audit_events'))).not.toContain('zz_test_canary');
  });

  test('un cookie d’un autre domaine est refusé en bloc ; un domaine privé ou interne n’est jamais connecté (INV10)', async () => {
    const res = await extCall(token, 'PUT', `/api/extension/sites/${SHOP}/cookies`, { cookies: [cookie('sid', 'zz_test_x'), cookie('evil', 'zz_test_y', 'evil.example')] });
    expect(res.statusCode).toBe(400);
    for (const domain of ['localhost', '127.0.0.1', '169.254.169.254', '10.1.2.3', '192.168.1.1', 'printer.local', 'metadata.google.internal', 'intranet', '2130706433', 'zz-test.localhost']) {
      const r = await extCall(token, 'PUT', `/api/extension/sites/${encodeURIComponent(domain)}`, { serverUseAllowed: true });
      expect(r.statusCode, domain).toBe(400);
    }
    expect((await sql('SELECT domain FROM site_sessions WHERE owner_id = $1 ORDER BY domain', [user.id])).map((r) => r.domain)).toEqual([SHOP, 'zz-test-tunnel.example']);
  });

  test('repasser en mode tunnel efface les cookies stockés', async () => {
    const d = 'zz-test-toggle.example';
    await extCall(token, 'PUT', `/api/extension/sites/${d}`, { serverUseAllowed: true });
    expect((await extCall(token, 'PUT', `/api/extension/sites/${d}/cookies`, { cookies: [cookie('sid', 'zz_test_toggle', d)] })).statusCode).toBe(204);
    expect((await siteRows(d))[0]!.ciphertext).not.toBeNull();
    expect((await extCall(token, 'PUT', `/api/extension/sites/${d}`, { serverUseAllowed: false })).statusCode).toBe(200);
    expect(await siteRows(d)).toEqual([{ owner_id: user.id, ciphertext: null, server_use_allowed: false }]);
  });

  test('révocation d’un domaine (extension ou console) → 0 cookie en base pour ce domaine, run suivant en action_requise', async () => {
    const d = 'zz-test-revoke.example';
    await extCall(token, 'PUT', `/api/extension/sites/${d}`, { serverUseAllowed: true });
    await extCall(token, 'PUT', `/api/extension/sites/${d}/cookies`, { cookies: [cookie('sid', 'zz_test_revoke', d)] });
    const run = await runFor(user.id);
    expect((await withClient(srv.db.url, (c) => siteCookiesForRun(c, kek(), { runId: run, domain: d }))).ok).toBe(true);
    expect((await extCall(token, 'DELETE', `/api/extension/sites/${d}`)).statusCode).toBe(204);
    expect(await sql<{ n: number }>('SELECT count(*)::int AS n FROM site_sessions WHERE domain = $1', [d])).toEqual([{ n: 0 }]);
    expect(await withClient(srv.db.url, (c) => siteCookiesForRun(c, kek(), { runId: run, domain: d }))).toEqual({ ok: false, reason: 'auth_required' });

    // Depuis la console, par identifiant.
    await extCall(token, 'PUT', `/api/extension/sites/${d}`, { serverUseAllowed: true });
    await extCall(token, 'PUT', `/api/extension/sites/${d}/cookies`, { cookies: [cookie('sid', 'zz_test_revoke_2', d)] });
    const id = (await sql<{ id: string }>('SELECT id FROM site_sessions WHERE domain = $1', [d]))[0]!.id;
    const del = await srv.app.inject({ method: 'DELETE', url: `/api/sites/${id}`, headers: { cookie: await signIn(srv, user), origin: PUBLIC_URL } });
    expect(del.statusCode).toBe(204);
    expect(await sql<{ n: number }>('SELECT count(*)::int AS n FROM site_sessions WHERE domain = $1', [d])).toEqual([{ n: 0 }]);
  });
});

describe('assert_identity_pinned (INV5) : un run n’utilise que les cookies du propriétaire de l’API', () => {
  test('A et B connectés au même domaine : chacun ses cookies, jamais ceux de l’autre, sans repli', async () => {
    const domain = 'zz-test-pinned.example';
    const a = await createUser(srv, 'zz_test_pin_a@example.test');
    const b = await createUser(srv, 'zz_test_pin_b@example.test');
    const ta = (await pairUser(a, await signIn(srv, a), 'zz_test_dev_pin_a')).token;
    const tb = (await pairUser(b, await signIn(srv, b), 'zz_test_dev_pin_b')).token;
    for (const [t, v] of [[ta, 'zz_test_session_of_a'], [tb, 'zz_test_session_of_b']] as const) {
      expect((await extCall(t, 'PUT', `/api/extension/sites/${domain}`, { serverUseAllowed: true })).statusCode).toBe(201);
      expect((await extCall(t, 'PUT', `/api/extension/sites/${domain}/cookies`, { cookies: [cookie('sid', v, domain)] })).statusCode).toBe(204);
    }
    const resolve = (runId: string) => withClient(srv.db.url, (c) => siteCookiesForRun(c, kek(), { runId, domain }));

    const runA = await resolve(await runFor(a.id));
    expect(runA).toMatchObject({ ok: true, ownerId: a.id });
    expect(JSON.stringify(runA)).toContain('zz_test_session_of_a');
    expect(JSON.stringify(runA)).not.toContain('zz_test_session_of_b');
    const runB = await resolve(await runFor(b.id));
    expect(JSON.stringify(runB)).toContain('zz_test_session_of_b');
    expect(JSON.stringify(runB)).not.toContain('zz_test_session_of_a');

    // Un run dont l'appelant n'est pas le propriétaire de l'API : aucune session (ni celle de A, ni celle de B).
    expect(await resolve(await runFor(a.id, b.id))).toEqual({ ok: false, reason: 'auth_required' });

    // Clone de l'API de A vers C, qui n'a rien connecté : action_requise, jamais la session de A.
    const c = await createUser(srv, 'zz_test_pin_c@example.test');
    expect(await resolve(await runFor(c.id))).toEqual({ ok: false, reason: 'auth_required' });

    // Valeur de A recopiée sur la ligne de C (clonage forcé en base) : l'AAD (propriétaire, domaine) refuse l'ouverture.
    await sql(
      `INSERT INTO site_sessions (owner_id, domain, server_use_allowed, ciphertext, nonce, dek_wrapped, alg, key_version, captured_at)
       SELECT $2, domain, true, ciphertext, nonce, dek_wrapped, alg, key_version, now() FROM site_sessions WHERE owner_id = $1 AND domain = $3`,
      [a.id, c.id, domain],
    );
    expect(await resolve(await runFor(c.id))).toEqual({ ok: false, reason: 'auth_required' });

    // Le jeton de B n'agit que pour B : il ne déconnecte pas le domaine de A et ne choisit pas de propriétaire.
    expect((await extCall(tb, 'PUT', `/api/extension/sites/${domain}`, { serverUseAllowed: true, owner_id: a.id })).statusCode).toBe(400);
    expect((await extCall(tb, 'DELETE', `/api/extension/sites/${domain}`)).statusCode).toBe(204);
    expect(await sql('SELECT owner_id FROM site_sessions WHERE domain = $1 AND owner_id <> $2 ORDER BY owner_id', [domain, c.id])).toEqual([{ owner_id: a.id }]);
    expect(JSON.stringify(await resolve(await runFor(a.id)))).toContain('zz_test_session_of_a');
  });

  test('mode tunnel → tunnel_only (aucun cookie côté serveur) ; cookie expiré → cookie_expired', async () => {
    const u = await createUser(srv, 'zz_test_pin_modes@example.test');
    const t = (await pairUser(u, await signIn(srv, u), 'zz_test_dev_pin_modes')).token;
    await extCall(t, 'PUT', '/api/extension/sites/zz-test-modes-tunnel.example', { serverUseAllowed: false });
    await extCall(t, 'PUT', '/api/extension/sites/zz-test-modes-exp.example', { serverUseAllowed: true });
    const past = Math.floor(Date.now() / 1000) + 2;
    await extCall(t, 'PUT', '/api/extension/sites/zz-test-modes-exp.example/cookies', { cookies: [cookie('sid', 'zz_test_exp', 'zz-test-modes-exp.example', { expirationDate: past })] });
    const run = await runFor(u.id);
    expect(await withClient(srv.db.url, (c) => siteCookiesForRun(c, kek(), { runId: run, domain: 'zz-test-modes-tunnel.example' }))).toEqual({ ok: false, reason: 'tunnel_only' });
    await sql("UPDATE site_sessions SET expires_at = now() - interval '1 second' WHERE domain = 'zz-test-modes-exp.example'");
    expect(await withClient(srv.db.url, (c) => siteCookiesForRun(c, kek(), { runId: run, domain: 'zz-test-modes-exp.example' }))).toEqual({ ok: false, reason: 'cookie_expired' });
  });
});

describe('expiration des cookies : un cookie court ne fait pas expirer la session', () => {
  test('cookie court (_gat, __cf_bm) + cookie de session : run servi avec la session après l’expiration du cookie court', async () => {
    const u = await createUser(srv, 'zz_test_exp_short@example.test');
    const t = (await pairUser(u, await signIn(srv, u), 'zz_test_dev_exp_short')).token;
    const now = Math.floor(Date.now() / 1000);
    const [withSession, withLong] = ['zz-test-exp-session.example', 'zz-test-exp-long.example'];
    for (const d of [withSession, withLong]) expect((await extCall(t, 'PUT', `/api/extension/sites/${d}`, { serverUseAllowed: true })).statusCode).toBe(201);
    const short = (d: string) => cookie('_gat', 'zz_test_short', d, { expirationDate: now + 2 });
    expect((await extCall(t, 'PUT', `/api/extension/sites/${withSession}/cookies`, { cookies: [short(withSession), cookie('sid', 'zz_test_session_cookie', withSession)] })).statusCode).toBe(204);
    expect((await extCall(t, 'PUT', `/api/extension/sites/${withLong}/cookies`, { cookies: [short(withLong), cookie('sid', 'zz_test_long_cookie', withLong, { expirationDate: now + 86_400 })] })).statusCode).toBe(204);
    // expires_at = fin de la session entière : jamais (cookie de session) ou la plus tardive des dates.
    const rows = await sql<{ domain: string; expires_at: Date | null }>('SELECT domain, expires_at FROM site_sessions WHERE owner_id = $1 ORDER BY domain', [u.id]);
    expect(rows.find((r) => r.domain === withSession)!.expires_at).toBeNull();
    expect(rows.find((r) => r.domain === withLong)!.expires_at!.getTime()).toBe((now + 86_400) * 1000);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const run = await runFor(u.id);
    for (const [d, value] of [[withSession, 'zz_test_session_cookie'], [withLong, 'zz_test_long_cookie']] as const) {
      const got = await withClient(srv.db.url, (c) => siteCookiesForRun(c, kek(), { runId: run, domain: d }));
      expect(got).toMatchObject({ ok: true, cookies: [{ name: 'sid', value }] });
      expect(JSON.stringify(got)).not.toContain('zz_test_short');
    }
  });
});

describe('échange de code : limite par IP réellement tenue (10 échecs / 15 min)', () => {
  const pairFrom = (ip: string, code: string, deviceId: string) =>
    srv.app.inject({ method: 'POST', url: '/api/extension/pair', remoteAddress: ip, payload: { code, deviceId } });

  test('un succès intercalé ne remet pas le compteur à zéro', async () => {
    const u = await createUser(srv, 'zz_test_pair_limit@example.test');
    const cookieU = await signIn(srv, u);
    const ip = '203.0.113.71';
    for (let n = 0; n < 9; n += 1) expect((await pairFrom(ip, 'ZZZZZ-ZZZZZ', 'zz_test_dev_limit_x')).statusCode).toBe(400);
    expect((await pairFrom(ip, await pairingCode(cookieU, u.password), 'zz_test_dev_limit_1')).statusCode).toBe(201);
    expect((await pairFrom(ip, 'ZZZZZ-ZZZZZ', 'zz_test_dev_limit_x')).statusCode).toBe(400);
    // 10 échecs dans la fenêtre : même un code valide est refusé depuis cette IP.
    const blocked = await pairFrom(ip, await pairingCode(cookieU, u.password), 'zz_test_dev_limit_2');
    expect(blocked.statusCode).toBe(429);
  });

  test('rafale parallèle : au plus 10 échanges tentés, les autres refusés d’emblée', async () => {
    const ip = '203.0.113.72';
    const results = await Promise.all(Array.from({ length: 25 }, () => pairFrom(ip, 'ZZZZZ-ZZZZZ', 'zz_test_dev_burst')));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 400).length).toBeLessThanOrEqual(10);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(15);
  });

  test('codes actifs plafonnés par utilisateur', async () => {
    const u = await createUser(srv, 'zz_test_pair_codes_cap@example.test');
    const cookieU = await signIn(srv, u);
    for (let n = 0; n < 5; n += 1) await pairingCode(cookieU, u.password);
    const sixth = await srv.app.inject({ method: 'POST', url: '/api/extension/pairing-codes', headers: { cookie: cookieU, origin: PUBLIC_URL }, payload: { currentPassword: u.password } });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json()).toMatchObject({ error: { code: 'too_many_pairing_codes', message: expect.any(String) } });
    // Un code utilisé ou expiré libère une place.
    await sql("UPDATE extension_pairing_codes SET expires_at = now() - interval '1 second' WHERE id = (SELECT id FROM extension_pairing_codes WHERE owner_id = $1 LIMIT 1)", [u.id]);
    await pairingCode(cookieU, u.password);
  });
});

describe('désactivation d’un utilisateur : 0 cookie de lui en base, quelle que soit l’identité appelante', () => {
  test('désactivation sous le rôle des requêtes (future route d’admin) : cookies effacés et jetons révoqués malgré la RLS', async () => {
    const victim = await createUser(srv, 'zz_test_disable_rls@example.test');
    const t = (await pairUser(victim, await signIn(srv, victim), 'zz_test_dev_disable_rls')).token;
    const d = 'zz-test-disable-rls.example';
    await extCall(t, 'PUT', `/api/extension/sites/${d}`, { serverUseAllowed: true });
    expect((await extCall(t, 'PUT', `/api/extension/sites/${d}/cookies`, { cookies: [cookie('sid', 'zz_test_disable_rls', d)] })).statusCode).toBe(204);
    await withClient(srv.db.url, async (c) => {
      await c.query('BEGIN');
      try {
        // Simule une voie d'administration qui passerait par runtime_app (aucune n'existe en 2.6).
        await c.query('GRANT SELECT, UPDATE (status) ON users TO runtime_app');
        await c.query('SET LOCAL ROLE runtime_app');
        await c.query("SELECT set_config('app.user_id', $1, true), set_config('app.role', 'admin', true)", [admin.id]);
        await c.query("UPDATE users SET status = 'disabled' WHERE id = $1", [victim.id]);
        await c.query('RESET ROLE');
        expect((await c.query('SELECT 1 FROM site_sessions WHERE owner_id = $1 AND ciphertext IS NOT NULL', [victim.id])).rowCount).toBe(0);
        expect((await c.query('SELECT 1 FROM tunnels WHERE owner_id = $1 AND revoked_at IS NULL', [victim.id])).rowCount).toBe(0);
      } finally {
        await c.query('ROLLBACK');
      }
    });
    const fn = await sql<{ prosecdef: boolean; proconfig: string[] | null }>("SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'users_disabled_revoke_extension'");
    expect(fn).toEqual([{ prosecdef: true, proconfig: ['search_path=public, pg_temp'] }]);
  });
});

describe('A1 (CDC V1 sym-sessions) : rejeu serveur pour le propriétaire, secret scellé, journal d’usage', () => {
  const pool = () => srv.started.ctx.pool;

  test('assert_server_replay_owner_only (INV5) : cookies rendus seulement si run, API et session ont le même propriétaire et le consentement serveur', async () => {
    const domain = 'zz-test-replay-owner.example';
    const tunnelDomain = 'zz-test-replay-tunnel.example';
    const a = await createUser(srv, 'zz_test_replay_a@example.test');
    const b = await createUser(srv, 'zz_test_replay_b@example.test');
    const ta = (await pairUser(a, await signIn(srv, a), 'zz_test_dev_replay_a')).token;
    const tb = (await pairUser(b, await signIn(srv, b), 'zz_test_dev_replay_b')).token;
    for (const t of [ta, tb]) expect((await extCall(t, 'PUT', `/api/extension/sites/${domain}`, { serverUseAllowed: true })).statusCode).toBe(201);
    expect((await extCall(ta, 'PUT', `/api/extension/sites/${domain}/cookies`, { cookies: [cookie('sid', 'zz_test_replay_value_of_a', domain)] })).statusCode).toBe(204);
    expect((await extCall(ta, 'PUT', `/api/extension/sites/${tunnelDomain}`, { serverUseAllowed: false })).statusCode).toBe(201);
    const resolve = (runId: string, d = domain) => withClient(srv.db.url, (c) => siteCookiesForRun(c, kek(), { runId, domain: d }));

    // Le propriétaire, consentement serveur : sa session est rejouée.
    expect(await resolve(await runFor(a.id))).toMatchObject({ ok: true, ownerId: a.id, cookies: [{ name: 'sid', value: 'zz_test_replay_value_of_a' }] });
    // Un autre utilisateur lançant l'API de A (même domaine) : refus, ni la session de A ni celle de B.
    const foreign = await resolve(await runFor(a.id, b.id));
    expect(foreign).toEqual({ ok: false, reason: 'auth_required' });
    expect(JSON.stringify(foreign)).not.toContain('zz_test_replay_value_of_a');
    // B lançant sa propre API sur le même domaine, sans cookies de lui : rien (jamais ceux de A).
    expect(await resolve(await runFor(b.id))).toEqual({ ok: false, reason: 'auth_required' });
    // Le propriétaire en mode tunnel : pas de rejeu serveur.
    expect(await resolve(await runFor(a.id), tunnelDomain)).toEqual({ ok: false, reason: 'tunnel_only' });
    // Un run dont le propriétaire est A mais l'API est à B (appelant ≠ propriétaire de l'API) : refus.
    expect(await resolve(await runFor(b.id, a.id))).toEqual({ ok: false, reason: 'auth_required' });
  });

  test('assert_token_sealed_like_cookie (INV8) : secret scellé, AAD liée propriétaire + domaine + version, nature `cookie` seule admise', async () => {
    const domain = 'zz-test-sealed-kind.example';
    const a = await createUser(srv, 'zz_test_sealed_a@example.test');
    const b = await createUser(srv, 'zz_test_sealed_b@example.test');
    const ta = (await pairUser(a, await signIn(srv, a), 'zz_test_dev_sealed_a')).token;
    expect((await extCall(ta, 'PUT', `/api/extension/sites/${domain}`, { serverUseAllowed: true })).statusCode).toBe(201);
    expect((await extCall(ta, 'PUT', `/api/extension/sites/${domain}/cookies`, { cookies: [cookie('sid', 'zz_test_sealed_plain_value', domain)] })).statusCode).toBe(204);
    const row = (
      await sql<{ ciphertext: Buffer; nonce: Buffer; dek_wrapped: Buffer; alg: string; key_version: number; secret_kind: string }>(
        'SELECT ciphertext, nonce, dek_wrapped, alg, key_version, secret_kind FROM site_sessions WHERE owner_id = $1 AND domain = $2',
        [a.id, domain],
      )
    )[0]!;
    expect(row.secret_kind).toBe('cookie');
    expect(row.ciphertext.toString('latin1')).not.toContain('zz_test_sealed_plain_value');
    const sealed = { ciphertext: row.ciphertext, nonce: row.nonce, dekWrapped: row.dek_wrapped, alg: row.alg, kekVersion: row.key_version };
    const aad = (ownerId: string, d: string, keyVersion = row.key_version) => siteSessionAad({ ownerId, domain: d, keyVersion });
    expect(openSecret(sealed, kek(), aad(a.id, domain))).toContain('zz_test_sealed_plain_value');
    expect(() => openSecret(sealed, kek(), aad(b.id, domain))).toThrow();
    expect(() => openSecret(sealed, kek(), aad(a.id, 'zz-test-other.example'))).toThrow();
    expect(() => openSecret(sealed, kek(), aad(a.id, domain, row.key_version + 1))).toThrow();
    // Nature hors liste : refusée par la contrainte ; la vue de session expose la nature.
    await expect(sql("UPDATE site_sessions SET secret_kind = 'token' WHERE owner_id = $1 AND domain = $2", [a.id, domain])).rejects.toMatchObject({
      code: '23514',
      constraint: 'site_sessions_secret_kind',
    });
    const view = await srv.app.inject({ method: 'GET', url: '/api/sites', headers: { cookie: await signIn(srv, a) } });
    expect(view.body).toContain(domain);
    // Le rôle des requêtes lit la nature (colonne autorisée), jamais le contenu scellé.
    const kind = await withActor(pool(), { userId: a.id, role: 'member' }, (db) => db.query('SELECT secret_kind FROM site_sessions WHERE domain = $1', [domain]));
    expect(kind.rows).toEqual([{ secret_kind: 'cookie' }]);
  });

  test('site_session_events : ajout seul pour le rôle des requêtes, RLS entre utilisateurs, aucune valeur de secret', async () => {
    const domain = 'zz-test-events.example';
    const u = await createUser(srv, 'zz_test_events_u@example.test');
    const v = await createUser(srv, 'zz_test_events_v@example.test');
    const tu = (await pairUser(u, await signIn(srv, u), 'zz_test_dev_events_u')).token;
    const tv = (await pairUser(v, await signIn(srv, v), 'zz_test_dev_events_v')).token;
    for (const t of [tu, tv]) expect((await extCall(t, 'PUT', `/api/extension/sites/${domain}`, { serverUseAllowed: true })).statusCode).toBe(201);
    const siteOf = async (owner: string) => (await sql<{ id: string }>('SELECT id FROM site_sessions WHERE owner_id = $1 AND domain = $2', [owner, domain]))[0]!.id;
    const insert = (owner: string, event: string) =>
      withActor(pool(), { userId: owner, role: 'member' }, async (db) =>
        db.query('INSERT INTO site_session_events (owner_id, site_session_id, domain, event, outcome) VALUES ($1, $2, $3, $4, $5) RETURNING id', [owner, await siteOf(owner), domain, event, 'ok']),
      );
    const own = (await insert(u.id, 'revoked')).rows[0]!.id as string;
    await insert(v.id, 'refreshed');

    // Le propriétaire lit les siens ; U ne voit pas ceux de V ; un admin ne lit pas ceux d'un autre (assert_no_impersonation).
    const seen = (userId: string, role: 'member' | 'admin') => withActor(pool(), { userId, role }, (db) => db.query('SELECT owner_id, event FROM site_session_events'));
    expect((await seen(u.id, 'member')).rows).toEqual([{ owner_id: u.id, event: 'revoked' }]);
    expect((await seen(v.id, 'member')).rows).toEqual([{ owner_id: v.id, event: 'refreshed' }]);
    expect((await seen(admin.id, 'admin')).rows).toEqual([]);

    // Ajout seul : UPDATE, DELETE et TRUNCATE refusés au rôle applicatif, même pour son propre événement ou en admin.
    for (const [actor, role] of [[u.id, 'member'], [admin.id, 'admin']] as const) {
      for (const text of ["UPDATE site_session_events SET outcome = 'x'", 'DELETE FROM site_session_events', 'TRUNCATE site_session_events']) {
        await expect(withActor(pool(), { userId: actor, role }, (db) => db.query(text))).rejects.toMatchObject({ code: '42501' });
      }
    }
    // Écrire au nom d'un autre : refusé par la politique ; événement hors liste ou secret en colonne : refusés / inexistants.
    await expect(
      withActor(pool(), { userId: u.id, role: 'member' }, (db) => db.query('INSERT INTO site_session_events (owner_id, domain, event) VALUES ($1, $2, $3)', [v.id, domain, 'used'])),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(insert(u.id, 'zz_unknown')).rejects.toMatchObject({ code: '42501' });
    // Journal fiable (B1) : used, checked et refresh_requested sont écrits par le système ; le rôle des requêtes ne les insère pas.
    for (const event of ['used', 'checked', 'refresh_requested']) await expect(insert(u.id, event)).rejects.toMatchObject({ code: '42501' });
    // Le système (identité propriétaire des tables) les écrit, la contrainte de liste restant vérifiée.
    await sql("INSERT INTO site_session_events (owner_id, site_session_id, domain, event) VALUES ($1, $2, $3, 'used')", [u.id, await siteOf(u.id), domain]);
    await expect(sql("INSERT INTO site_session_events (owner_id, domain, event) VALUES ($1, $2, 'zz_unknown')", [u.id, domain])).rejects.toMatchObject({ code: '23514' });
    const columns = await sql<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'site_session_events' ORDER BY column_name");
    expect(columns.map((c) => c.column_name)).toEqual(['created_at', 'domain', 'event', 'id', 'outcome', 'owner_id', 'run_id', 'site_session_id']);
    expect(await sql('SELECT 1 FROM site_session_events WHERE id = $1', [own])).toHaveLength(1);
    await sql("DELETE FROM site_session_events WHERE owner_id = $1 AND event = 'used'", [u.id]);

    // La déconnexion du site garde l'événement (rattachement mis à NULL), sans la session.
    expect((await extCall(tu, 'DELETE', `/api/extension/sites/${domain}`)).statusCode).toBe(204);
    expect(await sql('SELECT site_session_id, domain FROM site_session_events WHERE id = $1', [own])).toEqual([{ site_session_id: null, domain }]);
  });

  test('site_session_events_owner_bound (INV5, INV12) : un événement ne se rattache qu’à la session et au run de son propriétaire, même code 42501 sans oracle d’existence', async () => {
    const domain = 'zz-test-bound.example';
    const u = await createUser(srv, 'zz_test_bound_u@example.test');
    const v = await createUser(srv, 'zz_test_bound_v@example.test');
    const tu = (await pairUser(u, await signIn(srv, u), 'zz_test_dev_bound_u')).token;
    const tv = (await pairUser(v, await signIn(srv, v), 'zz_test_dev_bound_v')).token;
    for (const t of [tu, tv]) expect((await extCall(t, 'PUT', `/api/extension/sites/${domain}`, { serverUseAllowed: true })).statusCode).toBe(201);
    const siteOf = async (owner: string) => (await sql<{ id: string }>('SELECT id FROM site_sessions WHERE owner_id = $1 AND domain = $2', [owner, domain]))[0]!.id;
    const ghost = '00000000-0000-4000-8000-000000000001';
    const attach = (actor: string, owner: string, sessionId: string | null, runId: string | null, d = domain) =>
      withActor(pool(), { userId: actor, role: 'member' }, (db) =>
        db.query("INSERT INTO site_session_events (owner_id, site_session_id, domain, event, run_id) VALUES ($1, $2, $3, 'revoked', $4)", [owner, sessionId, d, runId]),
      );
    const vSession = await siteOf(v.id);
    const vRun = await runFor(v.id);
    const uRun = await runFor(u.id);
    const denied: unknown[] = [];
    // U attache un événement à la session de V, au run de V, ou à un UUID inexistant : le même 42501, avant la clé étrangère (23503).
    for (const [session, run] of [[vSession, null], [null, vRun], [ghost, null], [null, ghost], [await siteOf(u.id), vRun]] as const) {
      const err = await attach(u.id, u.id, session, run).then(() => null, (e: unknown) => e);
      expect(err).toMatchObject({ code: '42501' });
      denied.push((err as Error).message);
    }
    expect(new Set(denied).size).toBe(1);
    expect(denied[0]).not.toMatch(/\d{8}-|zz_test/);
    // Même propriétaire mais autre domaine : refusé.
    await expect(attach(u.id, u.id, await siteOf(u.id), null, 'zz-test-other-domain.example')).rejects.toMatchObject({ code: '42501' });
    // Le système (sans RLS) ne contourne pas le contrôle : un rattachement croisé est refusé aussi.
    await expect(sql("INSERT INTO site_session_events (owner_id, site_session_id, domain, event) VALUES ($1, $2, $3, 'used')", [u.id, vSession, domain])).rejects.toMatchObject({ code: '42501' });
    // Nominal : U sur sa session et son run.
    await attach(u.id, u.id, await siteOf(u.id), uRun);
    expect(await sql('SELECT 1 FROM site_session_events WHERE owner_id = $1 AND run_id = $2', [u.id, uRun])).toHaveLength(1);
    expect(await sql('SELECT 1 FROM site_session_events WHERE owner_id = $1 AND run_id = $2', [v.id, uRun])).toHaveLength(0);
  });

  test('assert_no_impersonation (INV5, A1) : un admin ne lit ni le contenu scellé d’une session ni le journal d’usage d’un autre utilisateur', async () => {
    const domain = 'zz-test-noimp.example';
    const u = await createUser(srv, 'zz_test_noimp_u@example.test');
    const tu = (await pairUser(u, await signIn(srv, u), 'zz_test_dev_noimp')).token;
    expect((await extCall(tu, 'PUT', `/api/extension/sites/${domain}`, { serverUseAllowed: true })).statusCode).toBe(201);
    expect((await extCall(tu, 'PUT', `/api/extension/sites/${domain}/cookies`, { cookies: [cookie('sid', 'zz_test_noimp_value', domain)] })).statusCode).toBe(204);
    await sql("INSERT INTO site_session_events (owner_id, domain, event) VALUES ($1, $2, 'used')", [u.id, domain]);
    for (const col of ['ciphertext', 'nonce', 'dek_wrapped']) {
      await expect(withActor(pool(), { userId: admin.id, role: 'admin' }, (db) => db.query(`SELECT ${col} FROM site_sessions`))).rejects.toMatchObject({ code: '42501' });
    }
    const adminView = await withActor(pool(), { userId: admin.id, role: 'admin' }, async (db) => ({
      sessions: (await db.query('SELECT id FROM site_sessions WHERE owner_id = $1', [u.id])).rowCount,
      events: (await db.query('SELECT id FROM site_session_events WHERE owner_id = $1', [u.id])).rowCount,
    }));
    expect(adminView).toEqual({ sessions: 0, events: 0 });
  });
});
