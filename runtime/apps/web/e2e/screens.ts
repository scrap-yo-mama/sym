// SPDX-License-Identifier: AGPL-3.0-only
// Écrans et états de la console couverts par la gate d'accessibilité (06 § 4.3) : chacun est rendu en clair et en sombre, en
// `en` et en `fr`. Un écran ajouté par une tâche suivante (comptes, audit, personnes : 3.8) s'ajoute ici avec sa donnée.
import type { Page } from '@playwright/test';
import type { components } from '@runtime/client';
import { catalog, ME, runsOf, UUID } from './fixtures.ts';
import type { ApiRoutes, ConsoleApp } from './harness.ts';

type Locale = 'en' | 'fr';
type Theme = 'light' | 'dark';
/** Routes d'un écran ; une fonction reçoit la langue et le thème du test (l'identité servie porte ces préférences : `lang` de <html> doit rester celle du test). */
type ScreenRoutes = ApiRoutes | ((locale: Locale, theme: Theme) => ApiRoutes);

export type Screen = {
  /** Nom court, stable (titre du test). */
  id: string;
  path: string;
  /** Vrai : écran de l'utilisateur anonyme (connexion). */
  anonymous?: boolean;
  /** Routes d'API propres à l'écran, en plus de celles du catalogue de fixtures. */
  routes?: ScreenRoutes;
  /** Vrai : l'état montré provoque une réponse 4xx ou 5xx, ou une coupure du flux, voulue : Chromium la journalise comme erreur de console. */
  expectsNetworkError?: boolean;
  /** Mise en place après le chargement (ouvrir un panneau, remplir un champ, pousser des événements) ; l'écran est alors prêt à être jugé. */
  prepare?: (page: Page, app: ConsoleApp) => Promise<void>;
};

/** Onglets de la fiche d'une API (06 § 1, figure 1). */
const TABS = ['overview', 'schemas', 'strategy', 'runs', 'status', 'schedules', 'access', 'investigations'] as const;

const SETTINGS = ['models', 'proxies', 'extension', 'alerts', 'diagnostic', 'keys', 'account', 'security', 'robot', 'sso'] as const;

export const RUN_ID = UUID(201);
const NEW_RUN = UUID(950);
const NEW_API = UUID(951);

/** Création d'une API : le serveur répond 201 avec l'enquête lancée ; les événements suivants arrivent par le flux SSE. */
const creation: ApiRoutes = {
  'POST /api/apis': {
    status: 201,
    body: { api_id: NEW_API, slug: 'zz-nouvelle', investigation_phase: 'access_check', proposed_output_schema: null, sample: [], access_report: null, run_id: NEW_RUN },
  },
};

const attempt = (index: number, extra: Record<string, unknown> = {}) => ({
  run_id: NEW_RUN,
  api_id: NEW_API,
  api_slug: 'zz-nouvelle',
  attempt: { index, execution: index === 0 ? 'fetch' : 'agent', network: 'direct', state: 'done', est_cost_usd: 0.001, result: 'extraction', cost_usd: 0.001, ms: 240, ...extra },
});

/** Remplit le formulaire « Nouvelle API » et lance l'enquête (le champ de saisie est rempli par Playwright : ce n'est pas le parcours au clavier). */
async function startInvestigation(page: Page, app: ConsoleApp): Promise<void> {
  await page.locator('#api-description').fill('Titre et prix de chaque annonce');
  await page.locator('#api-url').fill('https://zz-test.example/annonces');
  await page.locator('form[data-testid="new-api-form"] button[type="submit"]').click();
  await page.getByTestId('investigation-board').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[role="log"]').length > 0);
  app.pushEvent('phase.started', { run_id: NEW_RUN, api_id: NEW_API, api_slug: 'zz-nouvelle', domain: 'zz-test.example', phase: 'testing', plan: [{ execution: 'fetch', network: 'direct', est_cost_usd: 0.001 }, { execution: 'agent', network: 'direct', est_cost_usd: 0.09 }], budget: { spent_usd: 0.002, max_usd: 0.5, elapsed_s: 12, timeout_s: 300, retained_est_usd: 0.002, full_agent_est_usd: 0.09 } }, '1');
  app.pushEvent('attempt.finished', attempt(0), '2');
  app.pushEvent('schema.proposed', { run_id: NEW_RUN, output_schema: { type: 'object', properties: { title: { type: 'string' }, price: { type: 'number' } } }, sample: [{ title: 'Vélo', price: 120 }] }, '3');
  app.pushEvent('attempt.finished', attempt(1, { state: 'pruned', pruned_reason: 'cheaper_succeeded', result: null, cost_usd: null, ms: null }), '4');
  await page.getByTestId('investigation-board').locator('[role="log"] li').nth(1).waitFor();
}

