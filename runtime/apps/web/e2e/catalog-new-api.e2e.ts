// SPDX-License-Identifier: AGPL-3.0-only
// Refonte du Catalogue et de Nouvelle API en Chromium (3.17, 20 § 5.2-§ 5.3, critères de 20b § 3.3, étage E1) : barre de santé
// sans les API bloquées, pastilles-filtres, une action utile par ligne ; quatre jalons, porte d'accord avant tout essai, exemples
// réels des champs identiques en `en` et en `fr`. Aucun site réel : le faux serveur de e2e/harness.ts. La régression visuelle par
// langue et pseudo-locale de ces écrans est e2e/visual.e2e.ts (projets ui-en, ui-fr, ui-pseudo) ; les captures côte à côte avec
// les planches, e2e/maquette-fidelity.e2e.ts.
import { test, expect } from './console.fixture.ts';
import { catalog, text, UUID } from './fixtures.ts';

const RUN = UUID(960);
const API = UUID(961);
const SLUG = 'zz-livres';

/** Échantillon et schéma de la porte : les exemples affichés sont ces valeurs, telles quelles, dans toutes les langues. */
const SAMPLE = [{ titre: 'Les Misérables — édition « 2024 »', prix: 1234.5, auteur: 'Hugo, Victor', email: 'lecteur@exemple.test' }];
const SCHEMA = { type: 'array', items: { type: 'object', properties: { titre: { type: 'string' }, prix: { type: 'number' }, auteur: { type: 'string' }, email: { type: 'string', 'x-personal': true } } } };
const EXPECTED_EXAMPLES = ['Les Misérables — édition « 2024 »', '1234.5', 'Hugo, Victor', '•••'];

