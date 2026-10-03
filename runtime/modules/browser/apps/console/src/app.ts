// SPDX-License-Identifier: AGPL-3.0-only
// Assemblage de la console (tâches 3.5 et 3.6) : une `AuthApi` et une `ConsoleApi` (HTTP en production, simulation en
// développement et en test), l'état de connexion, le routeur gardé et vue-i18n. Utilisé par main.ts (navigateur) et par les tests (rendu serveur).
import { createApp, createSSRApp, type App as VueApp } from 'vue';
import type { Router, RouterHistory } from 'vue-router';
import App from './App.vue';
import type { AuthApi } from './api/auth.js';
import type { ConsoleApi } from './api/console.js';
import { AUTH_KEY, createAuthStore, type AuthStore } from './auth/store.js';
import { CONSOLE_API_KEY } from './composables/console-api.js';
import { createConsoleI18n, type Locale } from './i18n.js';
import { createConsoleRouter } from './router.js';

export type ConsoleApp = { app: VueApp; router: Router; auth: AuthStore; i18n: ReturnType<typeof createConsoleI18n> };

export function createConsoleApp(options: { api: AuthApi; consoleApi?: ConsoleApi; locale: Locale; history: RouterHistory; ssr?: boolean }): ConsoleApp {
  const auth = createAuthStore(options.api);
  const router = createConsoleRouter(auth, options.history);
  const i18n = createConsoleI18n(options.locale);
  const app = (options.ssr === true ? createSSRApp : createApp)(App);
  app.provide(AUTH_KEY, auth).use(router).use(i18n);
  if (options.consoleApi) app.provide(CONSOLE_API_KEY, options.consoleApi);
  return { app, router, auth, i18n };
}
