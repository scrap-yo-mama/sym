// SPDX-License-Identifier: AGPL-3.0-only
// assert_live_regions_plan (06 § 3, « Plan des live regions », tâche 3.9) en Chromium : chaque zone annonce par le bon rôle ARIA, sans
// déplacer le focus. Essais d'une enquête : `role="log"` ; étape et état : `role="status"` ; catalogue : `role="status"`, seul le
// changement de statut d'une ligne ; action requise et erreur : `role="alert"`, une fois. Le bandeau de coupure ne vole pas le focus.
import { test, expect } from './console.fixture.ts';
import { catalog, detail, text, UUID } from './fixtures.ts';
import { activeElement } from './keys.ts';

const RUN = UUID(950);
const API = UUID(951);

for (const locale of ['en', 'fr'] as const) {
  test.describe(`assert_live_regions_plan : ${locale}`, () => {
    test.use({ uiLocale: locale, uiTheme: 'light' });

    test('catalogue : seul le changement de statut d’une ligne est annoncé (role=status), le focus ne bouge pas', async ({ consolePage }) => {
      const { page, app, open } = consolePage;
      let flipped = false;
      const rows = (): ReturnType<typeof catalog> => catalog().map((api) => (flipped && api.slug === 'zz-sain' ? { ...api, status: 'erreur' as const, stale: false } : api));
      await open('/apis', { routes: { 'GET /api/apis': () => ({ body: { apis: rows(), next_cursor: null } }) } });
      await expect(page.getByTestId('catalog-row').first()).toBeVisible();
      const live = page.getByTestId('catalog-live');
      await expect(live).toHaveAttribute('role', 'status');
      await expect(live).toHaveText('');

      // Le focus est sur le champ de recherche pendant qu'une ligne change de statut.
      for (let step = 0; step < 20 && !(await activeElement(page)).includes('catalog-search'); step += 1) await page.keyboard.press('Tab');
      const before = await activeElement(page);
      expect(before).toContain('catalog-search');
      flipped = true;
      app.pushEvent('status.changed', { slug: 'zz-sain' }, '1');
      await expect(live).toHaveText(text(locale, 'catalog.statusChanged').replace('{slug}', 'zz-sain').replace('{status}', text(locale, 'status.erreur')));
      expect(await activeElement(page)).toBe(before);
      await expect(page.locator('[role="alert"]')).toHaveCount(0);
    });

    test('catalogue : suivi suspendu, le flux n’annonce plus rien et ne relit plus ; la reprise rattrape', async ({ consolePage }) => {
      const { page, app, open } = consolePage;
      let status: 'sain' | 'erreur' = 'sain';
      await open('/apis', {
        routes: { 'GET /api/apis': () => ({ body: { apis: catalog().map((api) => (api.slug === 'zz-sain' ? { ...api, status } : api)), next_cursor: null } }) },
      });
      await expect(page.getByTestId('catalog-row').first()).toBeVisible();
      await page.getByTestId('catalog-follow-toggle').click();
      const reads = app.requests.filter((entry) => entry.startsWith('GET /api/apis?')).length;
      status = 'erreur';
      app.pushEvent('status.changed', { slug: 'zz-sain' }, '1');
      await page.waitForTimeout(700);
      expect(app.requests.filter((entry) => entry.startsWith('GET /api/apis?')).length).toBe(reads);
      await expect(page.getByTestId('catalog-live')).toHaveText(text(locale, 'catalog.follow.suspended'));
      await page.getByTestId('catalog-follow-toggle').click();
      await expect(page.locator('[data-slug="zz-sain"]')).toHaveAttribute('data-status', 'erreur');
    });

    test('enquête : un essai terminé entre dans role=log (une phrase), l’étape dans role=status, le focus ne bouge pas', async ({ consolePage }) => {
      const { page, app, open } = consolePage;
      await open('/apis/new', {
        routes: {
          'POST /api/apis': {
            status: 201,
            body: { api_id: API, slug: 'zz-nouvelle', investigation_phase: 'access_check', proposed_output_schema: null, sample: [], access_report: null, run_id: RUN },
          },
        },
      });
      await expect(page.locator('h1')).toBeVisible();
      await page.locator('#api-description').fill('Titre et prix de chaque annonce');
      await page.locator('#api-url').fill('https://zz-test.example/annonces');
      await page.getByRole('button', { name: text(locale, 'newApi.submit') }).click();

      const log = page.locator('[role="log"]').first();
      await expect(log).toBeVisible();
      await expect(log).toHaveAttribute('aria-live', 'polite');
      const status = page.getByTestId('investigation-status');
      await expect(status).toHaveAttribute('role', 'status');

      // Le focus est sur « Suspendre le suivi » ; il y reste pendant que les événements arrivent.
      const follow = page.getByTestId('follow-toggle');
      await follow.focus();
      const before = await activeElement(page);
      const items = log.locator('li[data-testid="attempt"]');
      await expect(items).toHaveCount(0);
      // Avant tout événement, la région dit l'étape de la réponse du POST (« Vérification de l'accès ») : pas encore « Essais ».
      const phaseText = (phase: string): string => text(locale, 'investigation.phase.announce').replace('{phase}', text(locale, `investigation.phase.${phase}`));
      await expect(status).toHaveText(phaseText('access_check'));
      app.pushEvent('phase.started', { run_id: RUN, api_id: API, api_slug: 'zz-nouvelle', phase: 'testing', plan: [{ execution: 'fetch', network: 'direct', est_cost_usd: 0.001 }] }, '10');
      app.pushEvent('attempt.finished', { run_id: RUN, api_id: API, api_slug: 'zz-nouvelle', attempt: { index: 0, execution: 'fetch', network: 'direct', state: 'done', est_cost_usd: 0.001, result: 'extraction', cost_usd: 0.001, ms: 240 } }, '11');
      await expect(items).toHaveCount(1);
      expect(await activeElement(page)).toBe(before);
      // Le passage à l'étape « Essais » est annoncé dans la même région, avec le texte exact.
      await expect(status).toHaveText(phaseText('testing'));
      await expect(page.locator('[role="alert"]')).toHaveCount(0);

      // Suspendre le suivi (2.2.2) : plus d'annonce (aria-live=off), l'affichage se fige.
      await page.keyboard.press('Enter');
      await expect(log).toHaveAttribute('aria-live', 'off');
      app.pushEvent('attempt.finished', { run_id: RUN, api_id: API, api_slug: 'zz-nouvelle', attempt: { index: 1, execution: 'agent', network: 'direct', state: 'done', est_cost_usd: 0.09, result: 'extraction', cost_usd: 0.09, ms: 900 } }, '12');
      await page.waitForTimeout(400);
      await expect(items).toHaveCount(1);
    });

    test('action requise : une alerte (role=alert), une seule fois, sans retirer le focus', async ({ consolePage }) => {
      const { page, app, open } = consolePage;
      let asking = false;
      const base = detail('sain', 'zz-books');
      await open('/apis/zz-books', {
        routes: {
          'GET /api/apis/:slug': () => ({
            body: asking
              ? { ...base, status: 'action_requise', status_reason: { code: 'cookie_expired', params: { domain: 'monsite.example' } }, requires: { session_domain: 'monsite.example', tunnel: false } }
              : base,
          }),
        },
      });
      await expect(page.locator('h1')).toBeVisible();
      await page.locator('[data-tab="schemas"]').focus();
      const before = await activeElement(page);
      await expect(page.locator('section[role="alert"]')).toHaveCount(0);
      asking = true;
      app.pushEvent('action.required', { api_slug: 'zz-books', cause: 'cookie_expired', domain: 'monsite.example' }, '20');
      app.pushEvent('status.changed', { api_slug: 'zz-books', slug: 'zz-books', status: 'action_requise' }, '21');
      await expect(page.locator('section[role="alert"]')).toHaveCount(1);
      expect(await activeElement(page)).toBe(before);

      // « Une seule fois » dans la durée : des événements identiques (rejeu de `status.changed`, `action.required` répété) relisent la
      // fiche mais ne recréent pas l'alerte (même nœud) et ne la réécrivent pas (aucune mutation : un lecteur d'écran n'a rien à relire).
      const alert = page.locator('section[role="alert"]');
      const node = await alert.elementHandle();
      expect(node).not.toBeNull();
      const textBefore = await alert.textContent();
      await node?.evaluate((element) => {
        const target = element as HTMLElement & { __mutations?: number };
        target.__mutations = 0;
        new MutationObserver((records) => void (target.__mutations = (target.__mutations ?? 0) + records.length)).observe(target, { subtree: true, childList: true, characterData: true, attributes: true });
      });
      const reads = (): number => app.requests.filter((entry) => entry === 'GET /api/apis/zz-books').length;
      const readsBefore = reads();
      app.pushEvent('status.changed', { api_slug: 'zz-books', slug: 'zz-books', status: 'action_requise' }, '22');
      app.pushEvent('action.required', { api_slug: 'zz-books', cause: 'cookie_expired', domain: 'monsite.example' }, '23');
      await expect.poll(reads, { message: 'la fiche est relue après les événements rejoués' }).toBeGreaterThan(readsBefore);
      await app.settled();
      await page.waitForTimeout(300);
      await expect(alert).toHaveCount(1);
      const same = await page.evaluate(([kept, current]) => kept === current, [node, await alert.elementHandle()] as const);
      expect(same, 'le nœud section[role=alert] est conservé').toBe(true);
      expect(await node?.evaluate((element) => element.isConnected)).toBe(true);
      expect(await node?.evaluate((element) => (element as HTMLElement & { __mutations?: number }).__mutations), 'l’alerte n’est pas réécrite').toBe(0);
      expect(await alert.textContent()).toBe(textBefore);
      expect(await activeElement(page)).toBe(before);
    });

    test('bandeau de coupure : affiché (role=status) sans voler le focus, retiré à la reprise', async ({ consolePage }) => {
      const { page, app, open } = consolePage;
      await open('/apis');
      await expect(page.getByTestId('catalog-row').first()).toBeVisible();
      await expect.poll(() => app.openStreams()).toBe(1);
      for (let step = 0; step < 20 && !(await activeElement(page)).includes('catalog-search'); step += 1) await page.keyboard.press('Tab');
      const before = await activeElement(page);
      expect(before).toContain('catalog-search');

      app.dropStreams();
      const banner = page.getByTestId('connection-banner');
      await expect(banner).toBeVisible();
      await expect(banner).toHaveAttribute('role', 'status');
      expect(await activeElement(page)).toBe(before);
      await expect(page.locator('[role="alert"]')).toHaveCount(0);

      // Le client reconnecte : un nouveau flux est ouvert et le bandeau disparaît.
      await expect.poll(() => app.openStreams(), { timeout: 20_000 }).toBe(1);
      await expect(banner).toBeHidden();
      expect(await activeElement(page)).toBe(before);
    });
  });
}
