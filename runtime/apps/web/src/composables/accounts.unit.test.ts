// SPDX-License-Identifier: AGPL-3.0-only
// Composables des comptes (tâche 3.8) : second facteur et signalements de la session, parcours publics (premier démarrage,
// invitation), utilisateurs et invitations (lien montré une fois), clés d'API (secret montré une fois), 2FA, audit, réglages d'instance.
// Faux serveur REST ; aucun mot de passe, code ou secret ne reste en mémoire d'écran après son affichage ou son envoi.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { acceptInvitation, confirmPasswordReset, postSetup, requestPasswordReset } from '@/composables/useAccountFlows';
import { useCloseOtherSessions, usePasswordChange, useTwoFactor } from '@/composables/useAccount';
import { useApiKeys, keyState } from '@/composables/useApiKeys';
import { dayBound, useAudit } from '@/composables/useAudit';
import { parseDomains, useIdentitySettings, useSecuritySettings, useSsoSettings } from '@/composables/useInstanceSettings';
import { can, dismissNotices, loadSession, resetSession, signIn, useSession, verifySecondFactor } from '@/composables/useSession';
import { useUsers } from '@/composables/useUsers';
import { onMfaBarrier, setApi } from '@/lib/api';
import { createAppRouter } from '@/router/index';
import { ROLE_PERMISSIONS } from '@/testing/permissions';
import { installFakeServer, json, ME, signedIn } from '@/testing/console.testkit';

beforeEach(() => resetSession());
afterEach(() => {
  setApi(undefined);
  resetSession();
});

const SESSION = { session: { id: 's' }, user: { id: ME.id, email: ME.email } };
const full = { 'GET /api/auth/get-session': () => json(200, SESSION), 'GET /api/me': () => json(200, ME) };
const err = (status: number, code: string) => json(status, { error: { code, message: 'x' } });

describe('session : permissions, second facteur, signalements', () => {
  test('can() lit les permissions du serveur ; sans identité, rien n’est permis ; une permission absente est refusée', async () => {
    expect(can('users:list')).toBe(false);
    installFakeServer({ ...full, 'GET /api/me': () => json(200, { ...ME, role: 'member', permissions: ROLE_PERMISSIONS.member }) });
    await loadSession();
    expect(can('account:update')).toBe(true);
    expect(can('users:list')).toBe(false);
    expect(can('audit:read')).toBe(false);
    expect(can('settings:sso:write')).toBe(false);
    installFakeServer(full);
    await loadSession();
    expect(can('users:list')).toBe(true);
    expect(can('settings:sso:write')).toBe(true);
    // Les lignes « — » de la matrice (INV5) ne sont accordées à personne, owner compris.
    expect(can('sites:read_cookies')).toBe(false);
    expect(can('tunnel:route_other')).toBe(false);
  });

  test('mot de passe vérifié, second facteur attendu : état mfa_pending (403 mfa_required de /api/me), jamais « connecté »', async () => {
    installFakeServer({
      'POST /api/auth/sign-in/email': () => json(200, { redirect: false, twoFactorRequired: true, user: { id: ME.id, email: ME.email } }),
      'GET /api/auth/get-session': () => json(200, SESSION),
      'GET /api/me': () => err(403, 'mfa_required'),
    });
    expect(await signIn(ME.email, 'pw')).toEqual({ ok: true });
    expect(useSession().state.value).toBe('mfa_pending');
    expect(useSession().isAuthenticated.value).toBe(false);
    expect(useSession().me.value).toBeNull();
  });

  test('second facteur : code accepté → connecté ; code refusé ou rejoué → invalid_code ; trop d’essais ; session en attente expirée → reconnexion', async () => {
    let verdict: 'ok' | 'bad' | 'limit' | 'expired' = 'ok';
    const seen: unknown[] = [];
    installFakeServer({
      'POST /api/auth/two-factor/verify': (call) => {
        seen.push(call.body);
        if (verdict === 'bad') return err(400, 'invalid_code');
        if (verdict === 'limit') return err(429, 'too_many_attempts');
        if (verdict === 'expired') return err(401, 'unauthorized');
        return json(200, { ok: true, method: 'totp', notices: [{ code: 'password_reset_by_operator', at: '2026-10-01T08:00:00.000Z' }] });
      },
      ...full,
    });
    verdict = 'bad';
    expect(await verifySecondFactor('000000')).toEqual({ ok: false, failure: 'invalid_code' });
    verdict = 'limit';
    expect(await verifySecondFactor('000000')).toEqual({ ok: false, failure: 'too_many_attempts' });
    verdict = 'expired';
    expect(await verifySecondFactor('000000')).toEqual({ ok: false, failure: 'session_expired' });
    expect(useSession().state.value).toBe('anonymous');
    verdict = 'ok';
    expect(await verifySecondFactor('123456')).toEqual({ ok: true });
    expect(useSession().state.value).toBe('authenticated');
    expect(seen.at(-1)).toEqual({ code: '123456' });
    // Le signalement reçu avec la session complète est montré une fois, puis effacé.
    expect(useSession().notices.value).toEqual([{ code: 'password_reset_by_operator', at: '2026-10-01T08:00:00.000Z' }]);
    dismissNotices();
    expect(useSession().notices.value).toEqual([]);
  });

  test('un signalement arrive aussi avec la connexion sans second facteur', async () => {
    installFakeServer({ 'POST /api/auth/sign-in/email': () => json(200, { user: { id: ME.id, email: ME.email }, notices: [{ code: 'password_reset_withheld', at: '2026-10-01T08:00:00.000Z' }] }), ...full });
    await signIn(ME.email, 'pw');
    expect(useSession().notices.value).toHaveLength(1);
  });

  test('enrôlement exigé : la session est authentifiée mais mustEnrollTwoFactor le dit', async () => {
    installFakeServer({ ...full, 'GET /api/me': () => json(200, { ...ME, role: 'admin', permissions: ROLE_PERMISSIONS.admin, mfaEnrollmentRequired: true }) });
    await loadSession();
    expect(useSession().state.value).toBe('authenticated');
    expect(useSession().mustEnrollTwoFactor.value).toBe(true);
  });

  test('une réponse 403 mfa_required ou mfa_enrollment_required d’une route relit l’identité (barrière de 13 § 7) ; un autre 403 non', async () => {
    let code = 'mfa_enrollment_required';
    installFakeServer({ 'GET /api/api-keys': () => err(403, code), ...full });
    let relire = 0;
    const off = onMfaBarrier(() => (relire += 1));
    const { getApi } = await import('@/lib/api');
    await getApi().GET('/api/api-keys');
    code = 'mfa_required';
    await getApi().GET('/api/api-keys');
    code = 'forbidden';
    await getApi().GET('/api/api-keys');
    off();
    expect(relire).toBe(2);
  });
});

