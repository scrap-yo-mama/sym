// SPDX-License-Identifier: AGPL-3.0-only
// Routes de la console : connexion, premier démarrage (04d § 5.3) et accueil (tâche 3.5) ; les six écrans de 04d § 5.2
// (tâche 3.6) : sessions, détail d'une session, nœuds, clés et quotas, profils, consommation. Tous exigent une connexion.
import { createRouter, type RouteLocationRaw, type Router, type RouterHistory } from 'vue-router';
import type { AuthStore } from './auth/store.js';
import HomeView from './views/HomeView.vue';
import LoginView from './views/LoginView.vue';
import KeysView from './views/KeysView.vue';
import NodesView from './views/NodesView.vue';
import ProfilesView from './views/ProfilesView.vue';
import SessionDetailView from './views/SessionDetailView.vue';
import SessionsView from './views/SessionsView.vue';
import SetupView from './views/SetupView.vue';
import UsageView from './views/UsageView.vue';

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
      { path: '/sessions', name: 'sessions', component: SessionsView, meta: { titleKey: 'console.sessions.title', requiresAuth: true } },
      { path: '/sessions/:id', name: 'session', component: SessionDetailView, props: true, meta: { titleKey: 'console.session.documentTitle', requiresAuth: true } },
      { path: '/nodes', name: 'nodes', component: NodesView, meta: { titleKey: 'console.nodes.title', requiresAuth: true } },
      { path: '/keys', name: 'keys', component: KeysView, meta: { titleKey: 'console.keys.title', requiresAuth: true } },
      { path: '/profiles', name: 'profiles', component: ProfilesView, meta: { titleKey: 'console.profiles.title', requiresAuth: true } },
      { path: '/usage', name: 'usage', component: UsageView, meta: { titleKey: 'console.usage.title', requiresAuth: true } },
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
