// SPDX-License-Identifier: AGPL-3.0-only
// Fixtures Playwright Test de la console (tâche 3.9) : une console construite et servie par worker, et une page ouverte dans
// la langue et le thème demandés (`uiLocale`, `uiTheme` en options de test), avec le relevé des erreurs de la console du navigateur.
import { test as base, expect, type Page } from '@playwright/test';
import { anonymousRoutes, dataRoutes, signedInRoutes } from './fixtures.ts';
import { startConsole, type ApiRoutes, type ConsoleApp } from './harness.ts';

export type Locale = 'en' | 'fr';
export type Theme = 'light' | 'dark';

// `locale` est déjà une option de Playwright (langue du navigateur) : les options de la console portent un préfixe.
type Options = { uiLocale: Locale; uiTheme: Theme };
type Fixtures = {
  /** Page ouverte sur la console ; `open` pose les routes de l'API (session ouverte, sauf `anonymous`) puis charge le chemin. */
  consolePage: { page: Page; app: ConsoleApp; errors: string[]; open: (path: string, options?: { anonymous?: boolean; routes?: ApiRoutes }) => Promise<void> };
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
  consolePage: async ({ page, app, uiLocale, uiTheme }, use) => {
    const errors = watchConsole(page);
    await seedPreferences(page, uiLocale, uiTheme);
    await use({
      page,
      app,
      errors,
      open: async (path, options = {}) => {
        app.setRoutes(options.anonymous ? anonymousRoutes : { ...signedInRoutes(uiLocale, uiTheme), ...dataRoutes(), ...options.routes });
        await page.goto(`${app.url}${path}`);
      },
    });
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