describe('garde du routeur : second facteur, enrôlement forcé, assistant de premier démarrage', () => {
  async function go(routes: Record<string, (call: never) => Response>, path: string) {
    installFakeServer(routes as never);
    resetSession();
    const router = createAppRouter(createMemoryHistory());
    await router.push(path);
    return router.currentRoute.value;
  }

  test('second facteur attendu : toute page mène à la connexion (?mfa=1), qui montre la saisie du code', async () => {
    const routes = { 'GET /api/auth/get-session': () => json(200, SESSION), 'GET /api/me': () => err(403, 'mfa_required') };
    for (const path of ['/', '/apis', '/admin/users', '/settings/account']) {
      const route = await go(routes, path);
      expect(route.name, path).toBe('login');
      expect(route.query.mfa).toBe('1');
    }
  });

  test('enrôlement forcé (MFA_ENFORCED) : seule la page d’enrôlement s’ouvre, avant toute autre route', async () => {
    const routes = { ...full, 'GET /api/me': () => json(200, { ...ME, mfaEnrollmentRequired: true }) };
    for (const path of ['/', '/apis', '/admin/users', '/settings/account', '/runs']) expect((await go(routes, path)).name, path).toBe('two-factor-setup');
  });

  test('sans enrôlement exigé, la page d’enrôlement renvoie au compte', async () => {
    expect((await go(full, '/two-factor-setup')).name).toBe('settings-account');
  });

  test('instance sans owner : seul /setup s’ouvre ; instance initialisée : /setup est introuvable pour toujours', async () => {
    const uninitialized = { 'GET /api/auth/get-session': () => err(503, 'not_initialized') };
    for (const path of ['/', '/login', '/invite/abc', '/reset-password/abc', '/setup']) expect((await go(uninitialized, path)).name, path).toBe('setup');
    const anonymous = { 'GET /api/auth/get-session': () => json(200, null) };
    const route = await go(anonymous, '/setup');
    expect(route.name).toBe('not-found');
    expect(route.path).toBe('/setup');
    expect((await go(full, '/setup')).name).toBe('not-found');
  });

  test('invitation et réinitialisation : joignables sans session comme avec une session ; mot de passe oublié fermé aux sessions', async () => {
    const anonymous = { 'GET /api/auth/get-session': () => json(200, null) };
    expect((await go(anonymous, '/invite/zz-token')).name).toBe('invite');
    expect((await go(anonymous, '/reset-password/zz-token')).name).toBe('reset-password');
    expect((await go(anonymous, '/forgot-password')).name).toBe('forgot-password');
    expect((await go(full, '/invite/zz-token')).name).toBe('invite');
    expect((await go(full, '/reset-password/zz-token')).name).toBe('reset-password');
    expect((await go(full, '/forgot-password')).name).toBe('home');
  });
});

