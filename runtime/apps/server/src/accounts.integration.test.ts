// SPDX-License-Identifier: AGPL-3.0-only
// Comptes avancés côté serveur (tâche 3.7, 13 § 13.2) sur base réelle : invitations (SMTP de test et lien copiable),
// 2FA TOTP « maison » (graine scellée, anti-rejeu, codes de secours), MFA_ENFORCED, OIDC générique sur un faux
// fournisseur local, désactivation, hiérarchie, réinitialisation, audit, réglages, D-15 (appareil reconnu).
import { randomBytes } from 'node:crypto';
import { generateOpaqueToken } from '@runtime/core';
import { issueOperatorResetLink, saveSmtpSettings } from '@runtime/db';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startFakeIdp, type FakeIdp } from '../../../tests/helpers/oidc-provider.js';
import { withClient } from '../../../tests/helpers/pg.js';
import { startFakeSmtp, type FakeSmtp } from '../../../tests/helpers/smtp-server.js';
import {
  createKey,
  createUser,
  enableTwoFactor,
  nextTestIp,
  PUBLIC_URL,
  runSetup,
  sessionCookie,
  signIn,
  startTestServer,
  totpFor,
  type TestServer,
  type TestUser,
} from '../../../tests/helpers/server.js';

let srv: TestServer;
let owner: TestUser;
let ownerCookie: string;
let admin: TestUser;
let adminCookie: string;
let idp: FakeIdp;

const DEFAULT_SECURITY = { session_idle_minutes: 720, session_absolute_hours: 168, allowed_email_domains: [], api_key_max_lifetime_days: 365 };
/** Remet les réglages de sécurité par défaut par la route (qui vide le cache des réglages). */
async function resetSecurity(): Promise<void> {
  const res = await srv.app.inject({ method: 'PUT', url: '/api/settings/security', headers: { cookie: ownerCookie, origin: PUBLIC_URL }, payload: DEFAULT_SECURITY });
  expect(res.statusCode).toBe(200);
}

const strongPassword = () => `zz_test_${randomBytes(12).toString('base64url')}`;
const json = (cookie: string) => ({ cookie, origin: PUBLIC_URL });

async function sql<T extends Record<string, unknown>>(server: TestServer, text: string, params: unknown[] = []): Promise<T[]> {
  return withClient(server.db.url, async (c) => (await c.query<T>(text, params)).rows);
}

async function auditOf(server: TestServer, action: string) {
  return sql<{ actor_user_id: string | null; outcome: string; target_id: string | null; meta: Record<string, unknown> }>(
    server,
    'SELECT actor_user_id, outcome, target_id, meta FROM audit_events WHERE action = $1 ORDER BY id',
    [action],
  );
}

/**
 * Échafaudage de test : oublie le dernier pas TOTP accepté (l'anti-rejeu n'accepte qu'un pas plus récent, et la fenêtre
 * ±1 n'en offre que deux d'avance). Un test qui consomme un troisième code dans la même demi-minute l'appelle.
 */
async function rewindTotp(server: TestServer, userId: string): Promise<void> {
  await sql(server, 'UPDATE two_factor SET last_used_step = NULL WHERE user_id = $1', [userId]);
}

/** Connexion par mot de passe, réponse brute. */
function login(server: TestServer, user: Pick<TestUser, 'email' | 'password'>, headers: Record<string, string> = {}) {
  return server.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', remoteAddress: nextTestIp(), headers: { origin: PUBLIC_URL, ...headers }, payload: { email: user.email, password: user.password } });
}

