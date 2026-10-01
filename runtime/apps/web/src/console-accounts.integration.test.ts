// SPDX-License-Identifier: AGPL-3.0-only
// Parcours des comptes de la console (tâche 3.8) contre un vrai serveur (Fastify, Better Auth, PostgreSQL migré) : les composables
// et la garde du routeur, sans navigateur (un `fetch` relaie les requêtes vers `app.inject` et tient le cookie de session comme un
// navigateur). Le même parcours en Chromium est tests/e2e/invitation.e2e.ts.
//   premier démarrage → 2FA forcée de l'owner → invitation (lien copiable) → acceptation → rôle membre sans écrans d'admin →
//   lien rejoué = même réponse qu'un lien inconnu → invitation d'un admin (2FA forcée) → audit sans secret → clé d'API vue une fois.
import { base32Decode, totpCode, totpStep } from '@runtime/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { acceptInvitation, postSetup } from '@/composables/useAccountFlows';
import { useTwoFactor } from '@/composables/useAccount';
import { useApiKeys } from '@/composables/useApiKeys';
import { useAudit } from '@/composables/useAudit';
import { can, resetSession, signIn, signOut, useSession, verifySecondFactor } from '@/composables/useSession';
import { useUsers } from '@/composables/useUsers';
import { buildApi, setApi } from '@/lib/api';
import { createAppRouter } from '@/router/index';
import { CookieJar, injectFetch } from '@/testing/inject-fetch';
import { withClient } from '../../../tests/helpers/pg.js';
import { nextTestIp, PUBLIC_URL, startTestServer, type TestServer } from '../../../tests/helpers/server.js';

/** Une « personne » devant la console : son pot de cookies, son adresse, et le client partagé de la page branché sur elle. */
function person(srv: TestServer) {
  const jar = new CookieJar();
  const ip = nextTestIp();
  return {
    jar,
    use(): void {
      resetSession();
      setApi(buildApi({ baseUrl: PUBLIC_URL, fetch: injectFetch(srv, jar, ip) }));
    },
  };
}

const PASSWORD = () => `zz_test_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}_long`;
const tokenOf = (link: string): string => link.slice(link.lastIndexOf('/') + 1);
const nextCode = (secret: string, offset: number): string => totpCode(base32Decode(secret), totpStep() + offset);

