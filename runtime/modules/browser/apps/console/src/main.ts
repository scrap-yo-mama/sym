// SPDX-License-Identifier: AGPL-3.0-only
// Point d'entrée de la console : thème SYM (jetons et polices de packages/ui, via Tailwind), thème sombre selon le
// système, langue mémorisée ou du navigateur, `AuthApi`. En production, client HTTP vers la passerelle (même origine) ;
// sous `vite` (développement), simulations de testing/mock-auth.ts et testing/mock-console.ts : les tâches 2.1 (authentification
// serveur), 2.2, 2.5, 2.6 et 3.2 (API des écrans) ne sont pas encore fusionnées. `import.meta.env.DEV` vaut `false` à la construction : la simulation n'entre pas dans dist/.
import './assets/main.css';
import { createWebHistory } from 'vue-router';
import type { AuthApi } from './api/auth.js';
import { createHttpAuthApi } from './api/auth.js';
import { createHttpClient } from './api/client.js';
import { createHttpConsoleApi, type ConsoleApi } from './api/console.js';
import { createConsoleApp, type ConsoleApp } from './app.js';
import { detectLocale } from './i18n.js';
import { applyLocale, readStoredLocale } from './locale.js';

const dark = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = (): void => {
  document.documentElement.classList.toggle('dark', dark.matches);
};
applyTheme();
dark.addEventListener('change', applyTheme);

async function start(): Promise<void> {
  const locale = detectLocale(readStoredLocale(), navigator.language);
  // Renseigné après l’assemblage : le client HTTP en a besoin pour la langue et la session expirée.
  const current: { app?: ConsoleApp } = {};
  let api: AuthApi;
  let consoleApi: ConsoleApi;
  if (import.meta.env.DEV) {
    const { createMockAuthApi } = await import('./testing/mock-auth.js');
    const { createMockConsoleApi } = await import('./testing/mock-console.js');
    const { DEV_AUTH_FIXTURE } = await import('./testing/dev-fixture.js');
    api = createMockAuthApi(DEV_AUTH_FIXTURE);
    consoleApi = createMockConsoleApi();
  } else {
    const http = createHttpClient({
      baseUrl: window.location.origin,
      locale: () => String(current.app?.i18n.global.locale.value ?? locale),
      onUnauthorized: () => current.app?.auth.markExpired(),
    });
    api = createHttpAuthApi(http);
    consoleApi = createHttpConsoleApi(http, { baseUrl: window.location.origin });
  }
  const consoleApp = createConsoleApp({ api, consoleApi, locale, history: createWebHistory() });
  current.app = consoleApp;
  applyLocale(consoleApp.i18n.global.locale, locale);
  consoleApp.app.mount('#app');
}

void start();
