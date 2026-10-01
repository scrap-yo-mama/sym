// SPDX-License-Identifier: AGPL-3.0-only
// Routes de la console et garde de session. Chaque changement de route déplace le focus sur le <h1> de la page
// (06 § 1) ; le titre du document est traduit dans App.vue (`meta.titleKey`).
import { nextTick } from 'vue';
import { createRouter, createWebHistory, START_LOCATION, type Router, type RouterHistory } from 'vue-router';
import { ensureSession } from '@/composables/useSession';

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
      { path: '/', name: 'home', component: () => import('@/views/HomeView.vue'), meta: { titleKey: 'home.title' } },
      // Nouvelle API (3.5) : `/apis/new` est le formulaire, `/apis/new/:runId` rouvre une enquête (journal rejoué).
      { path: '/apis/new', name: 'new-api', component: () => import('@/views/NewApiView.vue'), meta: { titleKey: 'newApi.title' } },
      { path: '/apis/new/:runId', name: 'new-api-run', component: () => import('@/views/NewApiView.vue'), meta: { titleKey: 'investigation.titleUnknown' } },
      { path: '/runs', name: 'runs', component: () => import('@/views/RunsView.vue'), meta: { titleKey: 'runs.title' } },
      {
        path: '/settings',
        component: () => import('@/views/settings/SettingsView.vue'),
        meta: { titleKey: 'settings.title' },
        children: [
          { path: '', redirect: { name: 'settings-models' }, meta: { titleKey: 'settings.title' } },
          { path: 'models', name: 'settings-models', component: () => import('@/views/settings/ModelsSettingsView.vue'), meta: { titleKey: 'settings.models.title' } },
          { path: 'proxies', name: 'settings-proxies', component: () => import('@/views/settings/ProxiesSettingsView.vue'), meta: { titleKey: 'settings.proxies.title' } },
          { path: 'extension', name: 'settings-extension', component: () => import('@/views/settings/ExtensionSettingsView.vue'), meta: { titleKey: 'settings.extension.title' } },
          { path: 'alerts', name: 'settings-alerts', component: () => import('@/views/settings/AlertsSettingsView.vue'), meta: { titleKey: 'settings.alerts.title' } },
          { path: 'diagnostic', name: 'settings-diagnostic', component: () => import('@/views/settings/DiagnosticSettingsView.vue'), meta: { titleKey: 'settings.diagnostic.title' } },
        ],
      },
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