describe('assert_invitation_journey (console, serveur réel) : parcours des comptes de la console (3.8)', () => {
  let srv: TestServer;
  /**
   * Échafaudage : l'anti-rejeu n'accepte qu'un pas plus récent que le dernier et la fenêtre n'en offre que deux d'avance. On oublie le
   * dernier pas entre deux étapes du parcours (jamais entre un code et son rejeu : celui-là doit rester refusé).
   */
  const rewindTotp = (): Promise<unknown> => withClient(srv.db.url, (client) => client.query('UPDATE two_factor SET last_used_step = NULL'));
  const ownerPassword = PASSWORD();
  const memberPassword = PASSWORD();
  const adminPassword = PASSWORD();
  let ownerSecret = '';
  let memberLink = '';
  let owner: ReturnType<typeof person>;

  beforeAll(async () => {
    srv = await startTestServer('consoleaccts', { MFA_ENFORCED: 'admins' });
    owner = person(srv);
    owner.use();
  });
  afterAll(async () => {
    setApi(undefined);
    resetSession();
    await srv?.close();
  });

  test('premier démarrage : l’assistant crée l’owner et rend l’empreinte ; il répond 404 pour toujours ; un mauvais jeton est refusé', async () => {
    const router = createAppRouter(createMemoryHistory());
    await router.push('/login');
    expect(router.currentRoute.value.name, 'instance sans owner : l’assistant est la seule page').toBe('setup');

    expect(await postSetup({ token: 'zz_test_mauvais_jeton', email: 'zz_test_owner@example.test', password: ownerPassword })).toMatchObject({ ok: false, status: 403, code: 'forbidden' });
    expect(await postSetup({ token: srv.bootstrapToken, email: 'zz_test_owner@example.test', password: 'court' })).toMatchObject({ ok: false, status: 400, code: 'weak_password' });
    const created = await postSetup({ token: srv.bootstrapToken, email: 'zz_test_owner@example.test', password: ownerPassword, displayName: 'Owner' });
    expect(created).toMatchObject({ ok: true, status: 201 });
    expect(created.ok && created.data.keyFingerprint).toMatch(/\S+/);
    // Fermé pour toujours : même avec le bon jeton.
    expect(await postSetup({ token: srv.bootstrapToken, email: 'zz_test_autre@example.test', password: PASSWORD() })).toMatchObject({ ok: false, status: 404 });

    resetSession();
    const after = createAppRouter(createMemoryHistory());
    await after.push('/setup');
    expect(after.currentRoute.value.name, '/setup introuvable').toBe('not-found');
  });

  test('assert_mfa_enforced (console) : l’owner est mené à l’enrôlement avant toute autre page, l’active, puis administre', async () => {
    expect(await signIn('zz_test_owner@example.test', ownerPassword)).toEqual({ ok: true });
    expect(useSession().mustEnrollTwoFactor.value).toBe(true);
    const router = createAppRouter(createMemoryHistory());
    for (const path of ['/', '/admin/users', '/settings/account']) {
      await router.push(path);
      expect(router.currentRoute.value.name, path).toBe('two-factor-setup');
    }
    const twoFactor = useTwoFactor();
    expect(await twoFactor.start('mauvais mot de passe')).toBe(false);
    expect(twoFactor.failure.value).toBe('errors.reauth_failed');
    expect(await twoFactor.start(ownerPassword)).toBe(true);
    ownerSecret = twoFactor.enrollment.value?.secret ?? '';
    expect(ownerSecret).toMatch(/^[A-Z2-7]+$/);
    expect(await twoFactor.confirm('000000')).toBe(false);
    expect(twoFactor.failure.value).toBe('errors.invalid_code');
    expect(await twoFactor.confirm(nextCode(ownerSecret, 0))).toBe(true);
    expect(twoFactor.backupCodes.value).toHaveLength(10);
    twoFactor.acknowledgeBackup();
    expect(twoFactor.backupCodes.value).toEqual([]);
    expect(useSession().mustEnrollTwoFactor.value).toBe(false);
    expect(useSession().me.value).toMatchObject({ role: 'owner', mfaEnabled: true });
    await router.push('/admin/users');
    expect(router.currentRoute.value.name).toBe('admin-users');
  });

  test('invitation sans SMTP : lien copiable montré une fois, jamais relu, invitation en attente listée', async () => {
    const users = useUsers();
    expect(await users.invite('zz_test_membre@example.test', 'member')).toBe(true);
    const shown = users.oneTimeLink.value;
    expect(shown).toMatchObject({ kind: 'invitation', subject: 'zz_test_membre@example.test' });
    memberLink = shown?.link ?? '';
    expect(memberLink).toContain(`${PUBLIC_URL}/invite/`);
    users.dismissLink();
    expect(users.oneTimeLink.value).toBeNull();
    await users.invitations.refetch();
    const listed = users.invitations.data.value ?? [];
    expect(listed.map((invitation) => invitation.email)).toEqual(['zz_test_membre@example.test']);
    expect(JSON.stringify(listed)).not.toContain(tokenOf(memberLink));
    // Une adresse déjà invitée est refusée avec un code stable.
    expect(await users.invite('zz_test_membre@example.test', 'member')).toBe(false);
    expect(users.failure.value).toBe('errors.invitation_pending');
  });

  test('assert_invitation_single_use (console) : l’invité crée son compte ; lien rejoué, périmé ou inventé = même réponse', async () => {
    const stranger = person(srv);
    stranger.use();
    // Mot de passe trop faible : refusé sans consommer l'invitation.
    expect(await acceptInvitation({ token: tokenOf(memberLink), password: 'court' })).toMatchObject({ ok: false, code: 'weak_password' });
    const accepted = await acceptInvitation({ token: tokenOf(memberLink), password: memberPassword, displayName: 'Membre' });
    expect(accepted).toMatchObject({ ok: true });
    const session = useSession();
    expect(session.state.value).toBe('authenticated');
    expect(session.me.value).toMatchObject({ role: 'member', displayName: 'Membre', mfaEnabled: false, mfaEnrollmentRequired: false });
    // Un membre n'a pas les écrans d'admin : ses routes redirigent, can() le dit.
    expect(can('users:list')).toBe(false);
    expect(can('audit:read')).toBe(false);
    expect(can('settings:security:write')).toBe(false);
    const router = createAppRouter(createMemoryHistory());
    for (const path of ['/admin/users', '/admin/audit', '/settings/security', '/settings/sso']) {
      await router.push(path);
      expect(router.currentRoute.value.name, path).toBe('home');
    }
    // Le serveur refuse de toute façon (la console ne décide pas).
    const users = useUsers();
    await users.invitations.refetch();
    expect(users.invitations.error.value?.status).toBe(403);

    // Rejeu : lien consommé, lien inconnu et jeton mal formé reçoivent exactement la même réponse.
    const replays = await Promise.all([tokenOf(memberLink), 'zz_test_lien_inconnu_0123456789abcdef0123456789abcdef', 'x'].map((token) => acceptInvitation({ token, password: PASSWORD() })));
    expect(new Set(replays.map((result) => JSON.stringify(result))).size).toBe(1);
    expect(replays[0]).toMatchObject({ ok: false, status: 400, code: 'invitation_invalid', messageKey: 'errors.invitation_invalid' });
  });

  test('le membre se connecte ; sa clé d’API n’est vue qu’une fois, la liste n’a aucun secret, la révocation coupe la clé', async () => {
    const member = person(srv);
    member.use();
    expect(await signIn('zz_test_membre@example.test', memberPassword)).toEqual({ ok: true });
    const keys = useApiKeys();
    expect(await keys.create({ label: 'Outil MCP', scopes: ['apis:read'], expiresInDays: 30, currentPassword: 'faux' })).toBe(false);
    expect(keys.failure.value).toBe('errors.reauth_failed');
    expect(await keys.create({ label: 'Outil MCP', scopes: ['apis:read'], expiresInDays: 30, currentPassword: memberPassword })).toBe(true);
    const secret = keys.created.value?.key ?? '';
    expect(secret).toMatch(/^sy_live_/);
    expect(JSON.stringify(keys.keys.value)).not.toContain(secret);
    const usable = await srv.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${secret}` } });
    expect(usable.statusCode).toBe(200);
    keys.dismissCreated();
    expect(keys.created.value).toBeNull();
    await keys.reload();
    expect(JSON.stringify(keys.keys.value)).not.toContain(secret);
    expect(keys.keys.value).toHaveLength(1);
    const id = keys.keys.value[0]?.id ?? '';
    expect(await keys.revoke(id)).toBe(true);
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${secret}` } })).statusCode).toBe(401);
    await signOut();
  });

  test('invitation d’un admin : l’acceptation mène à l’enrôlement forcé ; le second facteur de la connexion suivante, code rejoué refusé', async () => {
    owner.use();
    expect(await signIn('zz_test_owner@example.test', ownerPassword)).toEqual({ ok: true });
    // L'owner a la 2FA : sa nouvelle session attend le code (pas le pas déjà consommé à l'enrôlement).
    expect(useSession().state.value).toBe('mfa_pending');
    const router = createAppRouter(createMemoryHistory());
    await router.push('/admin/users');
    expect(router.currentRoute.value.name, 'second facteur attendu : seule la connexion est joignable').toBe('login');
    expect(await verifySecondFactor('000000')).toEqual({ ok: false, failure: 'invalid_code' });
    const code = nextCode(ownerSecret, 1);
    expect(await verifySecondFactor(code)).toEqual({ ok: true });
    expect(useSession().state.value).toBe('authenticated');
    // Le même code, rejoué sur une autre session, est refusé (anti-rejeu).
    const replay = person(srv);
    replay.use();
    expect(await signIn('zz_test_owner@example.test', ownerPassword)).toEqual({ ok: true });
    expect(await verifySecondFactor(code)).toEqual({ ok: false, failure: 'invalid_code' });

    await rewindTotp();
    owner.use();
    await signIn('zz_test_owner@example.test', ownerPassword);
    expect(await verifySecondFactor(nextCode(ownerSecret, 0))).toEqual({ ok: true });
    const users = useUsers();
    expect(await users.invite('zz_test_admin@example.test', 'admin')).toBe(true);
    const adminLink = users.oneTimeLink.value?.link ?? '';
    const invitedAdmin = person(srv);
    invitedAdmin.use();
    expect(await acceptInvitation({ token: tokenOf(adminLink), password: adminPassword })).toMatchObject({ ok: true });
    expect(useSession().me.value).toMatchObject({ role: 'admin', mfaEnrollmentRequired: true, mfaEnabled: false });
    expect(useSession().mustEnrollTwoFactor.value).toBe(true);
    const adminRouter = createAppRouter(createMemoryHistory());
    await adminRouter.push('/');
    expect(adminRouter.currentRoute.value.name).toBe('two-factor-setup');
  });

  test('audit : l’owner lit les événements de ce parcours, sans lien, jeton, mot de passe ni code', async () => {
    await rewindTotp();
    owner.use();
    await signIn('zz_test_owner@example.test', ownerPassword);
    expect(await verifySecondFactor(nextCode(ownerSecret, 0))).toEqual({ ok: true });
    const audit = useAudit();
    audit.filters.action = '';
    await audit.events.refetch();
    const actions = audit.events.items.value.map((event) => event.action);
    for (const action of ['setup.owner_created', 'mfa.enabled', 'invitation.created', 'invitation.accepted', 'apikey.created', 'apikey.revoked', 'auth.login']) expect(actions, action).toContain(action);
    const dump = JSON.stringify(audit.events.items.value);
    for (const secret of [memberLink, tokenOf(memberLink), ownerPassword, memberPassword, adminPassword, ownerSecret]) expect(dump, secret.slice(0, 8)).not.toContain(secret);
    expect(dump).not.toMatch(/sy_live_[A-Za-z0-9]{20,}/);
    // Filtre par action et par résultat.
    audit.filters.action = 'invitation.accepted';
    audit.filters.outcome = 'denied';
    await audit.events.refetch();
    expect(audit.events.items.value.length).toBeGreaterThan(0);
    for (const event of audit.events.items.value) expect([event.action, event.outcome]).toEqual(['invitation.accepted', 'denied']);
  });
});
