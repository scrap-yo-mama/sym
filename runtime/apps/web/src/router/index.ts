// SPDX-License-Identifier: AGPL-3.0-only
// Routes de la console et garde de session. Chaque changement de route déplace le focus sur le <h1> de la page
// (06 § 1) ; le titre du document est traduit dans App.vue (`meta.titleKey`).
import { nextTick } from 'vue';
import { createRouter, createWebHistory, START_LOCATION, type Router, type RouterHistory } from 'vue-router';
import { can, ensureSession, useSession, type Permission } from '@/composables/useSession';
import { API_TABS } from '@/lib/api-tabs';

declare module 'vue-router' {
  interface RouteMeta {
    /** Page joignable sans session (connexion). Une session ouverte la renvoie vers l'accueil. */
    public?: boolean;
    /** Page joignable avec ou sans session (invitation, réinitialisation du mot de passe : le lien décide, pas la session). */
    open?: boolean;
    /** Permission exigée (`can()`, 13 § 2) : sans elle, la route redirige vers l'accueil. Le serveur reste seul juge. */
    permission?: Permission;
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
      // Comptes (3.8). `/setup` n'existe que tant qu'aucun owner n'est créé : ensuite la garde le rend introuvable (13 § 4).
      { path: '/setup', name: 'setup', component: () => import('@/views/SetupView.vue'), meta: { open: true, titleKey: 'setup.title' } },
      { path: '/invite/:token', name: 'invite', component: () => import('@/views/InviteView.vue'), meta: { open: true, titleKey: 'auth.invite.title' } },
      { path: '/forgot-password', name: 'forgot-password', component: () => import('@/views/ForgotPasswordView.vue'), meta: { public: true, titleKey: 'auth.forgot.title' } },
      { path: '/reset-password/:token', name: 'reset-password', component: () => import('@/views/ResetPasswordView.vue'), meta: { open: true, titleKey: 'auth.reset.title' } },
      { path: '/two-factor-setup', name: 'two-factor-setup', component: () => import('@/views/TwoFactorSetupView.vue'), meta: { titleKey: 'twoFactorSetup.title' } },
      { path: '/admin/users', name: 'admin-users', component: () => import('@/views/admin/UsersView.vue'), meta: { permission: 'users:list', titleKey: 'users.title' } },
      { path: '/admin/audit', name: 'admin-audit', component: () => import('@/views/admin/AuditView.vue'), meta: { permission: 'audit:read', titleKey: 'audit.title' } },
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
          { path: 'keys', name: 'settings-keys', component: () => import('@/views/settings/ApiKeysView.vue'), meta: { titleKey: 'keys.title' } },
          // `/settings/account` : adresse de retour de la liaison SSO (`?sso=linked`), figée côté serveur.
          { path: 'account', name: 'settings-account', component: () => import('@/views/settings/AccountView.vue'), meta: { titleKey: 'account.title' } },
          { path: 'security', name: 'settings-security', component: () => import('@/views/settings/SecuritySettingsView.vue'), meta: { permission: 'settings:security:write', titleKey: 'instance.security.title' } },
          { path: 'robot', name: 'settings-robot', component: () => import('@/views/settings/RobotIdentitySettingsView.vue'), meta: { permission: 'settings:identity:write', titleKey: 'instance.identity.title' } },
          { path: 'sso', name: 'settings-sso', component: () => import('@/views/settings/SsoSettingsView.vue'), meta: { permission: 'settings:sso:write', titleKey: 'instance.sso.title' } },
        ],
      },
      { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('@/views/NotFoundView.vue'), meta: { titleKey: 'notFound.title' } },
    ],
  });

  router.beforeEach(async (to) => {
    const state = await ensureSession();
    if (to.name === 'not-found') return true;
    // Instance sans owner : l'assistant est la seule page (13 § 4) ; une fois l'owner créé, `/setup` répond « introuvable » pour toujours.
    if (state === 'not_initialized') return to.name === 'setup' ? true : { name: 'setup' };
    if (to.name === 'setup') return { name: 'not-found', params: { pathMatch: ['setup'] } };
    if (to.meta.open) return true;
    if (to.meta.public) return state === 'authenticated' ? { name: 'home' } : true;
    // Mot de passe vérifié, second facteur attendu : la connexion montre la saisie du code et rien d'autre n'est joignable.
    if (state === 'mfa_pending') return { name: 'login', query: { mfa: '1' } };
    if (state !== 'authenticated') return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } };
    // MFA_ENFORCED : l'enrôlement précède toute autre route (13 § 7).
    if (useSession().mustEnrollTwoFactor.value) return to.name === 'two-factor-setup' ? true : { name: 'two-factor-setup' };
    if (to.name === 'two-factor-setup') return { name: 'settings-account' };
    // Écrans réservés (Utilisateurs, Audit, Sécurité, SSO) : sans la permission, la route redirige (pilotage par can()).
    if (to.meta.permission && !can(to.meta.permission)) return { name: 'home' };
    return true;
  });

  // Pas de déplacement du focus au premier affichage de la page : le lien d'évitement reste le premier arrêt de Tab.
  router.afterEach((_to, from, failure) => {
    if (!failure && from !== START_LOCATION) void nextTick(() => focusRouteHeadingWhenReady());
  });
  return router;
}