describe('parcours publics', () => {
  test('premier démarrage : jeton, e-mail, mot de passe, nom ; l’empreinte revient avec la réponse', async () => {
    const calls = installFakeServer({ 'POST /api/setup': () => json(201, { userId: ME.id, keyFingerprint: 'zz-fp', reminder: 'x' }) });
    const result = await postSetup({ token: 't', email: 'a@x.test', password: 'p', displayName: 'Ada' });
    expect(result).toMatchObject({ ok: true, data: { keyFingerprint: 'zz-fp' } });
    expect(calls[0]?.body).toEqual({ token: 't', email: 'a@x.test', password: 'p', displayName: 'Ada' });
    await postSetup({ token: 't', email: 'a@x.test', password: 'p', displayName: '' });
    expect(calls[1]?.body).toEqual({ token: 't', email: 'a@x.test', password: 'p' });
  });

  test('premier démarrage : jeton refusé (403), mot de passe refusé (400), assistant clos (404), trop d’essais (429) → codes stables', async () => {
    const routes: Record<string, () => Response> = { 'POST /api/setup': () => err(403, 'forbidden') };
    installFakeServer(routes);
    expect(await postSetup({ token: 'x', email: 'a@x.test', password: 'p' })).toMatchObject({ ok: false, status: 403, code: 'forbidden' });
    routes['POST /api/setup'] = () => err(400, 'weak_password');
    expect(await postSetup({ token: 'x', email: 'a@x.test', password: 'p' })).toMatchObject({ ok: false, code: 'weak_password', messageKey: 'errors.weak_password' });
    routes['POST /api/setup'] = () => err(404, 'not_found');
    expect(await postSetup({ token: 'x', email: 'a@x.test', password: 'p' })).toMatchObject({ ok: false, status: 404 });
    routes['POST /api/setup'] = () => err(429, 'too_many_attempts');
    expect(await postSetup({ token: 'x', email: 'a@x.test', password: 'p' })).toMatchObject({ ok: false, status: 429, code: 'too_many_attempts' });
  });

  test('invitation : le serveur ouvre la session, la console relit l’identité ; un jeton inutilisable reçoit le même code quel qu’en soit le motif', async () => {
    let accepted = false;
    const calls = installFakeServer({
      'POST /api/invitations/accept': (call) => {
        const token = (call.body as { token: string }).token;
        if (token !== 'bon') return err(400, 'invitation_invalid');
        accepted = true;
        return json(200, ME);
      },
      'GET /api/auth/get-session': () => json(200, accepted ? SESSION : null),
      'GET /api/me': () => json(200, ME),
    });
    const refused = await Promise.all(['inconnu', 'expire', 'consomme'].map((token) => acceptInvitation({ token, password: 'p' })));
    expect(new Set(refused.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(refused[0]).toMatchObject({ ok: false, code: 'invitation_invalid', messageKey: 'errors.invitation_invalid' });
    expect(useSession().state.value).not.toBe('authenticated');
    expect(await acceptInvitation({ token: 'bon', password: 'p', displayName: 'Ada' })).toMatchObject({ ok: true });
    expect(useSession().state.value).toBe('authenticated');
    expect(calls.filter((c) => c.path === '/api/invitations/accept').at(-1)?.body).toEqual({ token: 'bon', password: 'p', display_name: 'Ada' });
  });

  test('mot de passe oublié et réinitialisation : corps minimal, code de second facteur seulement s’il est saisi', async () => {
    const calls = installFakeServer({
      'POST /api/auth/password-reset/request': () => json(202, { status: 'accepted' }),
      'POST /api/auth/password-reset/confirm': () => json(204, null),
    });
    expect(await requestPasswordReset('a@x.test')).toMatchObject({ ok: true });
    expect(await confirmPasswordReset({ token: 't', password: 'p' })).toMatchObject({ ok: true });
    expect(await confirmPasswordReset({ token: 't', password: 'p', code: '123456' })).toMatchObject({ ok: true });
    expect(calls.map((c) => c.body)).toEqual([{ email: 'a@x.test' }, { token: 't', password: 'p' }, { token: 't', password: 'p', code: '123456' }]);
  });
});

describe('utilisateurs et invitations', () => {
  const created = (over: Record<string, unknown> = {}) => ({ id: 'i1', email: 'fay@x.test', role: 'member', invited_by: ME.id, expires_at: '2099-01-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z', accepted_at: null, revoked_at: null, emailed: false, link: 'https://i.test/invite/zz-lien-unique', ...over });
  const lists = { 'GET /api/invitations': () => json(200, { invitations: [] }), 'GET /api/users': () => json(200, { users: [], next_cursor: null }) };

  test('sans SMTP : le lien est montré une fois, copiable ; le fermer l’efface ; il n’est jamais relu', async () => {
    const calls = installFakeServer({ ...lists, 'POST /api/invitations': () => json(201, created()) });
    const users = useUsers();
    expect(await users.invite('fay@x.test', 'member')).toBe(true);
    expect(users.oneTimeLink.value).toMatchObject({ kind: 'invitation', subject: 'fay@x.test', link: 'https://i.test/invite/zz-lien-unique' });
    expect(users.notice.value).toBeNull();
    users.dismissLink();
    expect(users.oneTimeLink.value).toBeNull();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ email: 'fay@x.test', role: 'member' });
    // La relecture des listes ne ramène jamais le lien.
    await users.invitations.refetch();
    expect(JSON.stringify(users.invitations.data.value)).not.toContain('zz-lien-unique');
  });

  test('avec SMTP : aucun lien affiché, un message « envoyé à… »', async () => {
    installFakeServer({ ...lists, 'POST /api/invitations': () => json(201, created({ emailed: true, link: null })) });
    const users = useUsers();
    await users.invite('fay@x.test', 'admin');
    expect(users.oneTimeLink.value).toBeNull();
    expect(users.notice.value).toEqual({ key: 'users.invite.emailed', params: { email: 'fay@x.test' } });
  });

  test('refus du serveur : code stable traduit, aucun lien', async () => {
    const routes: Record<string, () => Response> = { ...lists, 'POST /api/invitations': () => err(409, 'user_exists') };
    installFakeServer(routes);
    const users = useUsers();
    expect(await users.invite('x@x.test', 'member')).toBe(false);
    expect(users.failure.value).toBe('errors.user_exists');
    routes['POST /api/invitations'] = () => err(403, 'forbidden');
    expect(await users.invite('x@x.test', 'admin')).toBe(false);
    expect(users.failure.value).toBe('errors.forbidden');
    expect(users.oneTimeLink.value).toBeNull();
  });

  test('renvoi et révocation d’une invitation', async () => {
    const calls = installFakeServer({
      ...lists,
      'POST /api/invitations/i1/resend': () => json(200, created({ link: 'https://i.test/invite/zz-nouveau' })),
      'DELETE /api/invitations/i1': () => json(204, null),
    });
    const users = useUsers();
    const invitation = { id: 'i1', email: 'fay@x.test', role: 'member', invited_by: ME.id, expires_at: '2099-01-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z', accepted_at: null, revoked_at: null } as const;
    await users.resend(invitation);
    expect(users.oneTimeLink.value?.link).toBe('https://i.test/invite/zz-nouveau');
    await users.revokeInvitation(invitation);
    expect(users.notice.value?.key).toBe('users.done.invitationRevoked');
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/invitations/i1')).toBe(true);
  });

  test('lien de réinitialisation : affiché une fois ; refusé avec SMTP ou sans 2FA par un code stable', async () => {
    const routes: Record<string, () => Response> = { ...lists, 'POST /api/users/u1/reset-link': () => json(201, { link: 'https://i.test/reset-password/zz-lien', expires_at: '2099-01-01T00:00:00Z' }) };
    installFakeServer(routes);
    const users = useUsers();
    const target = { id: 'u1', email: 'm@x.test', display_name: 'Mia', role: 'member', status: 'active', mfa_enabled: true, created_at: '2026-09-01T00:00:00Z', last_login_at: null } as const;
    expect(await users.createResetLink(target)).toBe(true);
    expect(users.oneTimeLink.value).toMatchObject({ kind: 'reset', subject: 'Mia', link: 'https://i.test/reset-password/zz-lien' });
    users.dismissLink();
    routes['POST /api/users/u1/reset-link'] = () => err(409, 'smtp_configured');
    expect(await users.createResetLink(target)).toBe(false);
    expect(users.failure.value).toBe('errors.smtp_configured');
    routes['POST /api/users/u1/reset-link'] = () => err(409, 'mfa_required');
    await users.createResetLink(target);
    expect(users.failure.value).toBe('errors.mfa_required');
    expect(users.oneTimeLink.value).toBeNull();
  });

  test('rôle, statut, suppression, accès, 2FA : une requête chacun, la liste est relue', async () => {
    const calls = installFakeServer({
      ...lists,
      'PATCH /api/users/u1': () => json(200, {}),
      'DELETE /api/users/u1': () => json(204, null),
      'POST /api/users/u1/revoke-access': () => json(204, null),
      'DELETE /api/users/u1/2fa': () => json(204, null),
    });
    const users = useUsers();
    const target = { id: 'u1', email: 'm@x.test', display_name: '', role: 'member', status: 'active', mfa_enabled: true, created_at: '2026-09-01T00:00:00Z', last_login_at: null } as const;
    await users.setRole(target, 'admin');
    await users.setStatus(target, 'disabled');
    await users.setStatus(target, 'active');
    await users.revokeAccess(target);
    await users.resetTwoFactor(target);
    await users.remove(target);
    expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path} ${JSON.stringify(c.body)}`)).toEqual([
      'PATCH /api/users/u1 {"role":"admin"}',
      'PATCH /api/users/u1 {"status":"disabled"}',
      'PATCH /api/users/u1 {"status":"active"}',
      'POST /api/users/u1/revoke-access null',
      'DELETE /api/users/u1/2fa null',
      'DELETE /api/users/u1 null',
    ]);
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/users').length).toBeGreaterThanOrEqual(5);
  });

  test('transfert de propriété : mot de passe et code partent une fois ; l’identité est relue ensuite', async () => {
    let transferred = false;
    const calls = installFakeServer({
      ...lists,
      'POST /api/owner/transfer': () => {
        transferred = true;
        return json(204, null);
      },
      'GET /api/auth/get-session': () => json(200, SESSION),
      'GET /api/me': () => json(200, transferred ? { ...ME, role: 'admin', permissions: ROLE_PERMISSIONS.admin } : ME),
    });
    await signedIn();
    const users = useUsers();
    expect(await users.transferOwnership({ toUserId: 'u1', currentPassword: 'pw', totpCode: '123456' })).toBe(true);
    expect(calls.find((c) => c.path === '/api/owner/transfer')?.body).toEqual({ to_user_id: 'u1', totp_code: '123456', current_password: 'pw' });
    expect(useSession().me.value?.role).toBe('admin');
    expect(can('owner:transfer')).toBe(false);
  });
});

describe('clés d’API : le secret n’apparaît qu’une fois', () => {
  const key = { id: 'k1', label: 'Outil', prefix: 'sy_live_ab12', scopes: ['apis:read'], expiresAt: '2099-01-01T00:00:00Z', lastUsedAt: null, createdAt: '2026-10-01T00:00:00Z', revokedAt: null };

  test('création : secret gardé le temps de l’affichage ; la liste relue n’en contient pas ; le fermer l’efface', async () => {
    const calls = installFakeServer({
      'POST /api/api-keys': () => json(201, { ...key, key: 'sy_live_zz_secret_unique' }),
      'GET /api/api-keys': () => json(200, { items: [key] }),
    });
    const keys = useApiKeys();
    expect(await keys.create({ label: 'Outil', scopes: ['apis:read'], expiresInDays: 30, currentPassword: 'pw' })).toBe(true);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ label: 'Outil', scopes: ['apis:read'], expiresInDays: 30, currentPassword: 'pw' });
    expect(keys.created.value).toEqual({ label: 'Outil', key: 'sy_live_zz_secret_unique' });
    expect(JSON.stringify(keys.keys.value)).not.toContain('zz_secret_unique');
    keys.dismissCreated();
    expect(keys.created.value).toBeNull();
  });

  test('mot de passe vide (compte SSO seul) : champ omis ; durée absente : défaut du serveur ; refus : code stable', async () => {
    const routes: Record<string, () => Response> = { 'POST /api/api-keys': () => err(403, 'reauth_failed'), 'GET /api/api-keys': () => json(200, { items: [] }) };
    const calls = installFakeServer(routes);
    const keys = useApiKeys();
    expect(await keys.create({ label: 'A', scopes: ['runs:read'], expiresInDays: null, currentPassword: '' })).toBe(false);
    expect(keys.failure.value).toBe('errors.reauth_failed');
    expect(keys.created.value).toBeNull();
    expect(calls[0]?.body).toEqual({ label: 'A', scopes: ['runs:read'] });
    routes['POST /api/api-keys'] = () => err(400, 'lifetime_too_long');
    await keys.create({ label: 'A', scopes: ['runs:read'], expiresInDays: 9999, currentPassword: 'pw' });
    expect(keys.failure.value).toBe('errors.lifetime_too_long');
  });

  test('état d’une clé : active, expirée, révoquée', () => {
    const now = Date.parse('2026-10-01T00:00:00Z');
    expect(keyState({ revokedAt: null, expiresAt: '2099-01-01T00:00:00Z' }, now)).toBe('active');
    expect(keyState({ revokedAt: null, expiresAt: '2026-09-01T00:00:00Z' }, now)).toBe('expired');
    expect(keyState({ revokedAt: '2026-09-15T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' }, now)).toBe('revoked');
  });
});

describe('2FA du compte', () => {
  test('activation : mot de passe, graine affichée une fois, premier code, codes de secours rangés puis effacés ; l’identité est relue', async () => {
    let enabled = false;
    const calls = installFakeServer({
      'POST /api/me/2fa/enroll': () => json(200, { otpauth_uri: 'otpauth://totp/x?secret=ABC', secret: 'ABC' }),
      'POST /api/me/2fa/confirm': () => {
        enabled = true;
        return json(200, { backup_codes: ['a-1', 'b-2', 'c-3', 'd-4', 'e-5', 'f-6', 'g-7', 'h-8', 'i-9', 'j-0'] });
      },
      'GET /api/auth/get-session': () => json(200, SESSION),
      'GET /api/me': () => json(200, { ...ME, mfaEnabled: enabled }),
    });
    const twoFactor = useTwoFactor();
    expect(await twoFactor.start('pw')).toBe(true);
    expect(twoFactor.phase.value).toBe('enrolling');
    expect(twoFactor.enrollment.value?.secret).toBe('ABC');
    expect(calls[0]?.body).toEqual({ current_password: 'pw' });
    expect(await twoFactor.confirm('123456')).toBe(true);
    expect(twoFactor.phase.value).toBe('backup');
    expect(twoFactor.enrollment.value).toBeNull();
    expect(twoFactor.backupCodes.value).toHaveLength(10);
    expect(useSession().me.value?.mfaEnabled).toBe(true);
    twoFactor.acknowledgeBackup();
    expect(twoFactor.backupCodes.value).toEqual([]);
    expect(twoFactor.phase.value).toBe('idle');
  });

  test('erreurs : mot de passe faux, déjà active, code invalide, retrait refusé par MFA_ENFORCED, ré-authentification périmée', async () => {
    const routes: Record<string, () => Response> = {
      'POST /api/me/2fa/enroll': () => err(403, 'reauth_failed'),
      'POST /api/me/2fa/confirm': () => err(400, 'invalid_code'),
      'DELETE /api/me/2fa': () => err(403, 'mfa_enforced'),
      'POST /api/me/2fa/backup-codes': () => err(403, 'reauth_required'),
    };
    installFakeServer(routes);
    const twoFactor = useTwoFactor();
    expect(await twoFactor.start('mauvais')).toBe(false);
    expect(twoFactor.failure.value).toBe('errors.reauth_failed');
    routes['POST /api/me/2fa/enroll'] = () => err(409, 'mfa_already_enabled');
    await twoFactor.start('pw');
    expect(twoFactor.failure.value).toBe('errors.mfa_already_enabled');
    routes['POST /api/me/2fa/enroll'] = () => json(200, { otpauth_uri: 'otpauth://x', secret: 'ABC' });
    await twoFactor.start('pw');
    expect(await twoFactor.confirm('000000')).toBe(false);
    expect(twoFactor.failure.value).toBe('errors.invalid_code');
    expect(twoFactor.phase.value).toBe('enrolling');
    expect(await twoFactor.disable('pw', '123456')).toBe(false);
    expect(twoFactor.failure.value).toBe('errors.mfa_enforced');
    expect(await twoFactor.regenerate('', '123456')).toBe(false);
    expect(twoFactor.failure.value).toBe('errors.reauth_required');
    twoFactor.cancel();
    expect(twoFactor.enrollment.value).toBeNull();
    expect(twoFactor.phase.value).toBe('idle');
  });

  test('régénération et retrait : mot de passe seulement s’il est saisi (compte SSO seul), code toujours', async () => {
    const calls = installFakeServer({
      'POST /api/me/2fa/backup-codes': () => json(200, { backup_codes: ['a-1', 'b-2', 'c-3', 'd-4', 'e-5', 'f-6', 'g-7', 'h-8', 'i-9', 'j-0'] }),
      'DELETE /api/me/2fa': () => json(204, null),
      ...full,
    });
    const twoFactor = useTwoFactor();
    await twoFactor.regenerate('pw', '111111');
    expect(twoFactor.phase.value).toBe('backup');
    await twoFactor.disable('', '222222');
    expect(calls.map((c) => c.body)).toContainEqual({ code: '111111', current_password: 'pw' });
    expect(calls.map((c) => c.body)).toContainEqual({ code: '222222' });
  });
});

describe('assert_password_change_reauth : mot de passe du compte (06 § 2, 13 § 5)', () => {
  test('changement : mot de passe actuel et nouveau partent une fois ; les autres sessions restent ouvertes et leur fermeture est proposée', async () => {
    const calls = installFakeServer({ 'POST /api/me/password': () => json(200, { other_sessions: 2 }), 'DELETE /api/me/sessions': () => json(204, null) });
    const password = usePasswordChange();
    expect(await password.change('zz_old_password', 'zz_new_password_long', 'zz_new_password_long')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/me/password', body: { current_password: 'zz_old_password', new_password: 'zz_new_password_long' } });
    expect(password.done.value).toBe(true);
    expect(password.otherSessions.value).toBe(2);
    // La proposition : fermer les autres sessions, une requête, la courante reste.
    const others = useCloseOtherSessions();
    expect(await others.close()).toBe(true);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/me/sessions' });
    expect(others.closed.value).toBe(true);
  });

  test('saisies différentes : aucune requête ; refus du serveur (mot de passe faux, faible, compte SSO seul, trop d’essais) : code stable', async () => {
    const routes: Record<string, () => Response> = { 'POST /api/me/password': () => err(403, 'reauth_failed') };
    const calls = installFakeServer(routes);
    const password = usePasswordChange();
    expect(await password.change('pw', 'zz_new_password_long', 'zz_new_password_lonG')).toBe(false);
    expect(password.failure.value).toBe('account.password.mismatch');
    expect(calls).toHaveLength(0);
    for (const [status, code] of [[403, 'reauth_failed'], [400, 'weak_password'], [409, 'no_local_password'], [429, 'too_many_attempts'], [400, 'current_password_required']] as const) {
      routes['POST /api/me/password'] = () => err(status, code);
      expect(await password.change('pw', 'zz_new_password_long', 'zz_new_password_long')).toBe(false);
      expect(password.failure.value).toBe(`errors.${code}`);
      expect(password.done.value).toBe(false);
    }
  });

  test('2FA activée, codes régénérés ou 2FA retirée : la fermeture des autres sessions est proposée (ASVS 7.4.3), pas au simple début d’enrôlement', async () => {
    installFakeServer({
      'POST /api/me/2fa/enroll': () => json(200, { otpauth_uri: 'otpauth://x', secret: 'ABC' }),
      'POST /api/me/2fa/confirm': () => json(200, { backup_codes: ['a-1'] }),
      'POST /api/me/2fa/backup-codes': () => json(200, { backup_codes: ['b-2'] }),
      'DELETE /api/me/2fa': () => json(204, null),
      ...full,
    });
    const twoFactor = useTwoFactor();
    await twoFactor.start('pw');
    expect(twoFactor.offerCloseOthers.value).toBe(false);
    await twoFactor.confirm('123456');
    expect(twoFactor.offerCloseOthers.value).toBe(true);
    twoFactor.dismissCloseOthers();
    expect(twoFactor.offerCloseOthers.value).toBe(false);
    await twoFactor.regenerate('pw', '111111');
    expect(twoFactor.offerCloseOthers.value).toBe(true);
    twoFactor.dismissCloseOthers();
    await twoFactor.disable('pw', '222222');
    expect(twoFactor.offerCloseOthers.value).toBe(true);
  });
});

describe('audit', () => {
  test('dayBound : début et fin du jour en UTC ; une saisie invalide est ignorée', () => {
    expect(dayBound('2026-10-01', 'start')).toBe('2026-10-01T00:00:00.000Z');
    expect(dayBound('2026-10-01', 'end')).toBe('2026-10-01T23:59:59.999Z');
    expect(dayBound('', 'start')).toBeUndefined();
    expect(dayBound('01/10/2026', 'end')).toBeUndefined();
  });

  test('filtres envoyés au serveur (action, compte, résultat, période) ; « charger la suite » suit le curseur ; réinitialiser repart de zéro', async () => {
    const calls = installFakeServer({
      'GET /api/audit': (call) => json(200, { events: [], next_cursor: new URLSearchParams(call.search).get('cursor') ? null : 'suite' }),
    });
    const audit = useAudit();
    audit.filters.action = ' user.deactivated ';
    audit.filters.actor = '3f2b6c1e-0000-4000-8000-0000000000a1';
    audit.filters.outcome = 'denied';
    audit.filters.since = '2026-10-01';
    audit.filters.until = '2026-10-02';
    await audit.events.refetch();
    const query = new URLSearchParams(calls.at(-1)?.search);
    expect(Object.fromEntries(query)).toEqual({
      limit: '50',
      action: 'user.deactivated',
      actor: '3f2b6c1e-0000-4000-8000-0000000000a1',
      outcome: 'denied',
      since: '2026-10-01T00:00:00.000Z',
      until: '2026-10-02T23:59:59.999Z',
    });
    expect(audit.events.hasMore()).toBe(true);
    await audit.events.loadMore();
    expect(new URLSearchParams(calls.at(-1)?.search).get('cursor')).toBe('suite');
    audit.reset();
    expect(audit.filters).toMatchObject({ action: '', actor: '', outcome: '', since: '', until: '' });
  });

  test('export : refus du serveur (403) → message, aucun téléchargement', async () => {
    installFakeServer({ 'GET /api/audit/export': () => err(403, 'forbidden') });
    const audit = useAudit();
    expect(await audit.exportNdjson()).toBe(false);
    expect(audit.exportFailure.value).toBe('audit.exportFailed');
    expect(audit.exporting.value).toBe(false);
  });
});

describe('réglages d’instance (owner)', () => {
  test('parseDomains : un par ligne ou séparés, casse et doublons ignorés', () => {
    expect(parseDomains('A.test\n b.test, a.test;;  C.test ')).toEqual(['a.test', 'b.test', 'c.test']);
    expect(parseDomains('')).toEqual([]);
  });

  test('sécurité : valeurs lues, enregistrées en nombres, domaines en liste', async () => {
    let put: unknown;
    installFakeServer({
      'GET /api/settings/security': () => json(200, { session_idle_minutes: 720, session_absolute_hours: 168, allowed_email_domains: ['a.test'], api_key_max_lifetime_days: 365, audit_retention_months: 12 }),
      'PUT /api/settings/security': (call) => {
        put = call.body;
        return json(200, call.body);
      },
    });
    const settings = useSecuritySettings();
    await settings.load();
    expect(settings.form).toMatchObject({ idle: 720, absolute: 168, domains: 'a.test', keyMax: 365, retention: 12 });
    settings.form.idle = '60' as unknown as number;
    settings.form.domains = 'x.test\ny.test';
    expect(await settings.save()).toBe(true);
    expect(put).toEqual({ session_idle_minutes: 60, session_absolute_hours: 168, allowed_email_domains: ['x.test', 'y.test'], api_key_max_lifetime_days: 365, audit_retention_months: 12 });
  });

  test('SSO : le secret du client est en écriture seule (jamais relu, champ vidé dès l’envoi, omis s’il n’est pas saisi) ; `owner` n’est jamais proposé', async () => {
    const bodies: Record<string, unknown>[] = [];
    installFakeServer({
      'GET /api/settings/sso': () => json(200, { enabled: true, slug: 'idp', label: 'IdP', issuer_url: 'https://idp.test', client_id: 'cid', client_secret_set: true, client_secret: 'zz_test_LEAK', sso_required: false, group_roles: [{ group: 'g', role: 'admin' }] }),
      'PUT /api/settings/sso': (call) => {
        bodies.push(call.body as Record<string, unknown>);
        return json(200, { enabled: true, slug: 'idp', label: 'IdP', issuer_url: 'https://idp.test', client_id: 'cid', client_secret_set: true, sso_required: false });
      },
    });
    const sso = useSsoSettings();
    await sso.load();
    expect(JSON.stringify(sso.form)).not.toContain('zz_test_LEAK');
    expect(sso.secretSet.value).toBe(true);
    expect(sso.form.clientSecret).toBe('');
    sso.form.clientSecret = 'zz_test_nouveau_secret';
    const saving = sso.save();
    expect(sso.form.clientSecret).toBe(''); // vidé dès l'envoi, avant la réponse
    await saving;
    expect(bodies[0]).toMatchObject({ client_secret: 'zz_test_nouveau_secret', slug: 'idp', issuer_url: 'https://idp.test', client_id: 'cid' });
    await sso.save();
    expect(bodies[1]).not.toHaveProperty('client_secret');
    expect(JSON.stringify(sso.form)).not.toContain('zz_test_nouveau_secret');
    // Groupes : seuls member et admin existent dans le type et dans la liste proposée.
    for (const body of bodies) for (const entry of (body.group_roles as { role: string }[]) ?? []) expect(['member', 'admin']).toContain(entry.role);
  });

  test('SSO : refus du serveur (réglage invalide) → code stable', async () => {
    installFakeServer({ 'GET /api/settings/sso': () => json(200, null), 'PUT /api/settings/sso': () => err(400, 'invalid_settings') });
    const sso = useSsoSettings();
    await sso.load();
    expect(sso.configured.value).toBe(false);
    expect(await sso.save()).toBe(false);
    expect(sso.failure.value).toBe('errors.invalid_settings');
  });
});

describe('identité du robot (tâche 3.8b)', () => {
  const view = (extra: Record<string, unknown> = {}) => ({ identify_instance: null, instance_contact: null, engine: null, user_agent: null, user_agent_identified: null, product_version: '1.0.0', ...extra });

  test('lecture : jamais posé → interrupteur éteint dans le formulaire, contact vide ; écriture de l’interrupteur seul, contact non renvoyé', async () => {
    const bodies: Record<string, unknown>[] = [];
    installFakeServer({
      'GET /api/settings/identity': () => json(200, view()),
      'PUT /api/settings/identity': (call) => {
        bodies.push(call.body as Record<string, unknown>);
        return json(200, view({ identify_instance: true }));
      },
    });
    const identity = useIdentitySettings();
    await identity.load();
    expect(identity.form).toEqual({ identify: false, contact: '' });
    identity.form.identify = true;
    expect(await identity.save()).toBe(true);
    expect(bodies).toEqual([{ identify_instance: true }]);
    expect(identity.saved.value).toBe(true);
    expect(identity.form.identify).toBe(true);
  });

  test('contact saisi : envoyé tel quel (le serveur le normalise) et relu normalisé ; vidé : null (réglage effacé)', async () => {
    const bodies: Record<string, unknown>[] = [];
    let stored: string | null = null;
    installFakeServer({
      'GET /api/settings/identity': () => json(200, view({ instance_contact: stored })),
      'PUT /api/settings/identity': (call) => {
        const body = call.body as { instance_contact?: string | null };
        bodies.push(body);
        if (body.instance_contact !== undefined) stored = body.instance_contact === null ? null : `mailto:${body.instance_contact}`;
        return json(200, view({ identify_instance: false, instance_contact: stored }));
      },
    });
    const identity = useIdentitySettings();
    await identity.load();
    identity.form.contact = '  ops@zz-test.example ';
    await identity.save();
    expect(bodies[0]).toEqual({ identify_instance: false, instance_contact: 'ops@zz-test.example' });
    expect(identity.form.contact).toBe('mailto:ops@zz-test.example');
    identity.form.contact = '';
    await identity.save();
    expect(bodies[1]).toEqual({ identify_instance: false, instance_contact: null });
    expect(identity.form.contact).toBe('');
  });

  test('contact refusé par le serveur → message propre, formulaire conservé ; 403 d’un non-admin → refus de droit', async () => {
    installFakeServer({ 'GET /api/settings/identity': () => json(200, view()), 'PUT /api/settings/identity': () => err(400, 'invalid_instance_contact') });
    const identity = useIdentitySettings();
    await identity.load();
    identity.form.contact = 'ops @zz-test.example';
    expect(await identity.save()).toBe(false);
    expect(identity.failure.value).toBe('errors.invalid_instance_contact');
    expect(identity.form.contact).toBe('ops @zz-test.example');
    installFakeServer({ 'GET /api/settings/identity': () => err(403, 'forbidden') });
    const denied = useIdentitySettings();
    await denied.load();
    expect(denied.loadFailure.value).toBe('errors.forbidden');
    expect(denied.forbidden.value).toBe(true);
  });

  test('premier démarrage : le contact est envoyé seulement s’il est saisi', async () => {
    const bodies: Record<string, unknown>[] = [];
    installFakeServer({
      'POST /api/setup': (call) => {
        bodies.push(call.body as Record<string, unknown>);
        return json(201, { userId: ME.id, keyFingerprint: 'ab12', reminder: 'x' });
      },
    });
    await postSetup({ token: 't', email: 'a@zz-test.example', password: 'pw', instanceContact: 'https://zz-test.example/contact' });
    await postSetup({ token: 't', email: 'a@zz-test.example', password: 'pw', instanceContact: '' });
    expect(bodies[0]).toMatchObject({ instanceContact: 'https://zz-test.example/contact' });
    expect(bodies[1]).not.toHaveProperty('instanceContact');
  });
});
