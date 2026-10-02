// SPDX-License-Identifier: AGPL-3.0-only
// Point d'entrée de la console : thème SYM (jetons et polices de packages/ui, via Tailwind), thème sombre selon le
// système, langue mémorisée ou du navigateur, `AuthApi`. En production, client HTTP vers la passerelle (même origine) ;
// sous `vite` (développement), simulation de testing/mock-auth.ts : la tâche 2.1 (authentification serveur) n'est pas
// encore fusionnée. `import.meta.env.DEV` vaut `false` à la construction : la simulation n'entre pas dans dist/.
import './assets/main.css';
import { createWebHistory } from 'vue-router';
import type { AuthApi } from './api/auth.js';
import { createHttpAuthApi } from './api/auth.js';
import { createHttpClient } from './api/client.js';
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
  if (import.meta.env.DEV) {
    const { createMockAuthApi } = await import('./testing/mock-auth.js');
    const { DEV_AUTH_FIXTURE } = await import('./testing/dev-fixture.js');
    api = createMockAuthApi(DEV_AUTH_FIXTURE);
  } else {
    const http = createHttpClient({
      baseUrl: window.location.origin,
      locale: () => String(current.app?.i18n.global.locale.value ?? locale),
      onUnauthorized: () => current.app?.auth.markExpired(),
    });
    api = createHttpAuthApi(http);
  }
  const consoleApp = createConsoleApp({ api, locale, history: createWebHistory() });
  current.app = consoleApp;
  applyLocale(consoleApp.i18n.global.locale, locale);
  consoleApp.app.mount('#app');
}

void start();
