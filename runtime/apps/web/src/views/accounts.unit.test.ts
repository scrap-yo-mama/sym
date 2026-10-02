// SPDX-License-Identifier: AGPL-3.0-only
// Écrans des comptes (tâche 3.8, 13.2 et 06 § 4.3), rendus côté serveur avec un faux serveur REST : Utilisateurs, Audit, Compte, Clés,
// Sécurité, SSO. `assert_admin_metadata_only` : l'admin voit l'état, le coût et la durée des runs d'un autre, jamais leur contenu ;
// `assert_no_impersonation` : aucun contrôle ni aucune route pour se faire passer pour quelqu'un ; droits pilotés par can() ;
// `assert_secret_masked` : le secret du client OIDC n'est jamais rendu.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { resetSession } from '@/composables/useSession';
import en from '@/i18n/locales/en.json';
import fr from '@/i18n/locales/fr.json';
import { setApi } from '@/lib/api';
import { createAppRouter } from '@/router/index';
import { ROLE_PERMISSIONS } from '@/testing/permissions';
import { esc, installFakeServer, json, ME, signedIn, view } from '@/testing/console.testkit';
import CloseOthersOffer from '@/components/account/CloseOthersOffer.vue';
import PreferencesBar from '@/components/PreferencesBar.vue';
import ApiRunsTab from '@/components/api/tabs/ApiRunsTab.vue';
import { useApiRuns } from '@/composables/useApiRuns';
import { apiDetail } from '@/testing/console-fixtures';
import AuditView from './admin/AuditView.vue';
import UsersView from './admin/UsersView.vue';
import RunsView from './RunsView.vue';
import AccountView from './settings/AccountView.vue';
import ApiKeysView from './settings/ApiKeysView.vue';
import RobotIdentitySettingsView from './settings/RobotIdentitySettingsView.vue';
import SecuritySettingsView from './settings/SecuritySettingsView.vue';
import SettingsView from './settings/SettingsView.vue';
import SsoSettingsView from './settings/SsoSettingsView.vue';

beforeEach(() => resetSession());
afterEach(() => {
  setApi(undefined);
  resetSession();
});

type RoleName = keyof typeof ROLE_PERMISSIONS;
const ADMIN_A = '3f2b6c1e-0000-4000-8000-0000000000a1';
const MEMBER_B = '3f2b6c1e-0000-4000-8000-0000000000b2';

const me = (role: RoleName, extra: Record<string, unknown> = {}) => ({
  ...ME,
  id: role === 'admin' ? ADMIN_A : ME.id,
  role,
  email: `${role}@x.test`,
  permissions: ROLE_PERMISSIONS[role],
  ...extra,
});

/** Routes d'identité pour un rôle. */
const session = (role: RoleName, extra: Record<string, unknown> = {}) => ({
  'GET /api/auth/get-session': () => json(200, { session: { id: 's' }, user: { id: ME.id, email: 'x@x.test' } }),
  'GET /api/me': () => json(200, me(role, extra)),
});

const user = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  email: `${id.slice(-2)}@x.test`,
  display_name: `Nom ${id.slice(-2)}`,
  role: 'member',
  status: 'active',
  mfa_enabled: true,
  created_at: '2026-09-01T10:00:00Z',
  last_login_at: '2026-09-30T10:00:00Z',
  disabled_at: null,
  ...over,
});

const event = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  at: '2026-10-01T10:00:00Z',
  actor_user_id: ADMIN_A,
  actor_via: 'ui',
  actor_ref: null,
  action: 'user.deactivated',
  target_type: 'user',
  target_id: MEMBER_B,
  outcome: 'success',
  ip: '203.0.113.7',
  user_agent: 'zz',
  meta: { revoked: 2 },
  ...over,
});

/** Contenu qu'un serveur défaillant glisserait dans une réponse : la console ne doit ni l'afficher ni le relayer. */
const TRAP = { input: { secret_query: 'zz_test_CONTENU_ENTREE' }, output: { rows: 'zz_test_CONTENU_SORTIE' }, items_preview: [{ titre: 'zz_test_CONTENU_ITEM' }], cookies: 'zz_test_COOKIE_SESSION' };