for (const locale of ['en', 'fr'] as const) {
  test.describe(`refonte du catalogue : ${locale}`, () => {
    test.use({ uiLocale: locale, uiTheme: 'light' });

    test('assert_catalog_health_excludes_blocked : la barre dit « n sur m saines · 1 arrêt volontaire », l’API bloquée est hors du dénominateur', async ({ consolePage }) => {
      const { page, app, open } = consolePage;
      await open('/apis');
      await expect(page.getByTestId('catalog-health')).toBeVisible();
      await app.settled();
      const rows = catalog();
      const stopped = rows.filter((api) => api.status === 'bloquee').length;
      const inService = rows.length - stopped;
      const healthy = rows.filter((api) => api.status === 'sain').length;
      expect(stopped).toBe(1);
      await expect(page.getByTestId('health-ratio')).toHaveText(text(locale, 'catalog.health.ratio').replace('{healthy}', String(healthy)).replace('{total}', String(inService)));
      await expect(page.getByTestId('health-stopped')).toBeVisible();
      // La légende est du texte ; la barre est décorative et ne porte pas l'API bloquée.
      await expect(page.getByTestId('health-legend')).toBeVisible();
      await expect(page.locator('[data-testid="health-bar"] rect[data-status="bloquee"]')).toHaveCount(0);
      await expect(page.getByTestId('health-bar')).toHaveAttribute('aria-hidden', 'true');
    });

    test('assert_attention_filters_counts : « À traiter » est actif à l’ouverture, les compteurs sont en texte', async ({ consolePage }) => {
      const { page, app, open } = consolePage;
      await open('/apis');
      await expect(page.getByTestId('catalog-pills')).toBeVisible();
      await app.settled();
      const rows = catalog();
      const attention = rows.filter((api) => ['warning', 'erreur', 'action_requise'].includes(api.status)).length;
      const pill = (id: string) => page.locator(`[data-testid="catalog-pills"] [data-pill="${id}"]`);
      await expect(pill('attention')).toHaveAttribute('aria-pressed', 'true');
      await expect(pill('all')).toHaveAttribute('aria-pressed', 'false');
      await expect(pill('attention')).toHaveText(text(locale, 'catalog.pills.withCount').replace('{label}', text(locale, 'catalog.pills.attention')).replace('{n}', String(attention)));
      // Un clic sur « Tout » bascule la pastille active ; le focus reste sur le bouton.
      await pill('all').click();
      await expect(pill('all')).toHaveAttribute('aria-pressed', 'true');
      await expect(pill('attention')).toHaveAttribute('aria-pressed', 'false');
    });

    test('assert_row_action_by_status : bloquee n’offre que « Voir les alternatives » ; aucune relance ni tunnel', async ({ consolePage }) => {
      const { page, app, open } = consolePage;
      await open('/apis');
      await expect(page.getByTestId('catalog-pills')).toBeVisible();
      await app.settled();
      await page.locator('[data-testid="catalog-pills"] [data-pill="all"]').click();
      const action = (status: string) => page.locator(`[data-testid="catalog-row"][data-status="${status}"] [data-testid="row-action"]`);
      await expect(action('bloquee')).toHaveCount(1);
      await expect(action('bloquee')).toHaveText(text(locale, 'catalog.rowAction.alternatives'));
      await expect(action('action_requise')).toHaveCount(1);
      await expect(action('sain')).toHaveCount(0);
      const blockedRow = page.locator('[data-testid="catalog-row"][data-status="bloquee"]');
      await expect(blockedRow.getByRole('button')).toHaveCount(0);
      await expect(blockedRow).not.toContainText(/tunnel|proxy|retry|réessayer|relancer/i);
      // L'action ouvre le panneau « Bloquée » de la fiche (ancre).
      await action('bloquee').click();
      await expect(page).toHaveURL(/\/apis\/zz-bloquee#blocked-panel$/);
    });
  });

  test.describe(`refonte de Nouvelle API : ${locale}`, () => {
    test.use({ uiLocale: locale, uiTheme: 'light' });

    test('quatre jalons, porte d’accord avant tout essai, exemples réels identiques dans toutes les langues', async ({ consolePage }) => {
      const { page, app, open } = consolePage;
      await open('/apis/new', {
        routes: {
          'POST /api/apis': { status: 201, body: { api_id: API, slug: SLUG, investigation_phase: 'access_check', proposed_output_schema: null, sample: [], access_report: null, run_id: RUN } },
          'POST /api/apis/:id/validate-schema': { status: 202, body: { run_id: RUN } },
        },
      });
      // Jalon 1 « Décrire » en cours, dans la même frise que pendant l'enquête.
      const timeline = page.getByTestId('phase-timeline');
      await expect(timeline).toBeVisible();
      await expect(timeline.locator('li')).toHaveCount(4);
      await expect(timeline.locator('[data-milestone="describe"]')).toHaveAttribute('aria-current', 'step');
      for (const key of ['describe', 'reconnaissance', 'schema', 'trials']) await expect(timeline).toContainText(text(locale, `investigation.milestones.${key}`));

      await page.locator('#api-description').fill('Titre et prix de chaque livre');
      await page.locator('#api-url').fill('https://zz-test.example/livres');
      await page.getByRole('button', { name: text(locale, 'newApi.submit') }).click();
      await expect(page.getByTestId('investigation-board')).toBeVisible();
      await expect(page.locator('[data-milestone="reconnaissance"]')).toHaveAttribute('aria-current', 'step');
      await expect(page.locator('[data-milestone="describe"]')).toHaveAttribute('data-state', 'done');

      const frame = { run_id: RUN, api_id: API, api_slug: SLUG };
      app.pushEvent('phase.started', { ...frame, domain: 'zz-test.example', phase: 'reconnaissance', plan: [{ execution: 'agent', network: 'direct', est_cost_usd: 0.09 }, { execution: 'fetch', network: 'direct', est_cost_usd: 0.0004 }], budget: { spent_usd: 0.0123, max_usd: 0.5, elapsed_s: 12, timeout_s: 300, retained_est_usd: 0.002, full_agent_est_usd: 0.09 } }, '1');
      app.pushEvent('schema.proposed', { ...frame, output_schema: SCHEMA, sample: SAMPLE }, '2');

      // Jalon 3 : la porte attend l'accord, le coût déjà engagé est dit, aucun essai n'est lancé.
      await expect(page.locator('[data-milestone="schema"]')).toHaveAttribute('aria-current', 'step');
      const gate = page.getByTestId('schema-gate');
      await expect(gate).toBeVisible();
      await expect(gate).toContainText(text(locale, 'investigation.gate.noTrial'));
      await expect(page.getByTestId('gate-spent')).toBeVisible();
      await expect(page.getByTestId('gate-auto')).toHaveCount(0);
      expect(app.requests.filter((entry) => entry.includes('validate-schema')), 'aucun essai avant l’accord').toEqual([]);
      // assert_schema_remark_not_sent : la remarque se saisit, mais aucun bouton ne l'envoie et aucune relance ne part.
      await page.locator('#schema-remark').fill('le prix en euros');
      await expect(page.getByTestId('schema-remark-send')).toHaveCount(0);
      // L'utilisateur voyant le lit aussi : l'aide « ne part nulle part » est affichée sous le champ.
      await expect(page.getByTestId('schema-remark-hint')).toBeVisible();
      await expect(page.getByTestId('schema-remark-hint')).toHaveText(text(locale, 'investigation.schema.remarkHint'));
      expect(app.requests.filter((entry) => entry.includes('/investigate')), 'la remarque ne relance rien').toEqual([]);
      await expect(page.locator('[data-testid="trial-card"][data-state="planned"]')).toHaveCount(2);
      await expect(page.locator('[data-testid="trial-card"]')).toHaveCount(2);
      // Du moins cher au plus cher, quel que soit l'ordre reçu.
      expect(await page.locator('[data-testid="trial-card"]').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-execution')))).toEqual(['fetch', 'agent']);

      // Exemples réels : les valeurs de l'échantillon, octet pour octet, quelle que soit la langue.
      await expect(page.locator('[data-testid="schema-example"]')).toHaveText(EXPECTED_EXAMPLES);
      await expect(page.locator('[data-testid="schema-example"]').first()).toHaveAttribute('translate', 'no');

      // L'accord est un clic de l'utilisateur : alors seulement la validation part.
      await page.getByTestId('schema-validate').click();
      await expect.poll(() => app.requests.filter((entry) => entry.includes('validate-schema')).length).toBe(1);
      await expect(page.locator('[data-milestone="trials"]')).toHaveAttribute('aria-current', 'step');
    });

    test('assert_schema_gate_before_trials : sous auto_validate, le bandeau « validé automatiquement » remplace la porte', async ({ consolePage }) => {
      const { page, app, open } = consolePage;
      await open('/apis/new', {
        routes: { 'POST /api/apis': { status: 201, body: { api_id: API, slug: SLUG, investigation_phase: 'access_check', proposed_output_schema: null, sample: [], access_report: null, run_id: RUN } } },
      });
      await page.locator('#api-description').fill('Titre et prix de chaque livre');
      await page.locator('#api-url').fill('https://zz-test.example/livres');
      await page.getByRole('button', { name: text(locale, 'newApi.submit') }).click();
      await expect(page.getByTestId('investigation-board')).toBeVisible();
      const frame = { run_id: RUN, api_id: API, api_slug: SLUG };
      app.pushEvent('schema.proposed', { ...frame, output_schema: SCHEMA, sample: SAMPLE }, '1');
      app.pushEvent('schema.validated', { ...frame, by: 'auto' }, '2');
      app.pushEvent('phase.started', { ...frame, phase: 'testing' }, '3');
      await expect(page.getByTestId('gate-auto')).toHaveText(text(locale, 'investigation.gate.auto'));
      await expect(page.getByTestId('schema-gate')).toHaveCount(0);
      await expect(page.locator('[data-milestone="trials"]')).toHaveAttribute('aria-current', 'step');
    });

    test('assert_trial_plan_cheapest_first_ui : un couple élagué est grisé avec sa raison, jamais de carte « changer d’adresse »', async ({ consolePage }) => {
      const { page, app, open } = consolePage;
      await open('/apis/new', {
        routes: { 'POST /api/apis': { status: 201, body: { api_id: API, slug: SLUG, investigation_phase: 'access_check', proposed_output_schema: null, sample: [], access_report: null, run_id: RUN } } },
      });
      await page.locator('#api-description').fill('Titre et prix de chaque livre');
      await page.locator('#api-url').fill('https://zz-test.example/livres');
      await page.getByRole('button', { name: text(locale, 'newApi.submit') }).click();
      await expect(page.getByTestId('investigation-board')).toBeVisible();
      const frame = { run_id: RUN, api_id: API, api_slug: SLUG };
      app.pushEvent('schema.proposed', { ...frame, output_schema: SCHEMA, sample: SAMPLE }, '1');
      app.pushEvent('phase.started', { ...frame, phase: 'testing', plan: [{ execution: 'agent', network: 'direct', est_cost_usd: 0.09 }, { execution: 'playwright', network: 'direct', est_cost_usd: 0.003 }, { execution: 'fetch', network: 'direct', est_cost_usd: 0.0004 }] }, '2');
      app.pushEvent('attempt.finished', { ...frame, attempt: { index: 0, execution: 'fetch', network: 'direct', state: 'done', est_cost_usd: 0.0004, result: 'extraction', cost_usd: 0.0004, ms: 240 } }, '3');
      app.pushEvent('attempt.pruned', { ...frame, reason: 'extraction', pruned: [{ execution: 'playwright', network: 'direct', est_cost_usd: 0.003 }] }, '4');
      const cards = page.locator('[data-testid="trial-card"]');
      await expect(cards).toHaveCount(3);
      expect(await cards.evaluateAll((all) => all.map((card) => `${card.getAttribute('data-execution')}:${card.getAttribute('data-state')}`))).toEqual(['fetch:failed', 'playwright:pruned', 'agent:planned']);
      await expect(page.locator('[data-testid="trial-card"][data-state="pruned"]')).toContainText(text(locale, 'investigation.plan.prunedReason').split('{reason}')[0] ?? '');
      await expect(page.getByTestId('trial-plan')).not.toContainText(/changer d.adresse|change (the )?address|proxy|tunnel/i);
      await expect(page.getByTestId('trial-stop-branch')).toBeVisible();
    });

    test('assert_trial_plan_cheapest_first_ui : après un refus (403 → bloquee), le plan direct + proxy serveur du serveur ne montre aucune carte proxy', async ({ consolePage }) => {
      const { page, app, open } = consolePage;
      await open('/apis/new', {
        routes: { 'POST /api/apis': { status: 201, body: { api_id: API, slug: SLUG, investigation_phase: 'access_check', proposed_output_schema: null, sample: [], access_report: null, run_id: RUN } } },
      });
      await page.locator('#api-description').fill('Titre et prix de chaque livre');
      await page.locator('#api-url').fill('https://zz-test.example/livres');
      await page.getByRole('button', { name: text(locale, 'newApi.submit') }).click();
      await expect(page.getByTestId('investigation-board')).toBeVisible();
      const frame = { run_id: RUN, api_id: API, api_slug: SLUG };
      app.pushEvent('schema.proposed', { ...frame, output_schema: SCHEMA, sample: SAMPLE }, '1');
      // Plan réel d'une politique direct + proxy serveur (worker : buildTrialPlan), annoncé au lancement des essais.
      app.pushEvent(
        'phase.started',
        {
          ...frame,
          phase: 'testing',
          plan: [
            { execution: 'fetch', network: 'direct', est_cost_usd: 0.0004 },
            { execution: 'fetch', network: 'dc_proxy', est_cost_usd: 0.0021 },
            { execution: 'playwright', network: 'direct', est_cost_usd: 0.003 },
            { execution: 'playwright', network: 'dc_proxy', est_cost_usd: 0.006 },
          ],
        },
        '2',
      );
      await expect(page.locator('[data-testid="trial-card"]')).toHaveCount(4);
      app.pushEvent('attempt.finished', { ...frame, attempt: { index: 0, execution: 'fetch', network: 'direct', state: 'done', est_cost_usd: 0.0004, result: 'forbidden', cost_usd: 0.0004, ms: 120 } }, '3');
      app.pushEvent('attempt.pruned', { ...frame, reason: 'forbidden', pruned: [{ execution: 'fetch', network: 'dc_proxy', est_cost_usd: 0.0021 }, { execution: 'playwright', network: 'direct', est_cost_usd: 0.003 }, { execution: 'playwright', network: 'dc_proxy', est_cost_usd: 0.006 }] }, '4');
      // assert_trial_plan_pruned_on_refusal : entre l'élagage et le statut `bloquee`, les cartes proxy ont déjà disparu.
      await expect(page.locator('[data-testid="trial-card"]')).toHaveCount(2);
      await expect(page.getByTestId('trial-plan')).not.toContainText(new RegExp(`${text(locale, 'network.dc_proxy')}|tunnel`, 'i'));
      app.pushEvent('status.changed', { ...frame, status: 'bloquee', status_reason: { code: 'forbidden', params: {} } }, '5');
      await expect(page.getByTestId('blocked-panel')).toBeVisible();
      const cards = page.locator('[data-testid="trial-card"]');
      await expect(cards).toHaveCount(2);
      expect(await cards.evaluateAll((all) => all.map((card) => card.getAttribute('data-execution')))).toEqual(['fetch', 'playwright']);
      await expect(page.getByTestId('trial-plan')).not.toContainText(new RegExp(`${text(locale, 'network.dc_proxy')}|changer d.adresse|change (the )?address|tunnel`, 'i'));
      await expect(page.getByTestId('trial-stop-branch')).toBeVisible();
    });
  });
}
