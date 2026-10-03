// SPDX-License-Identifier: AGPL-3.0-only
// Fidélité à la maquette (3.17, D-60) : captures Playwright côte à côte, même viewport (1280 × 900), de la planche servie en
// statique (Catalogue.dc.html, NouvelleApi.dc.html du CDC) et de l'écran réel de la console, en `fr` puis en `en`. Les captures
// sont jointes au rapport et, si SIDE_BY_SIDE_DIR est posé, copiées dans ce dossier pour la relecture (juge opus). Les planches
// vivent dans le CDC, hors du dépôt : sans MAQUETTE_DIR (dossier `maquette-ux/latest/project`), la suite est sautée. Aucun site
// réel : les polices Google des planches sont servies depuis les polices auto-hébergées de packages/ui, toute autre requête
// sortante est coupée. Les textes mot pour mot et la hiérarchie sont vérifiés en unitaire (catalog-maquette.unit.test.ts,
// new-api-maquette.unit.test.ts) ; ici, l'œil.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Locale } from './console.fixture.ts';
import { summary, UUID } from './fixtures.ts';
import { reachSchemaGate } from './screens.ts';

const MAQUETTE_DIR = process.env.MAQUETTE_DIR ?? '';
const OUT_DIR = process.env.SIDE_BY_SIDE_DIR ?? '';
const VIEWPORT = { width: 1280, height: 900 };
const FONTS = new URL('../../../packages/ui/fonts/', import.meta.url);
const FROZEN_AT = new Date('2026-10-02T09:00:00.000Z');

/** Le catalogue de la planche : 3 saines, 1 à surveiller, 1 en réparation, 1 action requise, 1 arrêtée (données fictives). */
const PLANCHE_CATALOG = [
  summary({ id: UUID(1), slug: 'livres-accueil', domain: 'books.toscrape.com', description: "Livres de l'accueil", status: 'sain', execution: 'fetch', avg_cost_usd: 0.0004, avg_cost_estimated: false, last_run_at: '2026-10-02T08:58:00.000Z' }),
  summary({ id: UUID(2), slug: 'contacts-immo', domain: 'zz-site-immo.example', description: 'Mes contacts immobilier', status: 'sain', execution: 'fetch_in_page', avg_cost_usd: 0.001, avg_cost_estimated: false, last_run_at: '2026-10-02T07:00:00.000Z' }),
  summary({ id: UUID(3), slug: 'prix-catalogue', domain: 'zz-boutique.example', description: 'Prix du catalogue', status: 'sain', execution: 'playwright', avg_cost_usd: 0.004, avg_cost_estimated: false }),
  summary({ id: UUID(4), slug: 'prix-boutique', domain: 'zz-boutique.example', description: 'Prix de la boutique', status: 'warning', status_reason: { code: 'escalated', params: {} }, execution: 'playwright', avg_cost_usd: 0.004, avg_cost_estimated: false }),
  summary({ id: UUID(5), slug: 'offres-emploi', domain: 'zz-jobs.example', description: "Offres d'emploi", status: 'reparation', status_reason: { code: 'repairing', params: { n: 3, m: 4 } }, execution: 'hybrid', avg_cost_usd: 0.02, avg_cost_estimated: false }),
  summary({ id: UUID(6), slug: 'commentaires-post', description: "Commentaires d'un post", status: 'action_requise', status_reason: { code: 'auth_required', params: { domain: 'zz-site-a-compte.example' } }, execution: 'playwright', network: 'tunnel', requires: { session_domain: 'zz-site-a-compte.example', tunnel: true }, avg_cost_usd: null, last_run_at: null, success_rate_30d: null }),
  summary({ id: UUID(7), slug: 'annonces-recherche', domain: 'zz-annonces.example', description: 'Annonces de recherche', status: 'bloquee', status_reason: { code: 'robots_disallowed', params: {} }, execution: null, network: null, avg_cost_usd: null, last_run_at: null, success_rate_30d: null, access_signal: 'disallowed' }),
];

