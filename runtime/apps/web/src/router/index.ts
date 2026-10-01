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

type HeadingRoot = Pick<Document, 'querySelector' | 'activeElement' | 'body'>;
type HeadingDeps = {
  /** Appelle `onChange` à chaque changement du DOM de la page ; renvoie l'arrêt de l'observation. */
  observe: (onChange: () => void) => () => void;
  /** Appelle `callback` après `ms` millisecondes ; renvoie l'annulation. */
  schedule: (callback: () => void, ms: number) => () => void;
};

const browserHeadingDeps: HeadingDeps = {
  observe: (onChange) => {
    const observer = new MutationObserver(onChange);
    observer.observe(document.getElementById('main') ?? document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  },
  schedule: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

/** Attente maximale du <h1> d'une page qui charge ses données avant de renoncer à lui donner le focus. */
const HEADING_WAIT_MS = 5000;
let cancelPendingHeading: (() => void) | undefined;

/**
 * Focus sur le <h1> de la route, même s'il n'existe pas encore : une page qui charge ses données (fiche d'une API) montre
 * d'abord un squelette sans titre. Le <h1> prend le focus à son apparition, sauf si la personne a déjà mis le focus ailleurs
 * (champ, bouton) ; l'attente s'arrête après 5 s et à la navigation suivante (06 § 1, WCAG 2.4.3).
 */
export function focusRouteHeadingWhenReady(root: HeadingRoot | undefined = typeof document === 'undefined' ? undefined : document, deps: HeadingDeps = browserHeadingDeps): void {
  cancelPendingHeading?.();
  cancelPendingHeading = undefined;
  if (!root) return;
  const heading = (): HTMLElement | null => root.querySelector<HTMLElement>('h1[data-route-heading]');
  const present = heading();
  if (present) {
    present.focus();
    return;
  }
  let waiting = true;
  const stopObserving = deps.observe(() => {
    const found = waiting ? heading() : null;
    if (!found) return;
    const active = root.activeElement;
    if (!active || active === root.body || active.id === 'main') found.focus();
    cancelPendingHeading?.();
    cancelPendingHeading = undefined;
  });
  const cancelTimer = deps.schedule(() => {
    stopObserving();
    cancelPendingHeading = undefined;
  }, HEADING_WAIT_MS);
  cancelPendingHeading = () => {
    waiting = false;
    stopObserving();
    cancelTimer();
  };
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
    if (!failure && from !== START_LOCATION) void nextTick(() => focusRouteHeadingWhenReady());
  });
  return router;
}
