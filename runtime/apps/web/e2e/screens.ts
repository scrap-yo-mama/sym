// SPDX-License-Identifier: AGPL-3.0-only
// Écrans et états de la console couverts par la gate d'accessibilité (06 § 4.3) : chacun est rendu en clair et en sombre, en
// `en` et en `fr`. Un écran ajouté par une tâche suivante (comptes, audit, personnes : 3.8) s'ajoute ici avec sa donnée.
import type { Page } from '@playwright/test';
import { catalog, runsOf, UUID } from './fixtures.ts';
import type { ApiRoutes, ConsoleApp } from './harness.ts';

export type Screen = {
  /** Nom court, stable (titre du test). */
  id: string;
  path: string;
  /** Vrai : écran de l'utilisateur anonyme (connexion). */
  anonymous?: boolean;
  /** Routes d'API propres à l'écran, en plus de celles du catalogue de fixtures. */
  routes?: ApiRoutes;
  /** Vrai : l'état montré provoque une réponse 4xx ou 5xx, ou une coupure du flux, voulue : Chromium la journalise comme erreur de console. */
  expectsNetworkError?: boolean;
  /** Mise en place après le chargement (ouvrir un panneau, remplir un champ, pousser des événements) ; l'écran est alors prêt à être jugé. */
  prepare?: (page: Page, app: ConsoleApp) => Promise<void>;
};

/** Onglets de la fiche d'une API (06 § 1, figure 1). */
const TABS = ['overview', 'schemas', 'strategy', 'runs', 'status', 'schedules', 'access', 'investigations'] as const;

const SETTINGS = ['models', 'proxies', 'extension', 'alerts', 'diagnostic'] as const;

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
  ...SETTINGS.map((tab): Screen => ({ id: `settings-${tab}`, path: `/settings/${tab}` })),
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
