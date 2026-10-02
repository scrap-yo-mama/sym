// SPDX-License-Identifier: AGPL-3.0-only
// Fixtures Playwright Test de la console (tâche 3.9) : une console construite et servie par worker, et une page ouverte dans
// la langue et le thème demandés (`uiLocale`, `uiTheme` en options de test), avec le relevé des erreurs de la console du navigateur.
// Tâche 3.15 (assert_no_csp_violation) : la console est servie avec sa CSP stricte (csp.ts, posée par harness.ts) ; chaque événement
// `securitypolicyviolation` du contexte de la page est relevé (csp.ts), et le test échoue s'il y en a eu au moins un, quel que soit le test.
import { test as base, expect, type Page } from '@playwright/test';
import { watchCspViolations } from './csp.ts';
import { anonymousRoutes, dataRoutes, signedInRoutes } from './fixtures.ts';
import { startConsole, type ApiRoutes, type ConsoleApp } from './harness.ts';
import { routePseudoLocale } from './pseudo.ts';

export type Locale = 'en' | 'fr';
export type Theme = 'light' | 'dark';
/** Langue de l'interface du test ; `pseudo` : catalogue anglais pseudo-localisé (projet `ui-pseudo`, e2e/pseudo.ts). */
export type UiLocale = Locale | 'pseudo';

// `locale` est déjà une option de Playwright (langue du navigateur) : les options de la console portent un préfixe.
type Options = { uiLocale: UiLocale; uiTheme: Theme };
type Fixtures = {
  /** Page ouverte sur la console ; `open` pose les routes de l'API (session ouverte, sauf `anonymous`) puis charge le chemin. */
  consolePage: { page: Page; app: ConsoleApp; errors: string[]; cspViolations: string[]; open: (path: string, options?: { anonymous?: boolean; routes?: ApiRoutes | ((locale: Locale, theme: Theme) => ApiRoutes) }) => Promise<void> };
};
type WorkerFixtures = { app: ConsoleApp };

export const test = base.extend<Fixtures & Options, WorkerFixtures>({
  uiLocale: ['en', { option: true }],
  uiTheme: ['light', { option: true }],
  app: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const app = await startConsole();
      await use(app);
      await app.close();
    },
    { scope: 'worker', timeout: 180_000 },
  ],
  consolePage: async ({ page, app, uiLocale: ui, uiTheme }, use) => {
    // La pseudo-locale remplace le catalogue anglais : le compte et la page sont en `en`.
    const uiLocale: Locale = ui === 'pseudo' ? 'en' : ui;
    if (ui === 'pseudo') await routePseudoLocale(page);
    const errors = watchConsole(page);
    const cspViolations = await watchCspViolations(page.context());
    await seedPreferences(page, uiLocale, uiTheme);
    await use({
      page,
      app,
      errors,
      cspViolations,
      open: async (path, options = {}) => {
        const own = typeof options.routes === 'function' ? options.routes(uiLocale, uiTheme) : options.routes;
        app.setRoutes(options.anonymous ? { ...anonymousRoutes, ...own } : { ...signedInRoutes(uiLocale, uiTheme), ...dataRoutes(), ...own });
        await page.goto(`${app.url}${path}`);
      },
    });
    expect(cspViolations, 'violations de la CSP de la console (assert_no_csp_violation)').toEqual([]);
  },
});

export { expect };

/** Choix mémorisés avant le premier rendu : thème (classe `dark`) et langue de `<html>` posés par /theme-init.js. */
async function seedPreferences(page: Page, locale: Locale, theme: Theme): Promise<void> {
  await page.addInitScript(
    ([l, t]) => {
      localStorage.setItem('runtime.locale', l);
      localStorage.setItem('runtime.theme', t);
    },
    [locale, theme] as const,
  );
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
}

/** Erreurs de la console du navigateur et exceptions de la page (06 § 4.3 : aucune sur un parcours normal). */
function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`);
  });
  page.on('pageerror', (error) => errors.push(`exception : ${error.message}`));
  return errors;
}
