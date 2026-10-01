// SPDX-License-Identifier: AGPL-3.0-only
// assert_a11y_axe_clean (06 § 1 et § 4.3, gate de recette, tâche 3.9) : chaque écran de la console, en clair et en sombre, en
// `en` et en `fr`, passe axe (tags wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa) sans violation sérieuse ou critique, et la
// console du navigateur reste sans erreur. Les violations modérées et mineures sont elles aussi refusées : la gate vise 0.
import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Locale, type Theme } from './console.fixture.ts';
import { SCREENS } from './screens.ts';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const THEMES: Theme[] = ['light', 'dark'];
const LOCALES: Locale[] = ['en', 'fr'];

for (const theme of THEMES) {
  for (const locale of LOCALES) {
    test.describe(`assert_a11y_axe_clean : ${theme}, ${locale}`, () => {
      test.use({ uiTheme: theme, uiLocale: locale });

      for (const screen of SCREENS) {
        test(screen.id, async ({ consolePage }) => {
          const { page, app, errors, open } = consolePage;
          await open(screen.path, { anonymous: screen.anonymous, routes: screen.routes });

          // L'écran est prêt quand son titre de page (h1) est affiché et que les requêtes de données sont revenues.
          await expect(page.locator('h1').first()).toBeVisible();
          await app.settled();
          await screen.prepare?.(page, app);

          const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
          const report = results.violations.map((violation) => `${violation.impact} ${violation.id} : ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).slice(0, 4).join(' | ')}`);
          expect(report, `violations axe sur ${screen.id}`).toEqual([]);
          expect(await page.evaluate(() => document.documentElement.lang)).toBe(locale);
          expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(theme === 'dark');
          expect(app.unmatched, 'requêtes sans route dans le faux serveur').toEqual([]);
          // Une réponse 4xx ou 5xx ou une coupure de flux voulue (connexion refusée, serveur en panne, flux SSE coupé) est journalisée par Chromium : seules celles-là sont tolérées.
          const unexpected = screen.expectsNetworkError ? errors.filter((entry) => !/Failed to load resource: (the server responded with a status of [45]\d\d|net::ERR_INCOMPLETE_CHUNKED_ENCODING)/.test(entry)) : errors;
          expect(unexpected, 'erreurs de la console du navigateur').toEqual([]);
        });
      }
    });
  }
}

// WCAG 1.4.10 (Reflow) : à 320 px de large, aucune page ne défile horizontalement ; seul un tableau de données peut défiler dans son
// propre conteneur. Une langue et un thème suffisent (la mise en page ne dépend ni de l'un ni de l'autre).
test.describe('reflow à 320 px de large (WCAG 1.4.10)', () => {
  test.use({ viewport: { width: 320, height: 640 }, uiLocale: 'fr', uiTheme: 'light' });

  for (const screen of SCREENS) {
    test(screen.id, async ({ consolePage }) => {
      const { page, app, open } = consolePage;
      await open(screen.path, { anonymous: screen.anonymous, routes: screen.routes });
      await expect(page.locator('h1').first()).toBeVisible();
      await app.settled();
      await screen.prepare?.(page, app);
      const overflow = await page.evaluate(() => {
        const wide = [...document.querySelectorAll<HTMLElement>('body *')]
          .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !el.closest('[data-reflow-exempt], table, pre, [role="log"]'))
          .slice(0, 5)
          .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String(el.className).slice(0, 40)}`);
        return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, wide };
      });
      expect(overflow.scrollWidth, `défilement horizontal de la page (éléments trop larges : ${overflow.wide.join(', ')})`).toBeLessThanOrEqual(overflow.clientWidth);
    });
  }
});