/** Run de la version 2 de la stratégie (rejoué par le replay de l'onglet Enquêtes : `run_id` de `version(2)`, voir fixtures.ts). */
const REPLAYED_RUN = UUID(102);

/** Événements d'enquête rejoués (`investigation_events`) : de quoi remplir le journal du replay avec chaque sorte de phrase. */
const replayFrames = [
  { event: 'investigation_started', data: { seq: 1, at: '2026-09-21T10:00:00.000Z', payload: {} } },
  { event: 'phase.started', data: { seq: 2, at: '2026-09-21T10:00:01.000Z', payload: { phase: 'access_check' } } },
  { event: 'access_report', data: { seq: 3, at: '2026-09-21T10:00:02.000Z', payload: { robots: 'allowed' } } },
  { event: 'phase.started', data: { seq: 4, at: '2026-09-21T10:00:03.000Z', payload: { phase: 'testing' } } },
  { event: 'attempt.finished', data: { seq: 5, at: '2026-09-21T10:00:05.000Z', payload: { n: 1, execution: 'fetch', network: 'direct', result: 'extraction' } } },
  { event: 'schema.proposed', data: { seq: 6, at: '2026-09-21T10:00:06.000Z', payload: {} } },
  { event: 'status.changed', data: { seq: 7, at: '2026-09-21T10:00:07.000Z', payload: { to: 'sain' } } },
];

/** Premier démarrage : l'instance n'a pas d'owner (503 `not_initialized`) jusqu'à la création, puis la session de l'owner s'ouvre. */
const setupRoutes = (): ScreenRoutes => (locale, theme) => {
  let created = false;
  return {
    'GET /api/auth/get-session': () => (created ? { body: { session: { id: 's' }, user: { id: UUID(900), email: 'ada@zz-test.example' } } } : { status: 503, body: { error: { code: 'not_initialized', message: 'zz' } } }),
    'GET /api/me': () => ({ body: ME(locale, theme) }),
    'POST /api/setup': () => {
      created = true;
      return { status: 201, body: { userId: UUID(900), keyFingerprint: 'zz-test-3f9a-1c7e-b24d', reminder: 'zz' } };
    },
    'POST /api/auth/sign-in/email': () => ({ body: { redirect: false, user: { id: UUID(900), email: 'ada@zz-test.example' } } }),
  };
};

/** Connexion d'un compte à 2FA : mot de passe vérifié, `/api/me` répond 403 `mfa_required` jusqu'au code. */
const secondFactorRoutes = (): ScreenRoutes => (locale, theme) => {
  let phase: 'anonymous' | 'pending' | 'full' = 'anonymous';
  return {
    'GET /api/auth/get-session': () => ({ body: phase === 'anonymous' ? null : { session: { id: 's' }, user: { id: UUID(900), email: 'ada@zz-test.example' } } }),
    'GET /api/me': () => (phase === 'full' ? { body: ME(locale, theme) } : { status: 403, body: { error: { code: 'mfa_required', message: 'zz' } } }),
    'POST /api/auth/sign-in/email': () => {
      phase = 'pending';
      return { body: { redirect: false, twoFactorRequired: true, user: { id: UUID(900), email: 'ada@zz-test.example' } } };
    },
    'POST /api/auth/two-factor/verify': (request) => {
      if ((request.body as { code?: string } | null)?.code === '000000') return { status: 400, body: { error: { code: 'invalid_code', message: 'zz' } } };
      phase = 'full';
      return { body: { ok: true, method: 'totp' } };
    },
  };
};

