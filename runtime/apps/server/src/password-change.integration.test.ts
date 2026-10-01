// SPDX-License-Identifier: AGPL-3.0-only
// Changement de mot de passe depuis Mon compte (06 § 2, 13 § 5, 13 § 9 ; vérification de 3.8) sur base réelle :
// mot de passe actuel exigé (ré-authentification commune, limitée), politique du nouveau, audit sans valeur, fermeture
// des autres sessions PROPOSÉE (ASVS 7.4.3 : la session courante et les autres restent ouvertes tant que l'utilisateur
// ne les ferme pas), lien de réinitialisation en cours annulé, aucune clé d'API, compte OIDC seul refusé.
import { randomBytes } from 'node:crypto';
import { generateOpaqueToken } from '@runtime/core';
import { findResetLink, storeResetLink } from '@runtime/db';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { withClient } from '../../../tests/helpers/pg.js';
import { createKey, createUser, nextTestIp, PUBLIC_URL, runSetup, signIn, startTestServer, type TestServer } from '../../../tests/helpers/server.js';

let srv: TestServer;

beforeAll(async () => {
  srv = await startTestServer('pwchange');
  await runSetup(srv);
});
afterAll(async () => {
  await srv.close();
});

const strongPassword = () => `zz_test_${randomBytes(12).toString('base64url')}`;
const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => withClient(srv.db.url, async (c) => (await c.query<T>(text, params)).rows);
const change = (cookie: string, payload: Record<string, unknown>) =>
  srv.app.inject({ method: 'POST', url: '/api/me/password', headers: { cookie, origin: PUBLIC_URL }, payload });
const login = (email: string, password: string) =>
  srv.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', remoteAddress: nextTestIp(), headers: { origin: PUBLIC_URL }, payload: { email, password } });
const codeOf = (res: { json: <T>() => T }) => res.json<{ error: { code: string } }>().error.code;

describe('assert_password_change_reauth : Mon compte change le mot de passe (13 § 5, 13 § 9)', () => {
  test('mot de passe actuel exigé et vérifié ; nouveau mot de passe soumis à la politique ; rien ne change en cas de refus', async () => {
    const user = await createUser(srv, 'zz_test_pw_refusals@example.test');
    const cookie = await signIn(srv, user);
    const fresh = strongPassword();
    const missing = await change(cookie, { new_password: fresh });
    expect(missing.statusCode, missing.body).toBe(400);
    expect(codeOf(missing)).toBe('current_password_required');
    const wrong = await change(cookie, { current_password: 'zz_test_wrong_password', new_password: fresh });
    expect(wrong.statusCode).toBe(403);
    expect(codeOf(wrong)).toBe('reauth_failed');
    for (const weak of ['zz_short', 'password1234']) {
      const res = await change(cookie, { current_password: user.password, new_password: weak });
      expect(res.statusCode, weak).toBe(400);
      expect(codeOf(res)).toBe('weak_password');
    }
    // L'ancien mot de passe reste le bon ; le refus de ré-authentification est audité, sans aucune valeur.
    expect((await login(user.email, user.password)).statusCode).toBe(200);
    const denied = await sql<{ meta: Record<string, unknown> }>("SELECT meta FROM audit_events WHERE action = 'auth.password_change' AND outcome = 'denied' AND actor_user_id = $1", [user.id]);
    expect(denied.length).toBeGreaterThan(0);
    expect(JSON.stringify(denied)).not.toContain('zz_test_wrong_password');
  });

  test('succès : nouveau mot de passe actif, ancien refusé ; les autres sessions restent ouvertes et leur fermeture est proposée ; audit sans valeur', async () => {
    const user = await createUser(srv, 'zz_test_pw_ok@example.test');
    const current = await signIn(srv, user);
    const other = await signIn(srv, user);
    // Un lien de réinitialisation en cours ne doit pas survivre au changement (il remettrait un autre mot de passe).
    const { hash } = generateOpaqueToken();
    await withClient(srv.db.url, (c) => storeResetLink(c, 'email', user.id, hash, 1));
    const next = strongPassword();
    const res = await change(current, { current_password: user.password, new_password: next });
    expect(res.statusCode, res.body).toBe(200);
    // La console propose « fermer les autres sessions » : elle reçoit leur nombre, rien n'est fermé d'office.
    expect(res.json()).toEqual({ other_sessions: 1 });
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: current } })).statusCode).toBe(200);
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: other } })).statusCode).toBe(200);
    expect((await login(user.email, user.password)).statusCode).toBe(401);
    expect((await login(user.email, next)).statusCode).toBe(200);
    const events = await sql<{ outcome: string; meta: Record<string, unknown> }>("SELECT outcome, meta FROM audit_events WHERE action = 'auth.password_changed' AND actor_user_id = $1", [user.id]);
    expect(events).toEqual([{ outcome: 'success', meta: { other_sessions: 1, reset_links_revoked: 1 } }]);
    expect(await withClient(srv.db.url, (c) => findResetLink(c, hash))).toBeNull();
    expect(JSON.stringify(await sql('SELECT meta FROM audit_events WHERE actor_user_id = $1', [user.id]))).not.toMatch(new RegExp(`${user.password}|${next}`));
    // La proposition acceptée : DELETE /api/me/sessions ferme les autres, garde la courante.
    expect((await srv.app.inject({ method: 'DELETE', url: '/api/me/sessions', headers: { cookie: current, origin: PUBLIC_URL } })).statusCode).toBe(204);
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: other } })).statusCode).toBe(401);
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: current } })).statusCode).toBe(200);
  });

  test('ni clé d’API, ni compte sans mot de passe local (OIDC seul) ; GET /api/me dit si la 2FA est exigée (mfaRequired)', async () => {
    const user = await createUser(srv, 'zz_test_pw_key@example.test');
    const cookie = await signIn(srv, user);
    const key = await createKey(srv, cookie, user, ['apis:read']);
    const byKey = await srv.app.inject({ method: 'POST', url: '/api/me/password', headers: { authorization: `Bearer ${key.key}` }, payload: { current_password: user.password, new_password: strongPassword() } });
    expect(byKey.statusCode).toBe(403);
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json()).toMatchObject({ mfaRequired: false, mfaEnabled: false });
    await sql("DELETE FROM auth_accounts WHERE user_id = $1 AND provider_id = 'credential'", [user.id]);
    const oidcOnly = await change(cookie, { new_password: strongPassword() });
    expect(oidcOnly.statusCode, oidcOnly.body).toBe(409);
    expect(codeOf(oidcOnly)).toBe('no_local_password');
  });
});