/** Sert la planche en statique, polices comprises, sans aucune requête sortante. */
async function openPlanche(page: Page, file: string): Promise<void> {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'fonts.googleapis.com') {
      const css = readFileSync(new URL('../src/fonts.css', FONTS), 'utf8').replaceAll('../fonts/', 'https://zz-fonts.invalid/');
      return route.fulfill({ status: 200, contentType: 'text/css', body: css });
    }
    if (url.hostname === 'zz-fonts.invalid') return route.fulfill({ status: 200, contentType: 'font/woff2', body: readFileSync(new URL(url.pathname.slice(1), FONTS)) });
    return route.abort();
  });
  await page.goto(`file://${join(MAQUETTE_DIR, file)}`);
  await page.evaluate(() => document.fonts.ready);
}

/** Deux captures côte à côte, dans une seule image : à gauche la planche, à droite l'écran réel. */
async function sideBySide(page: Page, left: Buffer, right: Buffer, title: string): Promise<Buffer> {
  const src = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;
  await page.setViewportSize({ width: VIEWPORT.width * 2 + 24, height: VIEWPORT.height + 40 });
  await page.setContent(
    `<body style="margin:0;background:#888;font:14px sans-serif"><p style="margin:0;padding:10px 12px;color:#fff">${title} — à gauche la planche, à droite la console</p><div style="display:flex;gap:24px"><img src="${src(left)}"><img src="${src(right)}"></div></body>`,
  );
  return page.screenshot({ fullPage: true });
}

function keep(name: string, png: Buffer): void {
  if (OUT_DIR === '') return;
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, name), png);
}

test.describe('fidélité à la maquette (D-60) : captures côte à côte', () => {
  test.skip(MAQUETTE_DIR === '' || !existsSync(MAQUETTE_DIR), 'MAQUETTE_DIR absent : planches du CDC hors du dépôt');
  test.use({ viewport: VIEWPORT, uiTheme: 'light' });

  for (const locale of ['fr', 'en'] as Locale[]) {
    test.describe(locale, () => {
      test.use({ uiLocale: locale });

      test('Catalogue : planche / console', async ({ consolePage, browser }, testInfo) => {
        const { page, app, open } = consolePage;
        await page.clock.setFixedTime(FROZEN_AT);
        await open('/apis', { routes: { 'GET /api/apis': (request) => ({ body: { apis: PLANCHE_CATALOG.filter((api) => !request.query.get('status') || api.status === request.query.get('status')), next_cursor: null } }) } });
        await expect(page.getByTestId('catalog-health')).toBeVisible();
        await app.settled();
        // La planche montre « Tout » : même vue, même nombre de lignes.
        await page.locator('[data-testid="catalog-pills"] [data-pill="all"]').click();
        await expect(page.getByTestId('catalog-row')).toHaveCount(PLANCHE_CATALOG.length);
        await app.settled();
        const real = await page.screenshot();
        const planchePage = await browser.newPage({ viewport: VIEWPORT });
        await openPlanche(planchePage, 'Catalogue.dc.html');
        const planche = await planchePage.screenshot();
        const both = await sideBySide(planchePage, planche, real, `Catalogue (${locale})`);
        await planchePage.close();
        await testInfo.attach(`catalogue-${locale}-cote-a-cote.png`, { body: both, contentType: 'image/png' });
        keep(`catalogue-${locale}-cote-a-cote.png`, both);
      });

      test('Nouvelle API, jalon 3 : planche / console', async ({ consolePage, browser }, testInfo) => {
        const { page, app, open } = consolePage;
        await page.clock.setFixedTime(FROZEN_AT);
        await open('/apis/new', {
          routes: { 'POST /api/apis': { status: 201, body: { api_id: UUID(951), slug: 'zz-nouvelle', investigation_phase: 'access_check', proposed_output_schema: null, sample: [], access_report: null, run_id: UUID(950) } } },
        });
        await expect(page.locator('h1').first()).toBeAttached();
        await app.settled();
        await reachSchemaGate(page, app);
        await app.settled();
        const real = await page.screenshot();
        const planchePage = await browser.newPage({ viewport: VIEWPORT });
        await openPlanche(planchePage, 'NouvelleApi.dc.html');
        const planche = await planchePage.screenshot();
        const both = await sideBySide(planchePage, planche, real, `Nouvelle API, jalon 3 (${locale})`);
        await planchePage.close();
        await testInfo.attach(`nouvelle-api-${locale}-cote-a-cote.png`, { body: both, contentType: 'image/png' });
        keep(`nouvelle-api-${locale}-cote-a-cote.png`, both);
      });
    });
  }
});