function cookiesOf(res: LightMyRequestResponse): string {
  return res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** Configure le SSO de `server` sur le faux IdP. */
async function configureSso(server: TestServer, cookie: string, extra: Record<string, unknown> = {}) {
  const res = await server.app.inject({
    method: 'PUT',
    url: '/api/settings/sso',
    headers: json(cookie),
    payload: { enabled: true, slug: 'zz-test-idp', label: 'ZZ Test IdP', issuer_url: idp.issuer, client_id: idp.clientId, client_secret: idp.clientSecret, ...extra },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res;
}

/** Parcours OIDC complet : départ sur l'instance, autorisation chez le faux IdP, retour. */
async function oidcLogin(server: TestServer, query = '', cookie = ''): Promise<{ location: string; cookie: string; res: LightMyRequestResponse }> {
  // Navigation lancée depuis la console (même origine).
  const start = await server.app.inject({ method: 'GET', url: `/api/auth/oidc/start${query}`, headers: { 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}) } });
  expect(start.statusCode, start.body).toBe(302);
  const authorize = String(start.headers.location);
  expect(authorize.startsWith(`${idp.issuer}/authorize?`), authorize).toBe(true);
  const stateCookie = cookiesOf(start);
  const atIdp = await fetch(authorize, { redirect: 'manual' });
  const callback = new URL(String(atIdp.headers.get('location')));
  expect(callback.pathname).toBe('/api/auth/oidc/callback');
  const res = await server.app.inject({ method: 'GET', url: `${callback.pathname}${callback.search}`, headers: { cookie: [cookie, stateCookie].filter(Boolean).join('; ') } });
  expect(res.statusCode, res.body).toBe(302);
  const session = res.cookies.find((c) => c.name.endsWith('sy.session') && c.value !== '');
  return { location: String(res.headers.location), cookie: session ? `${session.name}=${session.value}` : '', res };
}

/** Liaison OIDC depuis une session : ré-authentification (mot de passe, code si 2FA), puis aller-retour chez le faux IdP. */
async function oidcLink(server: TestServer, cookie: string, password: string, code?: string): Promise<{ location: string; res: LightMyRequestResponse }> {
  const start = await server.app.inject({ method: 'POST', url: '/api/me/identities/oidc', headers: json(cookie), payload: { current_password: password, ...(code ? { code } : {}) } });
  expect(start.statusCode, start.body).toBe(200);
  const authorize = start.json<{ authorization_url: string }>().authorization_url;
  expect(authorize.startsWith(`${idp.issuer}/authorize?`), authorize).toBe(true);
  const atIdp = await fetch(authorize, { redirect: 'manual' });
  const callback = new URL(String(atIdp.headers.get('location')));
  const res = await server.app.inject({ method: 'GET', url: `${callback.pathname}${callback.search}`, headers: { cookie: [cookie, cookiesOf(start)].join('; ') } });
  expect(res.statusCode, res.body).toBe(302);
  return { location: String(res.headers.location), res };
}

const tokenOfLink = (link: string) => link.slice(link.lastIndexOf('/') + 1);

beforeAll(async () => {
  idp = await startFakeIdp();
  srv = await startTestServer('acct', {}, { oidcAllowHttp: true });
  owner = await runSetup(srv);
  ownerCookie = await signIn(srv, owner);
  admin = await createUser(srv, 'zz_test_acct_admin@example.test', 'admin');
  adminCookie = await signIn(srv, admin);
});
afterAll(async () => {
  await srv.close();
  await idp.close();
});

describe('invitations (13 § 6)', () => {
  async function invite(email: string, role: 'member' | 'admin' = 'member', cookie = adminCookie) {
    return srv.app.inject({ method: 'POST', url: '/api/invitations', headers: json(cookie), payload: { email, role } });
  }
  const tokenOf = (link: string) => link.slice(link.lastIndexOf('/') + 1);
  const accept = (token: string, password = strongPassword()) => srv.app.inject({ method: 'POST', url: '/api/invitations/accept', payload: { token, password } });

  test('assert_invitation_single_use : invitation de 49 h, déjà acceptée, révoquée ou inconnue → réponse identique, aucun compte créé', async () => {
    const valid = await invite('zz_test_inv_ok@example.test');
    expect(valid.statusCode, valid.body).toBe(201);
    const created = valid.json<{ id: string; emailed: boolean; link: string; expires_at: string }>();
    // Sans SMTP : lien copiable affiché une fois ; jeton jamais stocké en clair.
    expect(created.emailed).toBe(false);
    expect(created.link).toMatch(new RegExp(`^${PUBLIC_URL}/invite/[A-Za-z0-9_-]{43}$`));
    expect(new Date(created.expires_at).getTime() - Date.now()).toBeGreaterThan(47 * 3600 * 1000);
    expect(JSON.stringify(await sql(srv, 'SELECT * FROM invitations'))).not.toContain(tokenOf(created.link));
    expect((await srv.app.inject({ method: 'GET', url: '/api/invitations', headers: { cookie: adminCookie } })).body).not.toContain(tokenOf(created.link));

    const old = (await invite('zz_test_inv_old@example.test')).json<{ id: string; link: string }>();
    await sql(srv, "UPDATE invitations SET sent_at = now() - interval '49 hours', expires_at = now() - interval '1 hour', created_at = now() - interval '49 hours' WHERE id = $1", [old.id]);
    const revoked = (await invite('zz_test_inv_revoked@example.test')).json<{ id: string; link: string }>();
    expect((await srv.app.inject({ method: 'DELETE', url: `/api/invitations/${revoked.id}`, headers: json(adminCookie) })).statusCode).toBe(204);

    const usersBefore = await sql<{ n: number }>(srv, 'SELECT count(*)::int AS n FROM users');
    const first = await accept(tokenOf(created.link));
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ email: 'zz_test_inv_ok@example.test', role: 'member', via: 'ui', scopes: null });
    // Session d'interface ouverte (nouveau jeton).
    const me = await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: sessionCookie(first) } });
    expect(me.json<{ email: string }>().email).toBe('zz_test_inv_ok@example.test');

    const refusals = [await accept(tokenOf(created.link)), await accept(tokenOf(old.link)), await accept(tokenOf(revoked.link)), await accept(randomBytes(32).toString('base64url')), await accept('zz_test_garbage')];
    for (const res of refusals) {
      expect({ status: res.statusCode, body: res.body }).toEqual({ status: refusals[0]!.statusCode, body: refusals[0]!.body });
      expect(res.cookies).toEqual([]);
    }
    expect(refusals[0]!.json()).toEqual({ error: { code: 'invitation_invalid', message: expect.any(String) } });
    // Un seul compte créé : celui de l'invitation valide.
    expect((await sql<{ n: number }>(srv, 'SELECT count(*)::int AS n FROM users'))[0]!.n).toBe(usersBefore[0]!.n + 1);
    expect(await sql(srv, "SELECT email FROM users WHERE email IN ('zz_test_inv_old@example.test', 'zz_test_inv_revoked@example.test')")).toEqual([]);
    expect((await auditOf(srv, 'invitation.accepted')).map((e) => e.outcome)).toEqual(['success', 'denied', 'denied', 'denied', 'denied', 'denied']);
  });

  test('renvoi : nouveau jeton, l’ancien lien ne sert plus ; invitation admin réservée à l’owner ; doublons refusés', async () => {
    const first = (await invite('zz_test_inv_resend@example.test')).json<{ id: string; link: string }>();
    const resent = await srv.app.inject({ method: 'POST', url: `/api/invitations/${first.id}/resend`, headers: json(adminCookie) });
    expect(resent.statusCode, resent.body).toBe(200);
    const second = resent.json<{ link: string }>();
    expect(second.link).not.toBe(first.link);
    expect((await accept(tokenOf(first.link))).statusCode).toBe(400);
    expect((await accept(tokenOf(second.link))).statusCode).toBe(200);

    expect((await invite('zz_test_inv_admin@example.test', 'admin', adminCookie)).statusCode).toBe(403);
    expect((await invite('zz_test_inv_admin@example.test', 'admin', ownerCookie)).statusCode).toBe(201);
    expect((await invite('zz_test_inv_admin@example.test', 'member', ownerCookie)).statusCode).toBe(409);
    expect((await invite(owner.email, 'member', ownerCookie)).statusCode).toBe(409);
    const member = await createUser(srv, 'zz_test_inv_member@example.test');
    expect((await invite('zz_test_x@example.test', 'member', await signIn(srv, member))).statusCode).toBe(403);
  });

  test('avec SMTP : lien envoyé par e-mail (garde SSRF operator-config), jamais rendu à l’admin', async () => {
    const smtp: FakeSmtp = await startFakeSmtp();
    try {
      await saveSmtpSettings(srv.started.ctx.pool, srv.started.ctx.secrets!, { host: '127.0.0.1', port: smtp.port, security: 'none', from: 'runtime@scrapyomama.zz-test' });
      const res = await invite('zz_test_inv_mail@example.test');
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toMatchObject({ emailed: true, link: null });
      expect(smtp.mails).toHaveLength(1);
      expect(smtp.mails[0]!.to).toEqual(['zz_test_inv_mail@example.test']);
      const link = /https?:\/\/\S+\/invite\/[A-Za-z0-9_-]{43}/.exec(smtp.mails[0]!.text)?.[0];
      expect(link).toBeDefined();
      expect((await accept(tokenOf(link!))).statusCode).toBe(200);
    } finally {
      await sql(srv, "DELETE FROM settings WHERE key = 'smtp'");
      await smtp.close();
    }
  });

  test('révocation : un admin ne révoque pas l’invitation « admin » de l’owner (403, audit denied) ; l’owner, si', async () => {
    const created = await invite('zz_test_inv_admin_rev@example.test', 'admin', ownerCookie);
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<{ id: string }>().id;
    const denied = await srv.app.inject({ method: 'DELETE', url: `/api/invitations/${id}`, headers: json(adminCookie) });
    expect(denied.statusCode).toBe(403);
    expect(await sql(srv, 'SELECT revoked_at FROM invitations WHERE id = $1', [id])).toEqual([{ revoked_at: null }]);
    expect((await auditOf(srv, 'invitation.revoked')).filter((e) => e.outcome === 'denied' && e.actor_user_id === admin.id)).toHaveLength(1);
    expect((await srv.app.inject({ method: 'DELETE', url: `/api/invitations/${id}`, headers: json(ownerCookie) })).statusCode).toBe(204);
  });

  test('domaines autorisés (réglage de l’owner)', async () => {
    const put = await srv.app.inject({
      method: 'PUT',
      url: '/api/settings/security',
      headers: json(ownerCookie),
      payload: { session_idle_minutes: 720, session_absolute_hours: 168, allowed_email_domains: ['allowed.example.test'], api_key_max_lifetime_days: 365 },
    });
    expect(put.statusCode, put.body).toBe(200);
    try {
      expect((await invite('zz_test_inv@other.example.test')).json()).toEqual({ error: { code: 'email_domain_not_allowed', message: expect.any(String) } });
      expect((await invite('zz_test_inv@allowed.example.test')).statusCode).toBe(201);
    } finally {
      await resetSecurity();
    }
  });
});

