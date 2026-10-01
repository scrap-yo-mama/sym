// SPDX-License-Identifier: AGPL-3.0-only
// Routes de la console et garde de session. Chaque changement de route déplace le focus sur le <h1> de la page
// (06 § 1) ; le titre du document est traduit dans App.vue (`meta.titleKey`).
import { nextTick } from 'vue';
import { createRouter, createWebHistory, START_LOCATION, type Router, type RouterHistory } from 'vue-router';
import { ensureSession } from '@/composables/useSession';
import { API_TABS } from '@/lib/api-tabs';

declare module 'vue-router' {
  interface RouteMeta {
    /** Page joignable sans session (connexion). Une session ouverte la renvoie vers l'accueil. */
    public?: boolean;
    /** Clé i18n du titre du document. */
    titleKey: string;
  }
}

/** Destination après connexion : un chemin interne seulement (jamais `//hôte`, `/\hôte` ni une URL absolue). */
export function safeRedirect(value: unknown): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== 'string' || !candidate.startsWith('/') || candidate.startsWith('//') || candidate.startsWith('/\\')) return '/';
  if ([...candidate].some((char) => char.charCodeAt(0) < 0x20)) return '/';
  return candidate;
}

/** Place le focus sur le <h1> de la page courante (annonce le changement de page aux lecteurs d'écran). */
export function focusRouteHeading(root: Pick<ParentNode, 'querySelector'> | undefined = typeof document === 'undefined' ? undefined : document): void {
  root?.querySelector<HTMLElement>('h1[data-route-heading]')?.focus();
}

export function createAppRouter(history: RouterHistory = createWebHistory()): Router {
  const router = createRouter({
    history,
    routes: [
      { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { public: true, titleKey: 'auth.login.title' } },
      { path: '/apis', name: 'catalog', component: () => import('@/views/ApiCatalogView.vue'), meta: { titleKey: 'catalog.title' } },
      // Les routes statiques de /apis/… (par exemple /apis/new, tâche 3.5) l'emportent sur ce paramètre.
      { path: `/apis/:slug/:tab(${API_TABS.join('|')})?`, name: 'api', component: () => import('@/views/ApiDetailView.vue'), meta: { titleKey: 'detail.title' } },
      { path: '/', name: 'home', component: () => import('@/views/HomeView.vue'), meta: { titleKey: 'home.title' } },
      { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('@/views/NotFoundView.vue'), meta: { titleKey: 'notFound.title' } },
    ],
  });

  router.beforeEach(async (to) => {
    const state = await ensureSession();
    if (to.name === 'not-found') return true;
    if (to.meta.public) return state === 'authenticated' ? { name: 'home' } : true;
    if (state === 'authenticated') return true;
    return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } };
  });

  // Pas de déplacement du focus au premier affichage de la page : le lien d'évitement reste le premier arrêt de Tab.
  router.afterEach((_to, from, failure) => {
    if (!failure && from !== START_LOCATION) void nextTick(() => focusRouteHeading());
  });
  return router;
}
