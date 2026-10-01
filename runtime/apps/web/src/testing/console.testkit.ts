// SPDX-License-Identifier: AGPL-3.0-only
// Outillage des tests de la console (sans navigateur) : faux serveur REST injecté dans le client généré, rendu SSR d'un
// composant avec vue-i18n et un routeur en mémoire. Aucun réseau réel, aucun site réel.
import { createSSRApp, h, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createI18n } from 'vue-i18n';
import { createMemoryHistory, createRouter } from 'vue-router';
import en from '@runtime/i18n/locales/en.json';
import fr from '@runtime/i18n/locales/fr.json';
import { buildApi, setApi } from '@/lib/api';
import { ensureSession, resetSession } from '@/composables/useSession';
import { ROLE_PERMISSIONS } from '@/testing/permissions';

export const json = (status: number, body: unknown): Response =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export interface RecordedCall {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

type Handler = (call: RecordedCall) => Response | Promise<Response>;

/** Faux serveur : une entrée « MÉTHODE /chemin » par route ; une route inconnue répond 404 `not_found`. */
export function installFakeServer(routes: Record<string, Handler>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  setApi(
    buildApi({
      baseUrl: 'http://console.test',
      fetch: async (request) => {
        const url = new URL(request.url);
        const text = request.method === 'GET' ? '' : await request.text();
        const call: RecordedCall = { method: request.method, path: url.pathname, search: url.search, body: text ? (JSON.parse(text) as unknown) : null };
        calls.push(call);
        const handler = routes[`${request.method} ${url.pathname}`];
        return handler ? handler(call) : json(404, { error: { code: 'not_found', message: 'x' } });
      },
    }),
  );
  return calls;
}

export const ME = {
  id: '3f2b6c1e-0000-4000-8000-000000000001',
  email: 'ada@x.test',
  displayName: 'Ada',
  role: 'owner',
  locale: 'en',
  timezone: 'Europe/Paris',
  theme: 'system',
  via: 'ui',
  scopes: null,
  permissions: ROLE_PERMISSIONS.owner,
  mfaEnabled: false,
  mfaRequired: false,
  mfaEnrollmentRequired: false,
};

/** Routes d'identité : une session ouverte pour `ME`. */
export const sessionRoutes: Record<string, Handler> = {
  'GET /api/auth/get-session': () => json(200, { session: { id: 's' }, user: { id: ME.id, email: ME.email } }),
  'GET /api/me': () => json(200, ME),
};

/** Ouvre la session du faux serveur (la console lit `useSession().me`). */
export async function signedIn(): Promise<void> {
  resetSession();
  await ensureSession();
}

export type Locale = string;

/** Rend un composant en HTML (SSR) avec ses traductions et un routeur en mémoire placé sur `path`. */
async function render(component: Component, props: Record<string, unknown> = {}, options: { locale?: Locale; path?: string } = {}): Promise<string> {
  const i18n = createI18n({ legacy: false, locale: options.locale ?? 'en', fallbackLocale: 'en', messages: { en, fr } });
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:rest(.*)*', component: { render: () => null } }] });
  await router.push(options.path ?? '/');
  await router.isReady();
  return renderToString(createSSRApp({ render: () => h(component, props) }).use(i18n).use(router));
}

export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Échappement HTML de `renderToString` (pour comparer un texte traduit au HTML rendu). */
export const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** HTML sans les commentaires de fragments que Vue insère dans le rendu SSR. */
const strip = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, '');

/** `render` suivi de `strip` : le texte visible se compare sans marqueurs de fragments. */
export async function view(component: Component, props: Record<string, unknown> = {}, options: { locale?: Locale; path?: string } = {}): Promise<string> {
  return strip(await render(component, props, options));
}