describe('2FA TOTP (13 § 7)', () => {
  test('graine chiffrée (MASTER_KEY, AAD user_id), affichée une fois ; codes de secours hachés', async () => {
    const user = await createUser(srv, 'zz_test_mfa_seal@example.test');
    const cookie = await signIn(srv, user);
    const { secret, backupCodes } = await enableTwoFactor(srv, cookie, user);
    const stored = await sql<{ secret_ciphertext: Buffer; alg: string; key_version: number }>(srv, 'SELECT secret_ciphertext, alg, key_version FROM two_factor WHERE user_id = $1', [user.id]);
    expect(stored[0]).toMatchObject({ alg: 'aes-256-gcm', key_version: 1 });
    const whole = JSON.stringify(await sql(srv, 'SELECT * FROM two_factor')) + JSON.stringify(await sql(srv, 'SELECT * FROM backup_codes')) + JSON.stringify(await sql(srv, 'SELECT * FROM audit_events'));
    expect(whole).not.toContain(secret);
    for (const code of backupCodes) expect(whole).not.toContain(code.replace(/-/g, ''));
    expect(await sql(srv, 'SELECT count(*)::int AS n FROM backup_codes WHERE user_id = $1', [user.id])).toEqual([{ n: 10 }]);
    // Plus jamais relue : un second enrôlement est refusé tant que la 2FA est active.
    const again = await srv.app.inject({ method: 'POST', url: '/api/me/2fa/enroll', headers: json(cookie), payload: { current_password: user.password } });
    expect(again.statusCode).toBe(409);
    expect(again.body).not.toContain(secret);
  });

  test('assert_totp_replay_refused : session en attente du second facteur, aucune autre route ; code TOTP rejoué → refus ; code de secours à usage unique', async () => {
    const user = await createUser(srv, 'zz_test_mfa_login@example.test');
    const { secret, backupCodes } = await enableTwoFactor(srv, await signIn(srv, user), user);
    const first = await login(srv, user);
    expect(first.statusCode).toBe(200);
    expect(first.json<{ twoFactorRequired?: boolean }>().twoFactorRequired).toBe(true);
    const pending = sessionCookie(first);
    // Seconde facteur attendu : rien d'autre n'est joignable.
    for (const url of ['/api/me', '/api/api-keys', '/api/me/sessions']) {
      const res = await srv.app.inject({ method: 'GET', url, headers: { cookie: pending } });
      expect(res.statusCode, url).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('mfa_required');
    }
    // Le corps du second facteur refuse un champ étranger (08b § 4, cas 4).
    expect((await srv.app.inject({ method: 'POST', url: '/api/auth/two-factor/verify', headers: json(pending), payload: { code: '000000', user_id: owner.id } })).statusCode).toBe(400);
    const code = totpFor(secret, 1); // le pas courant a servi à la confirmation
    const ok = await srv.app.inject({ method: 'POST', url: '/api/auth/two-factor/verify', headers: json(pending), payload: { code } });
    expect(ok.statusCode, ok.body).toBe(200);
    const full = sessionCookie(ok);
    expect(full).not.toBe(pending); // nouveau jeton
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: pending } })).statusCode).toBe(401);
    expect((await srv.app.inject({ method: 'GET', url: '/api/api-keys', headers: { cookie: full } })).statusCode).toBe(200);

    // Rejeu du même code sur une nouvelle connexion : refusé.
    const second = sessionCookie(await login(srv, user));
    const replay = await srv.app.inject({ method: 'POST', url: '/api/auth/two-factor/verify', headers: json(second), payload: { code } });
    expect(replay.statusCode).toBe(400);
    expect(replay.json<{ error: { code: string } }>().error.code).toBe('invalid_code');
    // Code de secours : une fois.
    const backup = backupCodes[0]!;
    const withBackup = await srv.app.inject({ method: 'POST', url: '/api/auth/two-factor/verify', headers: json(second), payload: { code: backup.toUpperCase() } });
    expect(withBackup.statusCode, withBackup.body).toBe(200);
    expect(withBackup.json()).toMatchObject({ method: 'backup_code', backup_codes_remaining: 9 });
    const third = sessionCookie(await login(srv, user));
    expect((await srv.app.inject({ method: 'POST', url: '/api/auth/two-factor/verify', headers: json(third), payload: { code: backup } })).statusCode).toBe(400);
    expect((await auditOf(srv, 'auth.mfa_failed')).length).toBeGreaterThanOrEqual(2);
  });

  test('5 échecs du second facteur : session en attente fermée, 429', async () => {
    const user = await createUser(srv, 'zz_test_mfa_brute@example.test');
    await enableTwoFactor(srv, await signIn(srv, user), user);
    const pending = sessionCookie(await login(srv, user));
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      codes.push((await srv.app.inject({ method: 'POST', url: '/api/auth/two-factor/verify', headers: json(pending), payload: { code: '000000' } })).statusCode);
    }
    expect(codes).toEqual([400, 400, 400, 400, 429]);
    expect((await srv.app.inject({ method: 'POST', url: '/api/auth/two-factor/verify', headers: json(pending), payload: { code: '000000' } })).statusCode).toBe(401);
  });

  test('retrait : mot de passe ET code exigés ; régénération des codes de secours (les anciens révoqués)', async () => {
    const user = await createUser(srv, 'zz_test_mfa_remove@example.test');
    const cookie = await signIn(srv, user);
    const { secret, backupCodes } = await enableTwoFactor(srv, cookie, user);
    // Régénérer les codes de secours exige aussi le second facteur (mot de passe seul : refus).
    const passwordOnly = await srv.app.inject({ method: 'POST', url: '/api/me/2fa/backup-codes', headers: json(cookie), payload: { current_password: user.password } });
    expect(passwordOnly.statusCode).toBe(400);
    const wrongCode = await srv.app.inject({ method: 'POST', url: '/api/me/2fa/backup-codes', headers: json(cookie), payload: { current_password: user.password, code: '000000' } });
    expect(wrongCode.json<{ error: { code: string } }>().error.code).toBe('invalid_code');
    const regen = await srv.app.inject({ method: 'POST', url: '/api/me/2fa/backup-codes', headers: json(cookie), payload: { current_password: user.password, code: backupCodes[1] } });
    expect(regen.statusCode, regen.body).toBe(200);
    const fresh = regen.json<{ backup_codes: string[] }>().backup_codes;
    expect(fresh).toHaveLength(10);
    const oldCode = await srv.app.inject({ method: 'DELETE', url: '/api/me/2fa', headers: json(cookie), payload: { current_password: user.password, code: backupCodes[0] } });
    expect(oldCode.statusCode).toBe(400);
    const wrongPassword = await srv.app.inject({ method: 'DELETE', url: '/api/me/2fa', headers: json(cookie), payload: { current_password: 'zz_test_wrong', code: totpFor(secret, 1) } });
    expect(wrongPassword.statusCode).toBe(403);
    const removed = await srv.app.inject({ method: 'DELETE', url: '/api/me/2fa', headers: json(cookie), payload: { current_password: user.password, code: fresh[0] } });
    expect(removed.statusCode, removed.body).toBe(204);
    expect(await sql(srv, 'SELECT count(*)::int AS n FROM two_factor WHERE user_id = $1', [user.id])).toEqual([{ n: 0 }]);
    expect((await login(srv, user)).json<{ twoFactorRequired?: boolean }>().twoFactorRequired).toBeUndefined();
  });

  test('second facteur des opérations sensibles limité par compte : 5 codes faux au retrait → 429, même le bon code ensuite', async () => {
    const user = await createUser(srv, 'zz_test_mfa_remove_brute@example.test');
    const cookie = await signIn(srv, user);
    const { secret } = await enableTwoFactor(srv, cookie, user);
    const remove = (code: string) => srv.app.inject({ method: 'DELETE', url: '/api/me/2fa', headers: json(cookie), payload: { current_password: user.password, code } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await remove('000000')).statusCode);
    expect(statuses).toEqual([400, 400, 400, 400, 429]);
    await rewindTotp(srv, user.id);
    expect((await remove(totpFor(secret))).statusCode).toBe(429);
    expect(await sql(srv, 'SELECT count(*)::int AS n FROM two_factor WHERE user_id = $1', [user.id])).toEqual([{ n: 1 }]);
  });
});

describe('MFA_ENFORCED=admins', () => {
  test('assert_mfa_enforced (admins) : owner et admin sans 2FA forcés à l’enrôlement, un membre non', async () => {
    const s = await startTestServer('mfaadm', { MFA_ENFORCED: 'admins' });
    try {
      const o = await runSetup(s);
      const adminUser = await createUser(s, 'zz_test_mfaadm_admin@example.test', 'admin');
      const memberUser = await createUser(s, 'zz_test_mfaadm_member@example.test');
      for (const u of [o, adminUser]) {
        const res = await s.app.inject({ method: 'GET', url: '/api/api-keys', headers: { cookie: await signIn(s, u) } });
        expect(res.json<{ error: { code: string } }>().error.code, u.role).toBe('mfa_enrollment_required');
      }
      expect((await s.app.inject({ method: 'GET', url: '/api/api-keys', headers: { cookie: await signIn(s, memberUser) } })).statusCode).toBe(200);
    } finally {
      await s.close();
    }
  });
});