const ENROLL: ApiRoutes = {
  'POST /api/me/2fa/enroll': { body: { otpauth_uri: 'otpauth://totp/zz-test:ada?secret=JBSWY3DPEHPK3PXP&issuer=zz-test', secret: 'JBSWY3DPEHPK3PXP' } },
};

/** Compte admin tenu de s'enrôler à la 2FA (MFA_ENFORCED) : `GET /api/me` le dit, l'enrôlement seul est joignable. */
const enrollmentRequired: ScreenRoutes = (locale, theme) => ({ ...asRoleFixed(locale, theme), ...ENROLL });
const asRoleFixed = (locale: Locale, theme: Theme): ApiRoutes => ({ 'GET /api/me': { body: { ...ME(locale, theme, 'admin'), mfaEnrollmentRequired: true } } });

/** Remplit un champ du formulaire de connexion à 2FA, de la saisie du mot de passe au champ du code. */
async function reachSecondFactor(page: Page): Promise<void> {
  await page.locator('#login-email').fill('ada@zz-test.example');
  await page.locator('#login-password').fill('zz_test_motdepasse_long');
  await page.locator('form button[type="submit"]').click();
  await page.locator('#login-code').waitFor();
}

/** Compte d'un autre rôle que l'owner pour l'écran jugé. */
const asRole = (role: 'admin' | 'member', extra: Partial<components['schemas']['Me']> = {}): ScreenRoutes => (locale, theme) => ({ 'GET /api/me': { body: { ...ME(locale, theme, role), ...extra } } });