const bRun = (id: string) => ({
  id,
  api_id: 'a',
  api_slug: 'annonces-de-b',
  owner_id: MEMBER_B,
  trigger: 'ui',
  state: 'succeeded',
  outcome: 'clean',
  degraded_reasons: [],
  failure_class: null,
  created_at: '2026-10-01T10:00:00Z',
  started_at: '2026-10-01T10:00:01Z',
  finished_at: '2026-10-01T10:00:03Z',
  duration_ms: 2000,
  cost: { llm_usd: 0.01, proxy_usd: 0, total_usd: 0.0123, estimated: false },
  items: 48,
  ...TRAP,
});

const IMPERSONATION = /impersonat|sign in as|log in as|login as|act as|switch (user|account)|sudo|take over|se connecter (en tant|comme)|agir en tant|se faire passer|prendre la place|usurp/i;
const CONTENT_WORDS = /zz_test_CONTENU|zz_test_COOKIE/;

describe('assert_admin_metadata_only : l’admin voit l’état, le coût et la durée, jamais le contenu', () => {
  test('« Tous les runs » : les runs d’un autre membre montrent état, coût, durée ; le contenu envoyé par erreur n’est pas rendu', async () => {
    installFakeServer({ ...session('admin'), 'GET /api/runs': () => json(200, { runs: [bRun('r1'), bRun('r2')], next_cursor: null }) });
    await signedIn();
    const html = await view(RunsView);
    expect((html.match(/data-testid="run-other"/g) ?? []).length).toBe(2);
    expect(html).toContain(esc(en.runs.other));
    expect(html).toContain('>Succeeded</span>'); // état
    expect(html).toContain('$0.0123'); // coût
    expect(html).toContain('2 s'); // durée
    expect(html).not.toMatch(CONTENT_WORDS);
    expect(html).not.toMatch(/\/items|\/datasets|download|export|télécharg/i);
    expect(html).not.toMatch(IMPERSONATION);
  });

  test('Fiche API, onglet Runs : le run de B montre état, coût, durée ; ni items, ni export, ni relance ; même appelées, relance et items ne lisent pas son contenu', async () => {
    const own = { ...bRun('r-own'), owner_id: ADMIN_A, dataset_id: 'd-own', strategy_version: 3 };
    const routes = {
      ...session('admin'),
      'GET /api/runs': () => json(200, { runs: [{ ...bRun('r-b'), dataset_id: 'd-b', strategy_version: 3 }, own], next_cursor: null }),
      // Serveur défaillant : il renverrait le contenu du run de B et les items de son dataset.
      'GET /api/runs/r-b': () => json(200, { ...bRun('r-b'), metadata_only: false, attempts: [], tokens: { input: 0, output: 0 } }),
      'GET /api/datasets/d-b/items': () => json(200, { items: [{ title: 'zz_test_CONTENU_ITEM' }], next_cursor: null }),
      'GET /api/runs/r-own': () => json(200, { ...own, input: { max_pages: 2 }, metadata_only: false, attempts: [], tokens: { input: 0, output: 0 } }),
      'GET /api/datasets/d-own/items': () => json(200, { items: [{ title: 'Mon livre', price: 3 }], next_cursor: null }),
    };
    const calls = installFakeServer(routes);
    await signedIn();
    const html = await view(ApiRunsTab, { detail: apiDetail({ slug: 'annonces-de-b', metadata_only: false }), slug: 'annonces-de-b' });
    expect((html.match(/data-testid="runs-tab-row"/g) ?? []).length).toBe(2);
    expect((html.match(/data-testid="run-other"/g) ?? []).length).toBe(1);
    expect(html).toContain(esc(en.runs.other));
    expect(html).toContain('0.0123 $'); // coût
    expect(html).toContain('2 s'); // durée
    expect(html).not.toMatch(CONTENT_WORDS);
    // Une seule série d'actions de contenu : celles du run de l'admin lui-même.
    expect((html.match(new RegExp(esc(en.runsTab.viewItems), 'g')) ?? []).length).toBe(1);
    expect((html.match(new RegExp(esc(en.actions.relaunch), 'g')) ?? []).length).toBe(1);
    expect(html).not.toContain('/api/datasets/d-b/');
    expect(html).not.toMatch(IMPERSONATION);

    // Les actions elles-mêmes : pour le run de B, aucune lecture de son entrée ni de ses items, rien en mémoire.
    const runs = useApiRuns('annonces-de-b', { immediate: false });
    await runs.refetch();
    const [ofB, mine] = runs.runs.value;
    const before = calls.length;
    expect(await runs.relaunchInput(ofB!)).toBeNull();
    expect(await runs.showItems(ofB!)).toBe(false);
    expect(calls.slice(before).map((c) => c.path)).toEqual([]);
    expect(JSON.stringify(runs.items.value)).not.toMatch(CONTENT_WORDS);
    // Son propre run : la relance relit l'entrée, les items s'affichent.
    expect(await runs.relaunchInput(mine!)).toEqual({ max_pages: 2 });
    expect(await runs.showItems(mine!)).toBe(true);
    expect(runs.items.value).toEqual([{ title: 'Mon livre', price: 3 }]);
  });

  test('Audit : l’admin lit des métadonnées (action, résultat, cible) ; aucun contrôle de contenu ni d’impersonation', async () => {
    installFakeServer({
      ...session('admin'),
      'GET /api/audit': () => json(200, { events: [event('2'), event('1', { action: 'access.denied', outcome: 'denied', target_type: null, target_id: null, meta: { route: 'GET /api/runs/{id}', reason: 'role' } })], next_cursor: null }),
      'GET /api/users': () => json(200, { users: [user(ADMIN_A, { role: 'admin' }), user(MEMBER_B)], next_cursor: null }),
    });
    await signedIn();
    const html = await view(AuditView);
    expect((html.match(/data-testid="audit-row"/g) ?? []).length).toBe(2);
    expect(html).toContain(esc(en.audit.action.user_deactivated));
    expect(html).toContain(esc(en.audit.action.access_denied));
    expect(html).toContain(esc(en.audit.outcomes.denied));
    // Un admin n'exporte pas (owner seulement) et ne trouve aucun accès au contenu.
    expect(html).not.toContain('data-testid="audit-export"');
    expect(html).not.toMatch(CONTENT_WORDS);
    expect(html).not.toMatch(IMPERSONATION);
  });

  test('Utilisateurs : des comptes et des actions de gestion ; aucun contenu, aucune impersonation, aucun lien vers les données d’un compte', async () => {
    installFakeServer({
      ...session('owner'),
      'GET /api/users': () => json(200, { users: [user(ME.id, { role: 'owner' }), user(ADMIN_A, { role: 'admin' }), user(MEMBER_B, { ...TRAP })], next_cursor: null }),
      'GET /api/invitations': () => json(200, { invitations: [] }),
    });
    await signedIn();
    const html = await view(UsersView);
    expect(html).not.toMatch(CONTENT_WORDS);
    expect(html).not.toMatch(IMPERSONATION);
    // Chaque action est dans le catalogue fermé de gestion de compte (aucune « ouvrir les runs / datasets / cookies de… »).
    const actions = [...html.matchAll(/data-testid="action-(\w+)"/g)].map((match) => match[1]);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(['makeAdmin', 'makeMember', 'disable', 'enable', 'delete', 'revokeAccess', 'resetTwoFactor', 'resetLink']).toContain(action);
    expect(html).not.toMatch(/href="\/(runs|apis|datasets)/);
  });
});

describe('assert_no_impersonation : aucune fonction « se faire passer pour » dans la console (INV5)', () => {
  const webSrc = new URL('../', import.meta.url).pathname;
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'testing' || entry.name === 'node_modules' ? [] : sources(full);
      return /\.(vue|ts)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
    });
  }
  const strip = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

  test('les textes affichés (en, fr) n’offrent aucune impersonation', () => {
    for (const [name, messages] of [['en', en], ['fr', fr]] as const) expect(JSON.stringify(messages), name).not.toMatch(IMPERSONATION);
  });

  test('aucune route d’API appelée par la console n’ouvre une session au nom d’autrui, et le gabarit d’aucun écran n’en propose', () => {
    const routes = new Set<string>();
    for (const file of sources(webSrc)) {
      const code = strip(readFileSync(file, 'utf8'));
      for (const match of code.matchAll(/['"`](\/api\/[^'"`\s]*)['"`]/g)) routes.add(match[1] ?? '');
      const template = file.endsWith('.vue') ? code.slice(code.indexOf('<template>')) : '';
      expect(template, file).not.toMatch(IMPERSONATION);
    }
    expect(routes.size).toBeGreaterThan(20);
    for (const route of routes) expect(route, route).not.toMatch(/impersonat|admin\/(session|login)|as-user|act-as|switch-user|take-over/i);
  });

  test('le client généré (OpenAPI) n’expose aucun chemin d’impersonation', () => {
    const generated = readFileSync(new URL('../../../../packages/client/src/generated/schema.ts', import.meta.url), 'utf8');
    expect(generated).not.toMatch(/impersonat|\/api\/admin\/(session|login)|act-as|switch-user/i);
  });
});

describe('pilotage par can() : les écrans réservés disparaissent et leurs routes redirigent', () => {
  const RESERVED = ['/admin/users', '/admin/audit', '/settings/security', '/settings/robot', '/settings/sso'];

  async function landing(role: RoleName, path: string): Promise<string> {
    installFakeServer(session(role));
    resetSession();
    const router = createAppRouter(createMemoryHistory());
    await router.push(path);
    return String(router.currentRoute.value.name);
  }

  test('un membre : Utilisateurs, Audit, Sécurité et SSO redirigent vers l’accueil', async () => {
    for (const path of RESERVED) expect(await landing('member', path), path).toBe('home');
  });

  test('un admin : Utilisateurs, Audit et Identité du robot s’ouvrent ; Sécurité et SSO (owner) redirigent', async () => {
    expect(await landing('admin', '/admin/users')).toBe('admin-users');
    expect(await landing('admin', '/admin/audit')).toBe('admin-audit');
    expect(await landing('admin', '/settings/robot')).toBe('settings-robot');
    expect(await landing('admin', '/settings/security')).toBe('home');
    expect(await landing('admin', '/settings/sso')).toBe('home');
  });

  test('l’owner : tout s’ouvre', async () => {
    expect(await landing('owner', '/admin/users')).toBe('admin-users');
    expect(await landing('owner', '/admin/audit')).toBe('admin-audit');
    expect(await landing('owner', '/settings/security')).toBe('settings-security');
    expect(await landing('owner', '/settings/robot')).toBe('settings-robot');
    expect(await landing('owner', '/settings/sso')).toBe('settings-sso');
  });

  test('le menu des réglages : Sécurité et SSO seulement pour l’owner, Identité du robot pour l’admin et l’owner ; clés et compte pour tous', async () => {
    const sections = async (role: RoleName) => {
      installFakeServer(session(role));
      await signedIn();
      const html = await view(SettingsView);
      return ['keys', 'account', 'security', 'robot', 'sso'].filter((id) => html.includes(`href="/settings/${id}"`));
    };
    expect(await sections('member')).toEqual(['keys', 'account']);
    expect(await sections('admin')).toEqual(['keys', 'account', 'robot']);
    expect(await sections('owner')).toEqual(['keys', 'account', 'security', 'robot', 'sso']);
  });

  test('l’invitation d’un admin n’est proposée qu’à qui peut changer un rôle (owner)', async () => {
    const roleOptions = async (role: RoleName) => {
      installFakeServer({ ...session(role), 'GET /api/users': () => json(200, { users: [], next_cursor: null }), 'GET /api/invitations': () => json(200, { invitations: [] }) });
      await signedIn();
      const html = await view(UsersView);
      return [...html.slice(html.indexOf('id="invite-role"')).matchAll(/<option value="(\w+)"/g)].map((match) => match[1]).slice(0, 2);
    };
    expect(await roleOptions('admin')).toEqual(['member']);
    expect(await roleOptions('owner')).toEqual(['member', 'admin']);
  });

  test('le transfert de propriété n’est proposé qu’à l’owner', async () => {
    const hasTransfer = async (role: RoleName) => {
      installFakeServer({ ...session(role), 'GET /api/users': () => json(200, { users: [], next_cursor: null }), 'GET /api/invitations': () => json(200, { invitations: [] }) });
      await signedIn();
      return (await view(UsersView)).includes('data-testid="transfer-form"');
    };
    expect(await hasTransfer('admin')).toBe(false);
    expect(await hasTransfer('owner')).toBe(true);
  });
});

describe('Mon compte', () => {
  const routes = (extra: Record<string, unknown> = {}) => ({
    ...session('member', extra),
    'GET /api/me/sessions': () => json(200, { sessions: [{ id: 's1', created_at: '2026-10-01T08:00:00Z', last_seen_at: '2026-10-01T09:00:00Z', expires_at: '2026-10-08T08:00:00Z', ip: '203.0.113.7', user_agent: 'Firefox zz', current: true }, { id: 's2', created_at: '2026-09-28T08:00:00Z', last_seen_at: null, expires_at: '2026-10-05T08:00:00Z', ip: null, user_agent: null, current: false }] }),
    'GET /api/me/identities': () => json(200, { identities: [] }),
    'GET /api/me/audit': () => json(200, { events: [event('9', { action: 'auth.login' })], next_cursor: null }),
  });

  test('2FA désactivée : formulaire d’activation (mot de passe), pas de retrait ; 2FA active : régénération et retrait', async () => {
    installFakeServer(routes());
    await signedIn();
    const off = await view(AccountView);
    expect(off).toContain(esc(en.account.twoFactor.off));
    expect(off).toContain('data-testid="two-factor-start"');
    expect(off).not.toContain('data-testid="two-factor-disable"');
    resetSession();
    installFakeServer(routes({ mfaEnabled: true }));
    await signedIn();
    const on = await view(AccountView);
    expect(on).toContain(esc(en.account.twoFactor.on));
    expect(on).toContain('data-testid="two-factor-regenerate"');
    expect(on).toContain('data-testid="two-factor-disable"');
    expect(on).not.toContain('data-testid="two-factor-start"');
  });

  test('assert_password_change_reauth : mot de passe (06 § 2), formulaire avec mot de passe actuel, nouveau et répétition ; aucune valeur pré-remplie', async () => {
    installFakeServer(routes());
    await signedIn();
    const html = await view(AccountView);
    expect(html).toContain('data-testid="password-panel"');
    expect(html).toContain(esc(en.account.password.title));
    for (const [name, autocomplete] of [['currentPassword', 'current-password'], ['newPassword', 'new-password'], ['repeatPassword', 'new-password']]) {
      expect(html).toMatch(new RegExp(`<input[^>]*name="${name}"[^>]*>`));
      expect(html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0]).toContain(`autocomplete="${autocomplete}"`);
      expect(html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0]).toContain('type="password"');
    }
    expect(fr.account.password.title).toBeTruthy();
  });

  test('MFA_ENFORCED concerne le rôle : pas de formulaire de retrait de la 2FA, une explication à la place ; sinon le retrait reste offert', async () => {
    installFakeServer(routes({ mfaEnabled: true, mfaRequired: true }));
    await signedIn();
    const enforced = await view(AccountView);
    expect(enforced).toContain('data-testid="two-factor-regenerate"');
    expect(enforced).not.toContain('data-testid="two-factor-disable"');
    expect(enforced).toContain(esc(en.account.twoFactor.removalBlocked));
    resetSession();
    installFakeServer(routes({ mfaEnabled: true, mfaRequired: false }));
    await signedIn();
    const free = await view(AccountView);
    expect(free).toContain('data-testid="two-factor-disable"');
    expect(free).not.toContain(esc(en.account.twoFactor.removalBlocked));
  });

  test('proposition de fermer les autres sessions (après mot de passe ou 2FA) : un bouton et un « plus tard », en en et en fr', async () => {
    installFakeServer(routes());
    await signedIn();
    for (const locale of ['en', 'fr'] as const) {
      const html = await view(CloseOthersOffer, { count: 2 }, { locale });
      const messages = locale === 'en' ? en : fr;
      expect(html).toContain('data-testid="close-others-offer"');
      expect(html).toContain(esc(messages.account.closeOthers.close));
      expect(html).toContain(esc(messages.account.closeOthers.later));
    }
  });

  test('sessions : la courante est marquée et ne se ferme pas ; une autre se ferme ; activité récente listée', async () => {
    installFakeServer(routes());
    await signedIn();
    const html = await view(AccountView);
    expect((html.match(/data-testid="session-row"/g) ?? []).length).toBe(2);
    expect(html).toContain(esc(en.account.sessions.current));
    expect(html).toContain('data-testid="sessions-close-others"');
    expect(html).toContain(esc(en.audit.action.auth_login));
    // Un seul bouton « Fermer » : celui de l'autre session.
    expect((html.match(new RegExp(`>${esc(en.account.sessions.close)}</button>`, 'g')) ?? []).length).toBe(1);
  });

  test('réglage Animations dans Mon compte (20 § 4.3) : Système ou Réduites, avec son libellé ; la barre du haut ne garde que la langue et le thème', async () => {
    installFakeServer(routes());
    await signedIn();
    const html = await view(AccountView);
    const select = html.match(/<select[^>]*id="pref-motion"[^>]*>[\s\S]*?<\/select>/)?.[0] ?? '';
    expect(select).not.toBe('');
    expect(select).toContain('value="system"');
    expect(select).toContain('value="reduced"');
    expect(select).toContain(esc(en.account.preferences.motions.reduced));
    expect(html).toMatch(new RegExp(`<label[^>]*for="pref-motion"[^>]*>${esc(en.account.preferences.motion)}</label>`));
    const bar = await view(PreferencesBar);
    expect(bar).not.toContain('pref-motion');
    expect(bar).toContain('id="pref-language"');
    expect(bar).toContain('id="pref-theme"');
  });

  test('aucun secret ni code de secours dans le rendu initial', async () => {
    installFakeServer(routes({ mfaEnabled: true }));
    await signedIn();
    const html = await view(AccountView);
    expect(html).not.toContain('data-testid="secret-reveal"');
    expect(html).not.toContain('data-testid="two-factor-seed"');
  });
});

describe('assert_secret_masked : secrets des comptes', () => {
  const KEY = 'sy_live_zz_test_LEAK_SECRET_DE_CLE';

  test('Clés d’API : la liste ne montre que préfixe, portées et dates ; un secret envoyé par erreur n’est pas rendu', async () => {
    installFakeServer({
      ...session('member'),
      'GET /api/api-keys': () => json(200, { items: [{ id: 'k1', label: 'Outil', prefix: 'sy_live_ab12', scopes: ['apis:read'], expiresAt: '2099-01-01T00:00:00Z', lastUsedAt: null, createdAt: '2026-09-01T00:00:00Z', revokedAt: null, key: KEY }] }),
    });
    await signedIn();
    const html = await view(ApiKeysView);
    expect(html).toContain('sy_live_ab12');
    expect(html).not.toContain(KEY);
    expect(html).not.toContain('zz_test_LEAK');
    // Mot de passe : champ en écriture seule, sans valeur.
    for (const input of [...html.matchAll(/<input[^>]*type="password"[^>]*>/g)].map((match) => match[0])) expect(input).not.toMatch(/\svalue="[^"]+"/);
  });

  test('SSO : le secret du client n’est jamais rendu, le champ est vide, seul « secret enregistré » apparaît', async () => {
    installFakeServer({
      ...session('owner'),
      'GET /api/settings/sso': () => json(200, { enabled: true, slug: 'idp', label: 'IdP', issuer_url: 'https://idp.test', client_id: 'cid', client_secret_set: true, client_secret: 'zz_test_LEAK_CLIENT_SECRET', sso_required: false }),
    });
    await signedIn();
    const html = await view(SsoSettingsView);
    expect(html).not.toContain('zz_test_LEAK');
    const field = /<input[^>]*id="sso-client-secret"[^>]*>/.exec(html)?.[0] ?? '';
    expect(field).toContain('type="password"');
    expect(field).toContain('autocomplete="new-password"');
    expect(field).not.toMatch(/\svalue="[^"]+"/);
    expect(html).toContain(esc(en.settings.secret.set));
  });

  test('Sécurité de l’instance : valeurs lues, formulaire rendu', async () => {
    installFakeServer({
      ...session('owner'),
      'GET /api/settings/security': () => json(200, { session_idle_minutes: 720, session_absolute_hours: 168, allowed_email_domains: ['a.test', 'b.test'], api_key_max_lifetime_days: 365, audit_retention_months: 12 }),
    });
    await signedIn();
    const html = await view(SecuritySettingsView);
    expect(html).toContain('data-testid="security-form"');
    expect(html).toContain('value="720"');
    expect(html).toContain('a.test');
  });

  test('Identité du robot (admin) : User-Agent du moteur en lecture seule, interrupteur et contact modifiables', async () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
    installFakeServer({
      ...session('admin'),
      'GET /api/settings/identity': () => json(200, { identify_instance: false, identify_effective: false, identify_source: 'setting', instance_contact: 'mailto:ops@zz-test.example', instance_contact_effective: 'mailto:ops@zz-test.example', instance_contact_source: 'setting', engine: { version: '153.0.8010.12', platform: 'linux' }, worker_version: '1.0.0', user_agent: ua, user_agent_identified: `${ua} (compatible; Scrapyomama/1.0.0; +mailto:ops@zz-test.example)`, product_version: '1.0.0' }),
    });
    await signedIn();
    const html = await view(RobotIdentitySettingsView);
    expect(html).toContain('data-testid="identity-form"');
    expect(html).toContain(esc(en.instance.identity.title));
    // User-Agent : champ en lecture seule, valeur exacte du moteur, aucune saisie possible.
    expect(html).toMatch(/<input(?=[^>]*\sreadonly)(?=[^>]*data-testid="identity-ua")[^>]*>/);
    expect(html).toContain(esc(ua));
    expect(html).not.toMatch(/HeadlessChrome/);
    expect(html).toContain('data-testid="identity-ua-identified"');
    // Interrupteur désactivé par défaut (réglage posé à false), contact rendu.
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*data-testid="identity-identify"/);
    expect(html).not.toMatch(/data-testid="identity-identify"[^>]*checked/);
    expect(html).toContain('mailto:ops@zz-test.example');
  });

  test('Identité du robot : moteur pas encore publié, rien d’inventé', async () => {
    installFakeServer({
      ...session('owner'),
      'GET /api/settings/identity': () => json(200, { identify_instance: null, identify_effective: null, identify_source: null, instance_contact: null, instance_contact_effective: null, instance_contact_source: null, engine: null, worker_version: null, user_agent: null, user_agent_identified: null, product_version: '1.0.0' }),
    });
    await signedIn();
    const html = await view(RobotIdentitySettingsView);
    expect(html).toContain('data-testid="identity-ua-unknown"');
    expect(html).not.toContain('data-testid="identity-ua"');
    expect(html).toContain(esc(en.instance.identity.identifyUnset));
    expect(html).toContain(esc(en.instance.identity.contactUnset));
  });

  test('Identité du robot : réglages jamais posés, environnement du worker appliqué → case cochée et origine dite (rien ne s’éteint en douce)', async () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
    installFakeServer({
      ...session('admin'),
      'GET /api/settings/identity': () =>
        json(200, { identify_instance: null, identify_effective: true, identify_source: 'env', instance_contact: null, instance_contact_effective: 'https://zz-test.example/env', instance_contact_source: 'env', engine: { version: '153.0.8010.12', platform: 'linux' }, worker_version: '4.5.6', user_agent: ua, user_agent_identified: `${ua} (compatible; Scrapyomama/4.5.6; +https://zz-test.example/env)`, product_version: '1.0.0' }),
    });
    await signedIn();
    const html = await view(RobotIdentitySettingsView);
    expect(html).toMatch(/data-testid="identity-identify"[^>]*checked|checked[^>]*data-testid="identity-identify"/);
    expect(html).toContain(esc(en.instance.identity.identifyFromEnvOn));
    expect(html).toContain(esc(en.instance.identity.contactFromEnv.replace('{contact}', 'https://zz-test.example/env')));
    expect(html).toContain('Scrapyomama/4.5.6');
  });
});