describe('assert_mfa_enforced (MFA_ENFORCED=all)', () => {
  let enforced: TestServer;
  let enforcedOwnerCookie: string;
  beforeAll(async () => {
    enforced = await startTestServer('mfaall', { MFA_ENFORCED: 'all' }, { oidcAllowHttp: true });
    const o = await runSetup(enforced);
    enforcedOwnerCookie = await signIn(enforced, o);
    // L'owner est lui aussi tenu à la 2FA : il s'enrôle d'abord (sa session est alors complète).
    await enableTwoFactor(enforced, enforcedOwnerCookie, o);
  });
  afterAll(async () => {
    await enforced.close();
  });

  test('assert_mfa_enforced : compte sans 2FA, enrôlement forcé avant toute autre route, puis accès normal', async () => {
    const user = await createUser(enforced, 'zz_test_enf_member@example.test');
    const cookie = await signIn(enforced, user);
    for (const url of ['/api/api-keys', '/api/me/sessions', '/api/me/audit']) {
      const res = await enforced.app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode, url).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('mfa_enrollment_required');
    }
    // L'identité et l'enrôlement restent joignables.
    expect((await enforced.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
    await enableTwoFactor(enforced, cookie, user);
    expect((await enforced.app.inject({ method: 'GET', url: '/api/api-keys', headers: { cookie } })).statusCode).toBe(200);
    // Retirer sa 2FA est refusé quand MFA_ENFORCED le concerne.
    const removal = await enforced.app.inject({ method: 'DELETE', url: '/api/me/2fa', headers: json(cookie), payload: { current_password: user.password, code: '000000' } });
    expect(removal.json<{ error: { code: string } }>().error.code).toBe('mfa_enforced');
  });

  test('compte invité : la session ouverte à l’acceptation est soumise à l’enrôlement forcé', async () => {
    const created = await enforced.app.inject({ method: 'POST', url: '/api/invitations', headers: json(enforcedOwnerCookie), payload: { email: 'zz_test_enf_invited@example.test', role: 'member' } });
    const link = created.json<{ link: string }>().link;
    const res = await enforced.app.inject({ method: 'POST', url: '/api/invitations/accept', payload: { token: link.slice(link.lastIndexOf('/') + 1), password: strongPassword() } });
    expect(res.statusCode, res.body).toBe(200);
    const blocked = await enforced.app.inject({ method: 'GET', url: '/api/api-keys', headers: { cookie: sessionCookie(res) } });
    expect(blocked.json<{ error: { code: string } }>().error.code).toBe('mfa_enrollment_required');
  });

  test('assert_mfa_enforced : connexion OIDC sans amr de second facteur, enrôlement forcé ; avec amr « mfa » : accès', async () => {
    await configureSso(enforced, enforcedOwnerCookie);
    const user = await createUser(enforced, 'zz_test_enf_oidc@example.test');
    // Identité IdP déjà liée (la liaison depuis une session est testée plus bas) : une session à enrôlement forcé
    // n'atteint pas la liaison (seule l'identité et l'enrôlement lui sont ouverts).
    await sql(enforced, 'INSERT INTO auth_accounts (user_id, provider_id, account_id) VALUES ($1, $2, $3)', [user.id, 'oidc:zz-test-idp', `${idp.issuer}|zz_test_enf_sub`]);
    const blockedLink = await enforced.app.inject({ method: 'POST', url: '/api/me/identities/oidc', headers: json(await signIn(enforced, user)), payload: { current_password: user.password } });
    expect(blockedLink.json<{ error: { code: string } }>().error.code).toBe('mfa_enrollment_required');

    idp.nextClaims = { sub: 'zz_test_enf_sub', email: user.email, email_verified: true, amr: ['pwd'] };
    const noMfa = await oidcLogin(enforced);
    expect(noMfa.location).toBe(`${PUBLIC_URL}/`);
    const res = await enforced.app.inject({ method: 'GET', url: '/api/api-keys', headers: { cookie: noMfa.cookie } });
    expect(res.json<{ error: { code: string } }>().error.code).toBe('mfa_enrollment_required');

    idp.nextClaims = { sub: 'zz_test_enf_sub', email: user.email, email_verified: true, amr: ['pwd', 'mfa'] };
    const withMfa = await oidcLogin(enforced);
    expect((await enforced.app.inject({ method: 'GET', url: '/api/api-keys', headers: { cookie: withMfa.cookie } })).statusCode).toBe(200);
  });
});

describe('OIDC générique (13 § 7)', () => {
  beforeAll(async () => {
    await configureSso(srv, ownerCookie, { group_roles: [{ group: 'zz-ops', role: 'admin' }] });
  });

  test('réglages : client_secret en écriture seule, chiffré (INV8) ; owner jamais attribuable par un groupe ; page de connexion publique', async () => {
    const get = await srv.app.inject({ method: 'GET', url: '/api/settings/sso', headers: { cookie: ownerCookie } });
    expect(get.json()).toMatchObject({ enabled: true, slug: 'zz-test-idp', client_secret_set: true });
    expect(get.body).not.toContain(idp.clientSecret);
    expect(JSON.stringify(await sql(srv, 'SELECT * FROM settings'))).not.toContain(idp.clientSecret);
    expect(JSON.stringify(await sql(srv, "SELECT * FROM secrets WHERE kind = 'oidc_client_secret'"))).not.toContain(idp.clientSecret);
    const ownerGroup = await srv.app.inject({
      method: 'PUT',
      url: '/api/settings/sso',
      headers: json(ownerCookie),
      payload: { enabled: true, slug: 'zz-test-idp', issuer_url: idp.issuer, client_id: idp.clientId, group_roles: [{ group: 'zz-root', role: 'owner' }] },
    });
    expect(ownerGroup.statusCode).toBe(400);
    expect((await srv.app.inject({ method: 'GET', url: '/api/settings/sso', headers: { cookie: adminCookie } })).statusCode).toBe(403);
    expect((await srv.app.inject({ method: 'GET', url: '/api/sso' })).json()).toEqual({ enabled: true, sso_required: false, providers: [{ slug: 'zz-test-idp', label: 'ZZ Test IdP' }] });
  });

  test('assert_oidc_no_email_linking : même adresse qu’un compte local, sans session ni invitation → aucune liaison', async () => {
    const local = await createUser(srv, 'zz_test_oidc_local@example.test');
    idp.nextClaims = { sub: 'zz_test_attacker_sub', email: local.email, email_verified: true };
    const res = await oidcLogin(srv);
    expect(res.location).toBe(`${PUBLIC_URL}/login?sso_error=no_account`);
    expect(res.cookie).toBe('');
    // Même avec la création à la volée active : jamais de liaison ni de doublon par l'adresse.
    await configureSso(srv, ownerCookie, { jit_provisioning: { enabled: true, domains: ['example.test'] }, group_roles: [{ group: 'zz-ops', role: 'admin' }] });
    const jit = await oidcLogin(srv);
    expect(jit.location).toBe(`${PUBLIC_URL}/login?sso_error=no_account`);
    expect(await sql(srv, "SELECT user_id FROM auth_accounts WHERE provider_id LIKE 'oidc:%' AND account_id LIKE '%zz_test_attacker_sub'")).toEqual([]);
    expect(await sql(srv, 'SELECT count(*)::int AS n FROM users WHERE email = $1', [local.email])).toEqual([{ n: 1 }]);
    expect((await auditOf(srv, 'auth.login_failed')).filter((e) => e.meta['reason'] === 'no_account').length).toBeGreaterThanOrEqual(2);
  });

  test('création à la volée (domaines) en member, rôle depuis les groupes réévalué aux connexions suivantes, jamais owner', async () => {
    idp.nextClaims = { sub: 'zz_test_jit_sub', email: 'zz_test_jit@example.test', email_verified: true, groups: ['zz-ops', 'owner'] };
    const first = await oidcLogin(srv);
    expect(first.location).toBe(`${PUBLIC_URL}/`);
    const me = await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: first.cookie } });
    // 13 § 7 : rôle initial member, même si les groupes de l'IdP en donneraient un autre.
    expect(me.json()).toMatchObject({ email: 'zz_test_jit@example.test', role: 'member' });
    const jitId = me.json<{ id: string }>().id;
    expect((await auditOf(srv, 'user.provisioned')).find((e) => e.target_id === jitId)?.meta).toMatchObject({ role: 'member' });
    // Compte OIDC seul : sa seule identité ne se retire pas (aucun autre moyen de connexion).
    const identities = (await srv.app.inject({ method: 'GET', url: '/api/me/identities', headers: { cookie: first.cookie } })).json<{ identities: { id: string }[] }>().identities;
    expect(identities).toHaveLength(1);
    const lastOne = await srv.app.inject({ method: 'DELETE', url: `/api/me/identities/${identities[0]!.id}`, headers: json(first.cookie) });
    expect(lastOne.json<{ error: { code: string } }>().error.code).toBe('last_login_method');
    const promoted = await oidcLogin(srv);
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: promoted.cookie } })).json()).toMatchObject({ role: 'admin' });
    idp.nextClaims = { sub: 'zz_test_jit_sub', email: 'zz_test_jit@example.test', email_verified: true, groups: [] };
    const second = await oidcLogin(srv);
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: second.cookie } })).json()).toMatchObject({ role: 'member' });
    // Adresse non vérifiée ou domaine hors liste : refus.
    idp.nextClaims = { sub: 'zz_test_jit_unverified', email: 'zz_test_jit2@example.test', email_verified: false };
    expect((await oidcLogin(srv)).location).toContain('sso_error=no_account');
    idp.nextClaims = { sub: 'zz_test_jit_domain', email: 'zz_test_jit3@elsewhere.test', email_verified: true };
    expect((await oidcLogin(srv)).location).toContain('sso_error=no_account');
    // L'owner relié à l'IdP reste owner, quels que soient ses groupes.
    idp.nextClaims = { sub: 'zz_test_owner_sub', email: owner.email, email_verified: true };
    await oidcLink(srv, ownerCookie, owner.password);
    idp.nextClaims = { sub: 'zz_test_owner_sub', email: owner.email, email_verified: true, groups: [] };
    const asOwner = await oidcLogin(srv);
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: asOwner.cookie } })).json()).toMatchObject({ role: 'owner' });
    await configureSso(srv, ownerCookie, { group_roles: [{ group: 'zz-ops', role: 'admin' }] });
  });

  test('assert_oidc_jit_requires_domains : création à la volée sans liste de domaines → 400 ; réglage forcé en base → aucun compte créé', async () => {
    // 13 § 7 : « activable avec liste de domaines ». Sans liste, un IdP public (Google…) ouvrirait l'instance à tous.
    const empty = await srv.app.inject({
      method: 'PUT',
      url: '/api/settings/sso',
      headers: json(ownerCookie),
      payload: { enabled: true, slug: 'zz-test-idp', issuer_url: idp.issuer, client_id: idp.clientId, jit_provisioning: { enabled: true, domains: [] } },
    });
    expect(empty.statusCode, empty.body).toBe(400);
    expect(empty.body).toContain('jit_provisioning.domains');
    const blank = await srv.app.inject({
      method: 'PUT',
      url: '/api/settings/sso',
      headers: json(ownerCookie),
      payload: { enabled: true, slug: 'zz-test-idp', issuer_url: idp.issuer, client_id: idp.clientId, jit_provisioning: { enabled: true } },
    });
    expect(blank.statusCode, blank.body).toBe(400);
    expect((await srv.app.inject({ method: 'GET', url: '/api/settings/sso', headers: { cookie: ownerCookie } })).json()).toMatchObject({ jit_provisioning: { enabled: false } });
    idp.nextClaims = { sub: 'zz_test_jit_open_sub', email: 'zz_test_jit_open@anyone.test', email_verified: true };
    expect((await oidcLogin(srv)).location).toContain('sso_error=no_account');
    // Défense en profondeur : réglage écrit en base sans passer par la validation (ancienne version, édition manuelle).
    await sql(srv, "UPDATE settings SET value = jsonb_set(value, '{jit_provisioning}', '{\"enabled\": true, \"domains\": []}'::jsonb) WHERE key = 'sso'");
    expect((await sql(srv, "SELECT value->'jit_provisioning' AS j FROM settings WHERE key = 'sso'"))[0]).toEqual({ j: { enabled: true, domains: [] } });
    const forced = await oidcLogin(srv);
    expect(forced.location).toContain('sso_error=no_account');
    expect(forced.cookie).toBe('');
    expect(await sql(srv, 'SELECT count(*)::int AS n FROM users WHERE email = $1', ['zz_test_jit_open@anyone.test'])).toEqual([{ n: 0 }]);
    expect(await sql(srv, "SELECT user_id FROM auth_accounts WHERE account_id LIKE '%zz_test_jit_open_sub'")).toEqual([]);
    await configureSso(srv, ownerCookie, { group_roles: [{ group: 'zz-ops', role: 'admin' }] });
  });

  test('acceptation d’une invitation par l’IdP : adresse vérifiée identique exigée', async () => {
    const created = await srv.app.inject({ method: 'POST', url: '/api/invitations', headers: json(adminCookie), payload: { email: 'zz_test_oidc_invited@example.test', role: 'member' } });
    expect(created.statusCode, created.body).toBe(201);
    const link = created.json<{ link: string }>().link;
    const token = link.slice(link.lastIndexOf('/') + 1);
    idp.nextClaims = { sub: 'zz_test_inv_other', email: 'zz_test_someone_else@example.test', email_verified: true };
    expect((await oidcLogin(srv, `?invitation=${token}`)).location).toContain('sso_error=invitation_invalid');
    idp.nextClaims = { sub: 'zz_test_inv_sub', email: 'zz_test_oidc_invited@example.test', email_verified: true };
    const ok = await oidcLogin(srv, `?invitation=${token}`);
    expect(ok.location).toBe(`${PUBLIC_URL}/`);
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: ok.cookie } })).json()).toMatchObject({ email: 'zz_test_oidc_invited@example.test', role: 'member' });
    // Usage unique, y compris par l'IdP.
    expect((await oidcLogin(srv, `?invitation=${token}`)).location).toBe(`${PUBLIC_URL}/`); // identité déjà liée : simple connexion
    expect(await sql(srv, 'SELECT count(*)::int AS n FROM users WHERE email = $1', ['zz_test_oidc_invited@example.test'])).toEqual([{ n: 1 }]);
  });

  test('ID Token refusé : audience, émetteur, nonce ou signature altérés ; état absent', async () => {
    const user = await createUser(srv, 'zz_test_oidc_tamper@example.test');
    idp.nextClaims = { sub: 'zz_test_tamper_sub', email: user.email, email_verified: true };
    await oidcLink(srv, await signIn(srv, user), user.password);
    for (const tamper of ['aud', 'iss', 'nonce', 'signature'] as const) {
      idp.tamper = tamper;
      const res = await oidcLogin(srv);
      expect(res.location, tamper).toBe(`${PUBLIC_URL}/login?sso_error=idp_response_invalid`);
      expect(res.cookie, tamper).toBe('');
    }
    // Liaison lancée par un autre site : la mutation exige l'Origin de l'instance (13 § 5).
    const crossSite = await srv.app.inject({ method: 'POST', url: '/api/me/identities/oidc', headers: { cookie: ownerCookie, origin: 'https://evil.example.test' }, payload: { current_password: owner.password } });
    expect(crossSite.statusCode).toBe(403);
    // Retour sans le cookie d'état du navigateur (state lié au navigateur) : refus.
    const start = await srv.app.inject({ method: 'GET', url: '/api/auth/oidc/start' });
    const atIdp = await fetch(String(start.headers.location), { redirect: 'manual' });
    const callback = new URL(String(atIdp.headers.get('location')));
    const noState = await srv.app.inject({ method: 'GET', url: `${callback.pathname}${callback.search}` });
    expect(noState.headers.location).toBe(`${PUBLIC_URL}/login?sso_error=state_invalid`);
  });

  test('compte local à 2FA : la connexion OIDC sans amr exige le second facteur local', async () => {
    const user = await createUser(srv, 'zz_test_oidc_2fa@example.test');
    const local = await signIn(srv, user);
    const { secret, backupCodes } = await enableTwoFactor(srv, local, user);
    idp.nextClaims = { sub: 'zz_test_oidc_2fa_sub', email: user.email, email_verified: true };
    const full = sessionCookie(await srv.app.inject({ method: 'POST', url: '/api/auth/two-factor/verify', headers: json(sessionCookie(await login(srv, user))), payload: { code: totpFor(secret, 1) } }));
    await oidcLink(srv, full, user.password, backupCodes[0]);
    const res = await oidcLogin(srv);
    expect(res.location).toBe(`${PUBLIC_URL}/login?mfa=1`);
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: res.cookie } })).json<{ error: { code: string } }>().error.code).toBe('mfa_required');
  });

  test('assert_oidc_link_reauth : liaison après ré-authentification (mot de passe, second facteur si 2FA), jamais par simple navigation ; identités listées, retirées, signalées à la révocation', async () => {
    const user = await createUser(srv, 'zz_test_link@example.test');
    const cookie = await signIn(srv, user);
    // Une session seule (volée, poste resté ouvert) ne suffit plus : la liaison par GET n'existe plus.
    expect((await srv.app.inject({ method: 'GET', url: '/api/auth/oidc/start?intent=link', headers: { cookie, 'sec-fetch-site': 'same-origin' } })).statusCode).toBe(400);
    const wrong = await srv.app.inject({ method: 'POST', url: '/api/me/identities/oidc', headers: json(cookie), payload: { current_password: 'zz_test_wrong_password' } });
    expect(wrong.statusCode).toBe(403);
    idp.nextClaims = { sub: 'zz_test_link_sub', email: user.email, email_verified: true };
    expect((await oidcLink(srv, cookie, user.password)).location).toBe(`${PUBLIC_URL}/settings/account?sso=linked`);
    const listed = await srv.app.inject({ method: 'GET', url: '/api/me/identities', headers: { cookie } });
    const identities = listed.json<{ identities: { id: string; provider: string; issuer: string }[] }>().identities;
    expect(identities).toEqual([expect.objectContaining({ provider: 'oidc:zz-test-idp', issuer: idp.issuer })]);
    expect(listed.body).not.toContain('zz_test_link_sub');
    const linkedEvents = await sql<{ ip: string | null }>(srv, "SELECT ip FROM audit_events WHERE action = 'sso.linked' AND target_id = $1", [user.id]);
    expect(linkedEvents).toHaveLength(1);
    expect(linkedEvents[0]!.ip).not.toBeNull();

    // 2FA active : le second facteur est exigé aussi.
    const { backupCodes } = await enableTwoFactor(srv, cookie, user);
    const noCode = await srv.app.inject({ method: 'POST', url: '/api/me/identities/oidc', headers: json(cookie), payload: { current_password: user.password } });
    expect(noCode.json<{ error: { code: string } }>().error.code).toBe('mfa_code_required');
    const badCode = await srv.app.inject({ method: 'POST', url: '/api/me/identities/oidc', headers: json(cookie), payload: { current_password: user.password, code: '000000' } });
    expect(badCode.json<{ error: { code: string } }>().error.code).toBe('invalid_code');
    expect((await srv.app.inject({ method: 'POST', url: '/api/me/identities/oidc', headers: json(cookie), payload: { current_password: user.password, code: backupCodes[0] } })).statusCode).toBe(200);

    // Retrait par l'utilisateur (il garde son mot de passe) ; l'identité d'autrui répond 404.
    expect((await srv.app.inject({ method: 'DELETE', url: `/api/me/identities/${identities[0]!.id}`, headers: json(adminCookie) })).statusCode).toBe(404);
    expect((await srv.app.inject({ method: 'DELETE', url: `/api/me/identities/${identities[0]!.id}`, headers: json(cookie) })).statusCode).toBe(204);
    expect((await srv.app.inject({ method: 'GET', url: '/api/me/identities', headers: { cookie } })).json()).toEqual({ identities: [] });
    expect((await auditOf(srv, 'sso.unlinked')).at(-1)?.target_id).toBe(user.id);

    // Révocation complète par un admin : les liaisons restantes sont signalées dans l'audit.
    await sql(srv, 'INSERT INTO auth_accounts (user_id, provider_id, account_id) VALUES ($1, $2, $3)', [user.id, 'oidc:zz-test-idp', `${idp.issuer}|zz_test_link_sub2`]);
    expect((await srv.app.inject({ method: 'POST', url: `/api/users/${user.id}/revoke-access`, headers: json(adminCookie) })).statusCode).toBe(204);
    expect((await auditOf(srv, 'user.access_revoked')).at(-1)?.meta).toMatchObject({ oidc_identities: 1 });
  });

  test('sso_required : mot de passe local d’un non-owner, réponse identique juste ou faux ; owner en secours ; acceptation d’invitation par mot de passe refusée', async () => {
    const member = await createUser(srv, 'zz_test_ssoreq@example.test');
    const invited = await srv.app.inject({ method: 'POST', url: '/api/invitations', headers: json(adminCookie), payload: { email: 'zz_test_ssoreq_inv@example.test', role: 'member' } });
    const token = tokenOfLink(invited.json<{ link: string }>().link);
    await configureSso(srv, ownerCookie, { sso_required: true, group_roles: [{ group: 'zz-ops', role: 'admin' }] });
    try {
      const right = await login(srv, member);
      const wrong = await login(srv, { email: member.email, password: 'zz_test_wrong_password' });
      expect(right.statusCode).toBe(401);
      expect({ s: right.statusCode, b: right.body }).toEqual({ s: wrong.statusCode, b: wrong.body });
      expect(right.cookies.filter((c) => c.name.endsWith('sy.session') && c.value !== '')).toEqual([]);
      expect(await sql(srv, 'SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1', [member.id])).toEqual([{ n: 0 }]);
      expect((await login(srv, owner)).statusCode).toBe(200);
      const accept = await srv.app.inject({ method: 'POST', url: '/api/invitations/accept', remoteAddress: nextTestIp(), payload: { token, password: strongPassword() } });
      expect(accept.statusCode).toBe(403);
      expect(accept.json<{ error: { code: string } }>().error.code).toBe('sso_required');
      expect(await sql(srv, 'SELECT count(*)::int AS n FROM users WHERE email = $1', ['zz_test_ssoreq_inv@example.test'])).toEqual([{ n: 0 }]);
    } finally {
      await configureSso(srv, ownerCookie, { group_roles: [{ group: 'zz-ops', role: 'admin' }] });
    }
  });
});

