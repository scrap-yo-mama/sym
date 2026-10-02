// SPDX-License-Identifier: AGPL-3.0-only
// assert_console_visual_language, volet navigateur (3.21, D-60) : sur chaque écran hors maquette, le titre de page est en Bricolage
// de 44 à 54 px à 1280 px de large, la barre de navigation reprend les mots de la planche Démarrage avec « Nouvelle API » en bouton
// jaune à droite, et la connexion est en deux colonnes avec la carte d'illustration bleue. Le thème sombre garde les mêmes mesures.
import { test, expect } from './console.fixture.ts';
import { SCREENS } from './screens.ts';

const IDS = ['login', 'setup', 'setup-next', 'forgot-password', 'invite', 'runs', 'admin-users', 'admin-audit', 'settings-account-member', 'api-sain-runs', 'api-bloquee-overview'];

for (const theme of ['light', 'dark'] as const) {
  test.describe(`assert_console_visual_language : ${theme}`, () => {
    test.use({ uiLocale: 'fr', uiTheme: theme, viewport: { width: 1280, height: 900 } });

    for (const id of IDS) {
      test(`${id} : titre Bricolage de 44 à 54 px, pastille de rubrique`, async ({ consolePage }) => {
        const { page, app, open } = consolePage;
        const screen = SCREENS.find((candidate) => candidate.id === id);
        if (!screen) throw new Error(`écran ${id} introuvable`);
        await open(screen.path, { anonymous: screen.anonymous, routes: screen.routes });
        await expect(page.locator('h1').first()).toBeVisible();
        await app.settled();
        const heading = await page.locator('h1').first().evaluate((el) => {
          const style = getComputedStyle(el);
          return { family: style.fontFamily, size: Number.parseFloat(style.fontSize), weight: style.fontWeight };
        });
        expect(heading.family).toMatch(/^"?Bricolage Grotesque"?,/);
        expect(heading.size).toBeGreaterThanOrEqual(44);
        expect(heading.size).toBeLessThanOrEqual(54);
        expect(Number(heading.weight)).toBe(800);
        await expect(page.getByTestId('page-kicker').first()).toBeVisible();
      });
    }
  });
}

test.describe('barre de navigation et connexion fidèles à la planche', () => {
  test.use({ uiLocale: 'fr', uiTheme: 'light', viewport: { width: 1280, height: 900 } });

  test('la barre dit Démarrage, Catalogue, Runs, Réglages ; « Nouvelle API » est le bouton jaune à droite', async ({ consolePage }) => {
    const { page, app, open } = consolePage;
    await open('/runs');
    await expect(page.locator('h1').first()).toBeVisible();
    await app.settled();
    const nav = page.getByRole('navigation', { name: 'Navigation principale' });
    const labels = await nav.getByRole('link').allTextContents();
    expect(labels).toEqual(expect.arrayContaining(['Démarrage', 'Catalogue', 'Runs', 'Réglages']));
    expect(labels).not.toContain('Nouvelle API');
    const cta = page.getByTestId('nav-cta');
    await expect(cta).toHaveText('Nouvelle API');
    const box = await cta.boundingBox();
    const navBox = await nav.boundingBox();
    expect(box && navBox && box.x > navBox.x + navBox.width).toBe(true);
    expect(await cta.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 199, 39)');
    expect(await page.locator('header.sym-on-ink p').first().evaluate((el) => getComputedStyle(el).textTransform)).toBe('lowercase');
  });

  test('la connexion est en deux colonnes : formulaire à gauche, carte bleue à formes et bulle à droite', async ({ consolePage }) => {
    const { page, app, open } = consolePage;
    await open('/login', { anonymous: true });
    await expect(page.locator('h1').first()).toBeVisible();
    await app.settled();
    const illustration = page.getByTestId('sym-illustration');
    await expect(illustration).toBeVisible();
    const [form, card] = await Promise.all([page.locator('form').first().boundingBox(), illustration.boundingBox()]);
    expect(form && card && form.x + form.width <= card.x).toBe(true);
    expect(await illustration.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(58, 51, 240)');
    expect(await illustration.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('24px');
    await expect(illustration.locator('[data-sym-bubble]')).toContainText('OK, je m\'en occupe.');
  });
});