export const SCREENS: Screen[] = [
  { id: 'login', path: '/login', anonymous: true },
  {
    id: 'login-error',
    path: '/login',
    anonymous: true,
    expectsNetworkError: true,
    prepare: async (page) => {
      await page.locator('#login-email').fill('ada@zz-test.example');
      await page.locator('#login-password').fill('zz_test_mauvais');
      await page.locator('form button[type="submit"]').click();
      await page.getByTestId('login-error').waitFor();
    },
  },
  { id: 'home', path: '/' },
  { id: 'catalog', path: '/apis' },
  { id: 'catalog-empty', path: '/apis', routes: { 'GET /api/apis': { body: { apis: [], next_cursor: null } } } },
  {
    id: 'catalog-no-match',
    path: '/apis',
    routes: { 'GET /api/apis': (request) => ({ body: { apis: request.query.get('q') ? [] : catalog(), next_cursor: null } }) },
    prepare: async (page) => {
      await page.locator('#catalog-search').fill('zz-introuvable');
      await page.getByTestId('empty-state').waitFor();
    },
  },
  { id: 'catalog-error', path: '/apis', expectsNetworkError: true, routes: { 'GET /api/apis': { status: 500, body: { error: { code: 'internal', message: 'zz' } } } } },
  {
    id: 'catalog-stream-down',
    path: '/apis',
    expectsNetworkError: true,
    prepare: async (page, app) => {
      app.dropStreams();
      await page.getByTestId('connection-banner').locator('p').waitFor();
    },
  },
  { id: 'new-api', path: '/apis/new' },
  { id: 'new-api-account-site', path: '/apis/new', prepare: async (page) => void (await page.getByTestId('account-declare').check()) },
  { id: 'new-api-investigating', path: '/apis/new', routes: creation, prepare: startInvestigation },
  { id: 'new-api-reopened', path: `/apis/new/${NEW_RUN}` },
  { id: 'runs', path: '/runs' },
  { id: 'not-found', path: '/zz-introuvable' },
  // Comptes (3.8) : premier démarrage, invitation, mot de passe oublié, second facteur, enrôlement forcé.
  { id: 'setup', path: '/setup', anonymous: true, expectsNetworkError: true, routes: setupRoutes() },
  {
    id: 'setup-fingerprint',
    path: '/setup',
    anonymous: true,
    expectsNetworkError: true,
    routes: setupRoutes(),
    prepare: async (page) => {
      await page.locator('#setup-token').fill('zz_test_jeton_de_demarrage');
      await page.locator('#setup-email').fill('ada@zz-test.example');
      await page.locator('#setup-password').fill('zz_test_motdepasse_long');
      await page.getByTestId('setup-form').locator('button[type="submit"]').click();
      await page.getByTestId('key-fingerprint').waitFor();
    },
  },
  {
    id: 'setup-next',
    path: '/setup',
    anonymous: true,
    expectsNetworkError: true,
    routes: setupRoutes(),
    prepare: async (page) => {
      await page.locator('#setup-token').fill('zz_test_jeton_de_demarrage');
      await page.locator('#setup-email').fill('ada@zz-test.example');
      await page.locator('#setup-password').fill('zz_test_motdepasse_long');
      await page.getByTestId('setup-form').locator('button[type="submit"]').click();
      await page.getByTestId('key-fingerprint').waitFor();
      await page.getByTestId('key-acknowledge').check();
      await page.getByTestId('setup-continue').click();
      await page.getByTestId('setup-next').waitFor();
    },
  },
  { id: 'invite', path: '/invite/zz-test-jeton', anonymous: true },
  {
    id: 'invite-invalid',
    path: '/invite/zz-test-jeton',
    anonymous: true,
    expectsNetworkError: true,
    routes: { 'POST /api/invitations/accept': { status: 400, body: { error: { code: 'invitation_invalid', message: 'zz' } } } },
    prepare: async (page) => {
      await page.locator('#invite-password').fill('zz_test_motdepasse_long');
      await page.locator('#invite-confirm').fill('zz_test_motdepasse_long');
      await page.getByTestId('invite-form').locator('button[type="submit"]').click();
      await page.getByTestId('invite-error').waitFor();
    },
  },
  { id: 'forgot-password', path: '/forgot-password', anonymous: true },
  {
    id: 'forgot-password-done',
    path: '/forgot-password',
    anonymous: true,
    routes: { 'POST /api/auth/password-reset/request': { status: 202, body: { status: 'accepted' } } },
    prepare: async (page) => {
      await page.locator('#forgot-email').fill('ada@zz-test.example');
      await page.locator('form button[type="submit"]').click();
      await page.getByTestId('forgot-done').waitFor();
    },
  },
  { id: 'reset-password', path: '/reset-password/zz-test-jeton', anonymous: true },
  {
    id: 'login-second-factor',
    path: '/login',
    anonymous: true,
    expectsNetworkError: true,
    routes: secondFactorRoutes(),
    prepare: reachSecondFactor,
  },
  {
    id: 'login-second-factor-error',
    path: '/login',
    anonymous: true,
    expectsNetworkError: true,
    routes: secondFactorRoutes(),
    prepare: async (page) => {
      await reachSecondFactor(page);
      await page.locator('#login-code').fill('000000');
      await page.getByTestId('second-factor-form').locator('button[type="submit"]').click();
      await page.getByTestId('login-error').waitFor();
    },
  },
  {
    id: 'two-factor-setup',
    path: '/two-factor-setup',
    routes: enrollmentRequired,
  },
  {
    id: 'two-factor-setup-seed',
    path: '/two-factor-setup',
    routes: enrollmentRequired,
    prepare: async (page) => {
      await page.locator('#two-factor-password').fill('zz_test_motdepasse_long');
      await page.getByTestId('two-factor-start').locator('button[type="submit"]').click();
      await page.getByTestId('two-factor-seed').waitFor();
    },
  },
  // Administration (owner) : utilisateurs, invitations, audit ; un lien d'invitation affiché une fois ; une confirmation en ligne.
  { id: 'admin-users', path: '/admin/users' },
  {
    id: 'admin-users-admin-role',
    path: '/admin/users',
    routes: asRole('admin'),
  },
  {
    id: 'admin-users-invite-link',
    path: '/admin/users',
    routes: { 'POST /api/invitations': { status: 201, body: { id: UUID(912), email: 'hal@zz-test.example', role: 'member', invited_by: UUID(900), expires_at: '2099-10-02T09:00:00.000Z', created_at: '2026-09-29T09:00:00.000Z', accepted_at: null, revoked_at: null, emailed: false, link: 'http://127.0.0.1/invite/zz-test-jeton-unique' } } },
    prepare: async (page) => {
      await page.locator('#invite-email').fill('hal@zz-test.example');
      await page.getByTestId('invite-form').locator('button[type="submit"]').click();
      await page.getByTestId('secret-value').waitFor();
    },
  },
  {
    id: 'admin-users-confirm',
    path: '/admin/users',
    prepare: async (page) => {
      await page.getByTestId('account-row').nth(2).getByTestId('action-disable').click();
      await page.getByTestId('confirm-panel').waitFor();
    },
  },
  {
    id: 'admin-users-reset-link',
    path: '/admin/users',
    routes: { 'POST /api/users/:id/reset-link': { status: 201, body: { link: 'http://127.0.0.1/reset-password/zz-test-jeton-unique', expires_at: '2099-10-02T09:00:00.000Z' } } },
    prepare: async (page) => {
      await page.getByTestId('account-row').nth(2).getByTestId('action-resetLink').click();
      await page.getByTestId('confirm-yes').click();
      await page.getByTestId('secret-value').waitFor();
    },
  },
  { id: 'admin-audit', path: '/admin/audit' },
  { id: 'admin-audit-empty', path: '/admin/audit', routes: { 'GET /api/audit': { body: { events: [], next_cursor: null } } } },
  { id: 'admin-audit-error', path: '/admin/audit', expectsNetworkError: true, routes: { 'GET /api/audit': { status: 500, body: { error: { code: 'internal', message: 'zz' } } } } },
  ...SETTINGS.map((tab): Screen => ({ id: `settings-${tab}`, path: `/settings/${tab}` })),
  {
    id: 'settings-keys-created',
    path: '/settings/keys',
    routes: { 'POST /api/api-keys': { status: 201, body: { id: UUID(942), label: 'Nouvel outil', prefix: 'sy_live_ij56kl', scopes: ['apis:read'], expiresAt: '2099-01-01T00:00:00.000Z', lastUsedAt: null, createdAt: '2026-09-29T09:00:00.000Z', revokedAt: null, key: 'sy_live_zz_test_secret_une_seule_fois' } } },
    prepare: async (page) => {
      await page.locator('#key-label').fill('Nouvel outil');
      await page.getByTestId('scope-apis:read').check();
      await page.locator('#key-password').fill('zz_test_motdepasse_long');
      await page.getByTestId('key-form').locator('button[type="submit"]').click();
      await page.getByTestId('secret-value').waitFor();
    },
  },
  {
    id: 'settings-account-backup-codes',
    path: '/settings/account',
    routes: (locale, theme) => ({
      'GET /api/me': { body: { ...ME(locale, theme), mfaEnabled: false } },
      ...ENROLL,
      'POST /api/me/2fa/confirm': { body: { backup_codes: ['aaaa-1111', 'bbbb-2222', 'cccc-3333', 'dddd-4444', 'eeee-5555', 'ffff-6666', 'gggg-7777', 'hhhh-8888', 'iiii-9999', 'jjjj-0000'] } },
    }),
    prepare: async (page) => {
      await page.locator('#two-factor-password').fill('zz_test_motdepasse_long');
      await page.getByTestId('two-factor-start').locator('button[type="submit"]').click();
      await page.locator('#two-factor-code').fill('123456');
      await page.getByTestId('two-factor-confirm').locator('button[type="submit"]').click();
      await page.getByTestId('secret-value').waitFor();
    },
  },
  { id: 'settings-account-member', path: '/settings/account', routes: asRole('member') },
  { id: 'settings-account-no-2fa', path: '/settings/account', routes: asRole('member', { mfaEnabled: false }) },
  // Fiche d'une API bloquée : panneau « Bloquée » et ses trois parties, puis chaque onglet.
  ...TABS.map((tab): Screen => ({ id: `api-bloquee-${tab}`, path: `/apis/zz-bloquee/${tab}` })),
  // Autres états de la fiche : action requise (bandeau), enquête en cours, API saine avec drapeau stale, confirmation en ligne.
  { id: 'api-action-requise', path: '/apis/zz-action-requise' },
  { id: 'api-enquete-investigations', path: '/apis/zz-enquete/investigations' },
  { id: 'api-sain-schedules', path: '/apis/zz-sain/schedules' },
  { id: 'api-sain-runs', path: '/apis/zz-sain/runs' },
  // États affichés après une action : lancement, relance (avec le choix de la version), items d'un run, comparaison de versions, replay.
  {
    id: 'api-sain-launch-started',
    path: '/apis/zz-sain',
    routes: { 'POST /api/apis/:slug/runs': { status: 202, body: { run_id: RUN_ID, state: 'queued' } } },
    prepare: async (page) => {
      await page.locator('#launch-max_pages').fill('2');
      await page.getByTestId('launch-submit').click();
      await page.getByTestId('launch-started').waitFor();
    },
  },
  {
    id: 'api-sain-runs-relaunch',
    path: '/apis/zz-sain/runs',
    // Le premier run a été produit par la version 2 alors que la 3 est la courante : le formulaire montre son choix de version.
    routes: { 'GET /api/runs': (request) => ({ body: { runs: runsOf(request.query.get('api') ?? 'zz-sain').map((entry, index) => (index === 0 ? { ...entry, strategy_version: 2 } : entry)), next_cursor: null } }) },
    prepare: async (page) => {
      await page.getByTestId('runs-table').locator('tbody tr').first().getByRole('button').nth(1).click();
      await page.locator('#runs-relaunch').waitFor({ state: 'attached' });
      await page.locator('#launch-version').waitFor();
    },
  },
  {
    id: 'api-sain-runs-items',
    path: '/apis/zz-sain/runs',
    prepare: async (page) => {
      await page.getByTestId('runs-table').locator('tbody tr').first().getByRole('button').nth(0).click();
      await page.getByTestId('items-table').waitFor();
    },
  },
  {
    id: 'api-sain-strategy-compare',
    path: '/apis/zz-sain/strategy',
    prepare: async (page) => {
      await page.locator('#compare-from').selectOption('3');
      await page.locator('#compare-against').selectOption('2');
      await page.locator('section[aria-labelledby="strategy-compare"] form button[type="submit"]').click();
      await page.getByTestId('strategy-diff').waitFor();
    },
  },
  {
    id: 'api-sain-replay',
    path: '/apis/zz-sain/investigations',
    // Le replay s'ouvre au montage sur la version courante ; on le rouvre sur la version 2 après avoir posé ses événements.
    prepare: async (page, app) => {
      app.setRunEvents(REPLAYED_RUN, replayFrames);
      await page.locator('#investigation-run').selectOption(REPLAYED_RUN);
      await page.getByTestId('replay-log').locator('li').nth(replayFrames.length - 1).waitFor();
    },
  },
  {
    id: 'api-sain-revert-confirm',
    path: '/apis/zz-sain/strategy',
    prepare: async (page) => {
      await page.getByRole('button', { name: /^(Go back to this version|Revenir à cette version)$/ }).first().click();
      await page.getByTestId('confirm-panel').waitFor();
    },
  },
];