describe('désactivation (13 § 6)', () => {
  test('assert_deactivation_revokes_all : membre désactivé, session, clé et jeton de tunnel refusés, 0 cookie de lui en base, planifications suspendues', async () => {
    const user = await createUser(srv, 'zz_test_deact@example.test');
    const cookie = await signIn(srv, user);
    const { key } = await createKey(srv, cookie, user);
    const code = (await srv.app.inject({ method: 'POST', url: '/api/extension/pairing-codes', headers: json(cookie), payload: { currentPassword: user.password } })).json<{ code: string }>().code;
    const device = (await srv.app.inject({ method: 'POST', url: '/api/extension/pair', payload: { code, deviceId: 'zz_test_deact_dev' } })).json<{ token: string }>().token;
    const ext = { authorization: `Bearer ${device}` };
    expect((await srv.app.inject({ method: 'PUT', url: '/api/extension/sites/zz-test-deact.example', headers: ext, payload: { serverUseAllowed: true } })).statusCode).toBe(201);
    const stored = await srv.app.inject({
      method: 'PUT',
      url: '/api/extension/sites/zz-test-deact.example/cookies',
      headers: ext,
      payload: { cookies: [{ name: 'sid', value: 'zz_test_deact_cookie', domain: 'zz-test-deact.example', path: '/', secure: false, httpOnly: true }] },
    });
    expect(stored.statusCode).toBe(204);
    const api = await sql<{ id: string }>(srv, "INSERT INTO apis (slug, owner_id) VALUES ('zz_test_deact_api', $1) RETURNING id", [user.id]);
    await sql(srv, "INSERT INTO schedules (api_id, owner_id, cron) VALUES ($1, $2, '0 * * * *')", [api[0]!.id, user.id]);

    const res = await srv.app.inject({ method: 'PATCH', url: `/api/users/${user.id}`, headers: json(adminCookie), payload: { status: 'disabled' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'disabled' });
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(401);
    expect((await srv.app.inject({ method: 'GET', url: '/api/extension/session', headers: ext })).statusCode).toBe(401);
    expect((await login(srv, user)).statusCode).toBe(401);
    expect(await sql(srv, 'SELECT count(*)::int AS n FROM site_sessions WHERE owner_id = $1', [user.id])).toEqual([{ n: 0 }]);
    expect(await sql(srv, 'SELECT count(*)::int AS n FROM schedules WHERE owner_id = $1 AND enabled', [user.id])).toEqual([{ n: 0 }]);
    // Runs, datasets et APIs restent au propriétaire.
    expect(await sql(srv, 'SELECT count(*)::int AS n FROM apis WHERE owner_id = $1', [user.id])).toEqual([{ n: 1 }]);

    // Suppression : désactivé d'abord (sinon 409), puis anonymisé (contenu restant) ; l'audit garde l'identifiant.
    const active = await createUser(srv, 'zz_test_delete_active@example.test');
    expect((await srv.app.inject({ method: 'DELETE', url: `/api/users/${active.id}`, headers: json(adminCookie) })).statusCode).toBe(409);
    expect((await srv.app.inject({ method: 'DELETE', url: `/api/users/${user.id}`, headers: json(adminCookie) })).statusCode).toBe(204);
    const anonymized = await sql<{ email: string; deleted_at: Date | null }>(srv, 'SELECT email, deleted_at FROM users WHERE id = $1', [user.id]);
    expect(anonymized[0]!.email).toBe(`deleted+${user.id}@deleted.invalid`);
    expect(anonymized[0]!.deleted_at).not.toBeNull();
    expect(await sql(srv, 'SELECT count(*)::int AS n FROM auth_accounts WHERE user_id = $1', [user.id])).toEqual([{ n: 0 }]);
    expect((await auditOf(srv, 'user.deleted')).at(-1)?.target_id).toBe(user.id);
  });
});

describe('hiérarchie (13 § 2)', () => {
  test('un admin ne promeut pas, ne se promeut pas, n’agit ni sur un autre admin ni sur l’owner : 403 et audit denied', async () => {
    const member = await createUser(srv, 'zz_test_h_member@example.test');
    const otherAdmin = await createUser(srv, 'zz_test_h_admin@example.test', 'admin');
    const cases: [string, Record<string, string>][] = [
      [member.id, { role: 'admin' }],
      [admin.id, { role: 'member' }],
      [otherAdmin.id, { status: 'disabled' }],
      [owner.id, { status: 'disabled' }],
    ];
    for (const [id, payload] of cases) {
      const res = await srv.app.inject({ method: 'PATCH', url: `/api/users/${id}`, headers: json(adminCookie), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(403);
    }
    expect((await srv.app.inject({ method: 'DELETE', url: `/api/users/${owner.id}`, headers: json(adminCookie) })).statusCode).toBe(403);
    // Sur un autre admin, un admin ne fait que révoquer sessions, clés et jetons.
    expect((await srv.app.inject({ method: 'POST', url: `/api/users/${otherAdmin.id}/revoke-access`, headers: json(adminCookie) })).statusCode).toBe(204);
    expect((await srv.app.inject({ method: 'POST', url: `/api/users/${owner.id}/revoke-access`, headers: json(adminCookie) })).statusCode).toBe(403);
    const denied = [...(await auditOf(srv, 'user.role_changed')), ...(await auditOf(srv, 'user.deactivated'))].filter((e) => e.outcome === 'denied');
    expect(denied.length).toBeGreaterThanOrEqual(4);
    expect(denied.every((e) => e.actor_user_id === admin.id)).toBe(true);
    // L'owner promeut et rétrograde ; il ne change pas son propre rôle.
    expect((await srv.app.inject({ method: 'PATCH', url: `/api/users/${member.id}`, headers: json(ownerCookie), payload: { role: 'admin' } })).json()).toMatchObject({ role: 'admin' });
    expect((await srv.app.inject({ method: 'PATCH', url: `/api/users/${owner.id}`, headers: json(ownerCookie), payload: { role: 'member' } })).statusCode).toBe(403);
    expect(await sql(srv, 'SELECT role FROM users WHERE id = $1', [owner.id])).toEqual([{ role: 'owner' }]);
  });

  test('liste paginée (admin), métadonnées seulement ; un membre est refusé', async () => {
    const page = await srv.app.inject({ method: 'GET', url: '/api/users?limit=2', headers: { cookie: adminCookie } });
    expect(page.statusCode).toBe(200);
    const body = page.json<{ users: { id: string; mfa_enabled: boolean }[]; next_cursor: string | null }>();
    expect(body.users).toHaveLength(2);
    expect(body.next_cursor).not.toBeNull();
    const next = await srv.app.inject({ method: 'GET', url: `/api/users?limit=2&cursor=${body.next_cursor}`, headers: { cookie: adminCookie } });
    expect(next.json<{ users: { id: string }[] }>().users.map((u) => u.id)).not.toContain(body.users[0]!.id);
    expect(page.body).not.toMatch(/password|hash/);
    const member = await createUser(srv, 'zz_test_h_list@example.test');
    expect((await srv.app.inject({ method: 'GET', url: '/api/users', headers: { cookie: await signIn(srv, member) } })).statusCode).toBe(403);
  });

  test('transfert de propriété : mot de passe ET code TOTP ; l’ancien owner devient admin', async () => {
    const isolated = await startTestServer('owner');
    try {
      const o = await runSetup(isolated);
      const oCookie = await signIn(isolated, o);
      const heir = await createUser(isolated, 'zz_test_heir@example.test', 'admin');
      const noMfa = await isolated.app.inject({ method: 'POST', url: '/api/owner/transfer', headers: json(oCookie), payload: { to_user_id: heir.id, current_password: o.password, totp_code: '000000' } });
      expect(noMfa.json<{ error: { code: string } }>().error.code).toBe('mfa_required');
      const { secret } = await enableTwoFactor(isolated, oCookie, o);
      const badCode = await isolated.app.inject({ method: 'POST', url: '/api/owner/transfer', headers: json(oCookie), payload: { to_user_id: heir.id, current_password: o.password, totp_code: '000000' } });
      expect(badCode.statusCode).toBe(400);
      const done = await isolated.app.inject({ method: 'POST', url: '/api/owner/transfer', headers: json(oCookie), payload: { to_user_id: heir.id, current_password: o.password, totp_code: totpFor(secret, 1) } });
      expect(done.statusCode, done.body).toBe(204);
      expect(await sql(isolated, 'SELECT id, role FROM users WHERE id = ANY($1::uuid[]) ORDER BY role', [[o.id, heir.id]])).toEqual([
        { id: o.id, role: 'admin' },
        { id: heir.id, role: 'owner' },
      ]);
    } finally {
      await isolated.close();
    }
  });
});

describe('réinitialisation du mot de passe (13 § 4, 13 § 5)', () => {
  test('lien d’admin seulement pour un compte à 2FA ; le lien seul ne suffit pas ; usage unique ; tous les accès révoqués', async () => {
    const plain = await createUser(srv, 'zz_test_reset_plain@example.test');
    expect((await srv.app.inject({ method: 'POST', url: `/api/users/${plain.id}/reset-link`, headers: json(adminCookie) })).json<{ error: { code: string } }>().error.code).toBe('mfa_required');

    const user = await createUser(srv, 'zz_test_reset@example.test');
    const cookie = await signIn(srv, user);
    const { secret } = await enableTwoFactor(srv, cookie, user);
    const { key } = await createKey(srv, sessionCookie(await srv.app.inject({ method: 'POST', url: '/api/auth/two-factor/verify', headers: json(sessionCookie(await login(srv, user))), payload: { code: totpFor(secret, 1) } })), user);
    const created = await srv.app.inject({ method: 'POST', url: `/api/users/${user.id}/reset-link`, headers: json(adminCookie) });
    expect(created.statusCode, created.body).toBe(201);
    const { link } = created.json<{ link: string; expires_at: string }>();
    const token = link.slice(link.lastIndexOf('/') + 1);
    // Toutes les sessions du compte sont fermées dès la création du lien.
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);

    const newPassword = strongPassword();
    const withoutCode = await srv.app.inject({ method: 'POST', url: '/api/auth/password-reset/confirm', payload: { token, password: newPassword } });
    expect(withoutCode.json<{ error: { code: string } }>().error.code).toBe('mfa_code_required');
    await rewindTotp(srv, user.id);
    const ok = await srv.app.inject({ method: 'POST', url: '/api/auth/password-reset/confirm', payload: { token, password: newPassword, code: totpFor(secret) } });
    expect(ok.statusCode, ok.body).toBe(204);
    const reused = await srv.app.inject({ method: 'POST', url: '/api/auth/password-reset/confirm', payload: { token, password: strongPassword(), code: totpFor(secret, 1) } });
    const unknown = await srv.app.inject({ method: 'POST', url: '/api/auth/password-reset/confirm', payload: { token: randomBytes(32).toString('base64url'), password: strongPassword() } });
    expect({ s: reused.statusCode, b: reused.body }).toEqual({ s: unknown.statusCode, b: unknown.body });
    // Clé d'API révoquée ; ancien mot de passe refusé, nouveau accepté.
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(401);
    expect((await login(srv, user)).statusCode).toBe(401);
    expect((await login(srv, { email: user.email, password: newPassword })).statusCode).toBe(200);
  });

  const confirmReset = (token: string, password: string, code?: string) =>
    srv.app.inject({ method: 'POST', url: '/api/auth/password-reset/confirm', remoteAddress: nextTestIp(), payload: { token, password, ...(code ? { code } : {}) } });

  test('assert_admin_reset_link_no_takeover : lien d’admin puis 2FA retirée → lien caduc ; 2FA disparue par un autre chemin → lien refusé, jamais consommé sans second facteur', async () => {
    const member = await createUser(srv, 'zz_test_takeover@example.test');
    await enableTwoFactor(srv, await signIn(srv, member), member);
    const created = await srv.app.inject({ method: 'POST', url: `/api/users/${member.id}/reset-link`, headers: json(adminCookie) });
    expect(created.statusCode, created.body).toBe(201);
    const token = tokenOfLink(created.json<{ link: string }>().link);
    // L'admin réinitialise ensuite la 2FA du membre : le lien qu'il détient ne doit plus rien valoir.
    expect((await srv.app.inject({ method: 'DELETE', url: `/api/users/${member.id}/2fa`, headers: json(adminCookie) })).statusCode).toBe(204);
    const takeover = await confirmReset(token, strongPassword());
    expect(takeover.json<{ error: { code: string } }>().error.code).toBe('reset_link_invalid');
    expect((await login(srv, member)).statusCode).toBe(200); // mot de passe inchangé

    // Même schéma par l'owner sur un admin, la 2FA disparaissant hors des routes (base) : le lien d'admin est refusé.
    const target = await createUser(srv, 'zz_test_takeover_admin@example.test', 'admin');
    await enableTwoFactor(srv, await signIn(srv, target), target);
    const link = (await srv.app.inject({ method: 'POST', url: `/api/users/${target.id}/reset-link`, headers: json(ownerCookie) })).json<{ link: string }>().link;
    await sql(srv, 'DELETE FROM two_factor WHERE user_id = $1', [target.id]);
    expect((await confirmReset(tokenOfLink(link), strongPassword())).json<{ error: { code: string } }>().error.code).toBe('reset_link_invalid');
    expect(await sql(srv, "SELECT count(*)::int AS n FROM verifications WHERE identifier LIKE 'reset%' AND identifier LIKE '%' || $1", [target.id])).toEqual([{ n: 0 }]);
    expect((await login(srv, target)).statusCode).toBe(200);
  });

  test('assert_reset_confirm_mfa_limited : second facteur du lien limité par compte toutes IP confondues (partagé avec la connexion) ; lien brûlé au 5e échec', async () => {
    const user = await createUser(srv, 'zz_test_reset_brute@example.test');
    const { secret } = await enableTwoFactor(srv, await signIn(srv, user), user);
    // 3 échecs du second facteur à la connexion…
    const pending = sessionCookie(await login(srv, user));
    for (let i = 0; i < 3; i += 1) {
      expect((await srv.app.inject({ method: 'POST', url: '/api/auth/two-factor/verify', headers: json(pending), payload: { code: '000000' } })).statusCode).toBe(400);
    }
    const token = tokenOfLink((await srv.app.inject({ method: 'POST', url: `/api/users/${user.id}/reset-link`, headers: json(adminCookie) })).json<{ link: string }>().link);
    // …puis 2 sur le lien, chacun depuis une adresse différente : le 5e échec du compte ferme tout.
    expect((await confirmReset(token, strongPassword(), '000000')).statusCode).toBe(400);
    expect((await confirmReset(token, strongPassword(), '000000')).statusCode).toBe(429);
    await rewindTotp(srv, user.id);
    expect((await confirmReset(token, strongPassword(), totpFor(secret))).json<{ error: { code: string } }>().error.code).toBe('reset_link_invalid');
    expect((await auditOf(srv, 'auth.password_reset')).some((e) => e.target_id === user.id && e.meta['reason'] === 'mfa_failures')).toBe(true);
    expect((await login(srv, user)).statusCode).toBe(200); // ancien mot de passe toujours valable
  });

  test('assert_operator_reset_link : lien de la commande serveur (compte sans 2FA), sessions fermées, audité, signalé à la connexion suivante', async () => {
    const user = await createUser(srv, 'zz_test_cli_reset@example.test');
    const cookie = await signIn(srv, user);
    const { token, hash } = generateOpaqueToken();
    const issued = await withClient(srv.db.url, (c) => issueOperatorResetLink(c, { email: user.email.toUpperCase() }, hash, 24));
    expect(issued).toMatchObject({ ok: true, userId: user.id });
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    const newPassword = strongPassword();
    expect((await confirmReset(token, newPassword)).statusCode).toBe(204);
    const next = await login(srv, { email: user.email, password: newPassword });
    expect(next.statusCode).toBe(200);
    expect(next.json<{ notices?: { code: string }[] }>().notices).toEqual([expect.objectContaining({ code: 'password_reset_by_operator' })]);
    // Signalé une fois.
    expect((await login(srv, { email: user.email, password: newPassword })).json<{ notices?: unknown }>().notices).toBeUndefined();
    const events = await sql<{ actor_via: string; outcome: string; meta: Record<string, unknown> }>(
      srv,
      "SELECT actor_via, outcome, meta FROM audit_events WHERE action = 'user.reset_link' AND target_id = $1",
      [user.id],
    );
    expect(events).toEqual([{ actor_via: 'system', outcome: 'success', meta: expect.objectContaining({ via: 'cli' }) }]);
  });

  test('mot de passe oublié avec SMTP : même réponse que l’adresse existe ou non, e-mail seulement pour un compte actif', async () => {
    const smtp = await startFakeSmtp();
    try {
      await saveSmtpSettings(srv.started.ctx.pool, srv.started.ctx.secrets!, { host: '127.0.0.1', port: smtp.port, security: 'none', from: 'runtime@scrapyomama.zz-test' });
      const user = await createUser(srv, 'zz_test_forgot@example.test');
      // Avec SMTP, pas de lien copiable par l'admin (13 § 4, § 6) : le membre passe par « mot de passe oublié ».
      const copyable = await srv.app.inject({ method: 'POST', url: `/api/users/${user.id}/reset-link`, headers: json(adminCookie) });
      expect(copyable.statusCode).toBe(409);
      expect(copyable.json<{ error: { code: string } }>().error.code).toBe('smtp_configured');
      const known = await srv.app.inject({ method: 'POST', url: '/api/auth/password-reset/request', payload: { email: user.email } });
      const unknown = await srv.app.inject({ method: 'POST', url: '/api/auth/password-reset/request', payload: { email: 'zz_test_nobody@example.test' } });
      expect({ s: known.statusCode, b: known.body }).toEqual({ s: unknown.statusCode, b: unknown.body });
      expect(known.statusCode).toBe(202);
      for (let i = 0; i < 50 && smtp.mails.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
      expect(smtp.mails.map((m) => m.to)).toEqual([[user.email]]);
      const link = /\/reset-password\/([A-Za-z0-9_-]{43})/.exec(smtp.mails[0]!.text)?.[1];
      const newPassword = strongPassword();
      expect((await srv.app.inject({ method: 'POST', url: '/api/auth/password-reset/confirm', payload: { token: link, password: newPassword } })).statusCode).toBe(204);
      expect((await login(srv, { email: user.email, password: newPassword })).statusCode).toBe(200);
    } finally {
      await sql(srv, "DELETE FROM settings WHERE key = 'smtp'");
      await smtp.close();
    }
  });
});

describe('D-15 : limite de connexion par compte et appareil reconnu', () => {
  test('assert_login_lock_recognized_device : compte verrouillé (10 échecs), un nouvel appareil reçoit 429, un appareil ou une session reconnus se connectent', async () => {
    const user = await createUser(srv, 'zz_test_d15@example.test');
    const first = await login(srv, user);
    expect(first.statusCode).toBe(200);
    const device = first.cookies.find((c) => c.name.endsWith('sy.device'));
    expect(device).toBeDefined();
    expect(JSON.stringify(await sql(srv, 'SELECT * FROM auth_known_devices WHERE user_id = $1', [user.id]))).not.toContain(device!.value);
    const lockOut = async () => {
      for (let i = 0; i < 10; i += 1) await login(srv, { email: user.email, password: 'zz_test_wrong_password' });
    };
    await lockOut();
    const stranger = await login(srv, user);
    expect(stranger.statusCode).toBe(429);
    const recognized = await login(srv, user, { cookie: `${device!.name}=${device!.value}` });
    expect(recognized.statusCode, recognized.body).toBe(200);
    await lockOut();
    const fromSession = await login(srv, user, { cookie: sessionCookie(first) });
    expect(fromSession.statusCode).toBe(200);
    // Un appareil reconnu pour un AUTRE compte ne lève pas la limite ; un mauvais mot de passe reste refusé.
    const other = await createUser(srv, 'zz_test_d15_other@example.test');
    const otherDevice = (await login(srv, other)).cookies.find((c) => c.name.endsWith('sy.device'))!;
    await lockOut();
    expect((await login(srv, user, { cookie: `${otherDevice.name}=${otherDevice.value}` })).statusCode).toBe(429);
    expect((await login(srv, { email: user.email, password: 'zz_test_wrong_password' }, { cookie: `${device!.name}=${device!.value}` })).statusCode).toBe(401);
    expect((await auditOf(srv, 'auth.login_rate_limit_waived')).map((e) => e.meta['recognized'])).toEqual(['device', 'session', 'device']);
  });
});

describe('sessions, audit et réglages', () => {
  test('sessions : liste des siennes, fermeture d’une session ou des autres', async () => {
    const user = await createUser(srv, 'zz_test_sessions@example.test');
    const a1 = await signIn(srv, user);
    const a2 = await signIn(srv, user);
    const list = await srv.app.inject({ method: 'GET', url: '/api/me/sessions', headers: { cookie: a1 } });
    const sessions = list.json<{ sessions: { id: string; current: boolean }[] }>().sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(list.body).not.toMatch(/token/i);
    expect((await srv.app.inject({ method: 'DELETE', url: '/api/me/sessions', headers: json(a1) })).statusCode).toBe(204);
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: a2 } })).statusCode).toBe(401);
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: a1 } })).statusCode).toBe(200);
  });

  test('audit : un membre lit les siens, l’admin l’instance (filtres), l’owner exporte en NDJSON', async () => {
    const user = await createUser(srv, 'zz_test_audit@example.test');
    const cookie = await signIn(srv, user);
    const mine = await srv.app.inject({ method: 'GET', url: '/api/me/audit', headers: { cookie } });
    const events = mine.json<{ events: { actor_user_id: string; action: string }[] }>().events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.actor_user_id === user.id)).toBe(true);
    expect((await srv.app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } })).statusCode).toBe(403);
    const filtered = await srv.app.inject({ method: 'GET', url: `/api/audit?actor=${user.id}&action=auth.login`, headers: { cookie: adminCookie } });
    expect(filtered.json<{ events: { action: string }[] }>().events.map((e) => e.action)).toEqual(['auth.login']);
    expect((await srv.app.inject({ method: 'GET', url: '/api/audit/export', headers: { cookie: adminCookie } })).statusCode).toBe(403);
    const exported = await srv.app.inject({ method: 'GET', url: '/api/audit/export', headers: { cookie: ownerCookie } });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toMatch(/application\/x-ndjson/);
    const lines = exported.body.trim().split('\n').map((l) => JSON.parse(l) as { action: string; meta: Record<string, unknown> });
    expect(lines.length).toBeGreaterThan(10);
    // Ni secret, ni jeton, ni mot de passe dans l'audit (13 § 9).
    expect(exported.body).not.toContain(idp.clientSecret);
    expect(exported.body).not.toContain(owner.password);
  });

  test('réglages de sécurité : owner seul ; durée de clé plafonnée ; inactivité appliquée', async () => {
    const security = { session_idle_minutes: 5, session_absolute_hours: 168, allowed_email_domains: [], api_key_max_lifetime_days: 30 };
    expect((await srv.app.inject({ method: 'PUT', url: '/api/settings/security', headers: json(adminCookie), payload: security })).statusCode).toBe(403);
    expect((await srv.app.inject({ method: 'PUT', url: '/api/settings/security', headers: json(ownerCookie), payload: { ...security, session_idle_minutes: 2 } })).statusCode).toBe(400);
    expect((await srv.app.inject({ method: 'PUT', url: '/api/settings/security', headers: json(ownerCookie), payload: security })).statusCode).toBe(200);
    try {
      const user = await createUser(srv, 'zz_test_settings@example.test');
      const cookie = await signIn(srv, user);
      const tooLong = await srv.app.inject({ method: 'POST', url: '/api/api-keys', headers: json(cookie), payload: { label: 'zz_test', scopes: ['apis:read'], currentPassword: user.password, expiresInDays: 90 } });
      expect(tooLong.statusCode).toBe(400);
      // Inactivité de plus de 5 minutes : session fermée.
      await sql(srv, "UPDATE auth_sessions SET last_seen_at = now() - interval '6 minutes' WHERE user_id = $1", [user.id]);
      await new Promise((r) => setTimeout(r, 2100)); // cache des réglages (2 s)
      expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    } finally {
      await resetSecurity();
    }
  });

  test('RFC 9728 : métadonnées de ressource protégée, 401 avec resource_metadata', async () => {
    const prm = await srv.app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
    expect(prm.json()).toMatchObject({ resource: `${PUBLIC_URL}/mcp`, bearer_methods_supported: ['header'] });
    const unauthorized = await srv.app.inject({ method: 'GET', url: '/api/me' });
    expect(unauthorized.headers['www-authenticate']).toBe(`Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`);
  });
});
