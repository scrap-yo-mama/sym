// SPDX-License-Identifier: AGPL-3.0-only
// Routes de la console (tâche 3.5 : fondations). Les écrans de 04d § 5.2 (sessions, nœuds, clés, profils, consommation)
// arrivent avec la tâche 3.6 ; ici : connexion, premier démarrage (04d § 5.3) et accueil connecté.
import { createRouter, type RouteLocationRaw, type Router, type RouterHistory } from 'vue-router';
import type { AuthStore } from './auth/store.js';
import HomeView from './views/HomeView.vue';
import LoginView from './views/LoginView.vue';
import SetupView from './views/SetupView.vue';

declare module 'vue-router' {
  interface RouteMeta {
    /** Clé i18n du titre de la page (`document.title`). */
    titleKey: string;
    requiresAuth?: boolean;
  }
}

/** Retour après connexion : chemin interne seulement (jamais `//hôte`, `/\hôte` ni une URL), jamais /login ou /setup. */
export function safeRedirect(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  if (/^\/(login|setup)(?:[/?#]|$)/.test(value)) return '/';
  return value;
}

export function createConsoleRouter(auth: AuthStore, history: RouterHistory): Router {
  const router = createRouter({
    history,
    routes: [
      { path: '/', name: 'home', component: HomeView, meta: { titleKey: 'console.home.title', requiresAuth: true } },
      { path: '/login', name: 'login', component: LoginView, meta: { titleKey: 'console.login.title' } },
      { path: '/setup', name: 'setup', component: SetupView, meta: { titleKey: 'console.setup.title' } },
      { path: '/:pathMatch(.*)*', redirect: '/' },
    ],
  });

  router.beforeEach(async (to): Promise<RouteLocationRaw | boolean> => {
    await auth.ensureLoaded();
    const state = auth.state.value;
    if (state === 'not_initialized') return to.name === 'setup' ? true : { name: 'setup' };
    if (to.name === 'setup') return state === 'authenticated' ? { name: 'home' } : { name: 'login' };
    if (state === 'authenticated') return to.name === 'login' ? safeRedirect(to.query.redirect) : true;
    if (to.meta.requiresAuth) return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } };
    return true;
  });

  return router;
}
