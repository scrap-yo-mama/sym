// SPDX-License-Identifier: AGPL-3.0-only
// Critère de 3.3 « connexion puis page vide authentifiée », rejouable : vrai serveur (Fastify, Better Auth, PostgreSQL
// migré), client généré de la console, composable de session et garde du routeur. Le navigateur n'est pas requis : un
// `fetch` relaie les requêtes du client vers `app.inject` et tient le cookie de session comme le ferait le navigateur
// (cookie HttpOnly jamais lu par la console). Le parcours en navigateur réel est repris par la suite E2E (3.6).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createMemoryHistory } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { ensureSession, resetSession, signIn, signOut, useSession } from '@/composables/useSession';
import en from '@/i18n/locales/en.json';
import { buildApi, setApi } from '@/lib/api';
import { createAppRouter } from '@/router/index';
import HomeView from '@/views/HomeView.vue';
import { PUBLIC_URL, runSetup, startTestServer, type TestServer, type TestUser } from '../../../tests/helpers/server.js';

/** Cookies posés par le serveur, renvoyés à chaque requête (même origine). */
class CookieJar {
  #cookies = new Map<string, string>();

  header(): string | undefined {
    return this.#cookies.size === 0 ? undefined : [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  store(cookies: { name: string; value: string; maxAge?: number; expires?: Date }[]): void {
    for (const cookie of cookies) {
      const expired = cookie.value === '' || (cookie.maxAge !== undefined && cookie.maxAge <= 0) || (cookie.expires !== undefined && cookie.expires.getTime() <= Date.now());
      if (expired) this.#cookies.delete(cookie.name);
      else this.#cookies.set(cookie.name, cookie.value);
    }
  }

  has(suffix: string): boolean {
    return [...this.#cookies.keys()].some((name) => name.endsWith(suffix));
  }
}

/** `fetch` du client → `app.inject`, avec l'en-tête `Origin` qu'un navigateur ajoute aux requêtes de mutation. */
function injectFetch(srv: TestServer, jar: CookieJar): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const headers: Record<string, string> = Object.fromEntries(request.headers);
    const cookie = jar.header();
    if (cookie) headers.cookie = cookie;
    if (request.method !== 'GET' && request.method !== 'HEAD') headers.origin = PUBLIC_URL;
    const payload = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
    const res = await srv.app.inject({ method: request.method as 'GET', url: url.pathname + url.search, headers, payload });
    jar.store(res.cookies);
    const outHeaders = new Headers();
    for (const [name, value] of Object.entries(res.headers)) {
      if (name === 'set-cookie' || value === undefined) continue;
      outHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value));
    }
    const body = res.statusCode === 204 || res.statusCode === 304 ? null : new Uint8Array(res.rawPayload);
    return new Response(body, { status: res.statusCode, headers: outHeaders });
  };
}

describe('console : connexion puis page vide authentifiée (3.3)', () => {
  let srv: TestServer;
  let owner: TestUser;
  const jar = new CookieJar();

  beforeAll(async () => {
    srv = await startTestServer('console');
    owner = await runSetup(srv);
    resetSession();
    setApi(buildApi({ baseUrl: PUBLIC_URL, fetch: injectFetch(srv, jar) }));
  });

  afterAll(async () => {
    setApi(undefined);
    resetSession();
    await srv?.close();
  });

  test('assert_console_login_then_empty_authenticated_page : garde, mauvais mot de passe, connexion, /api/me, page vide, déconnexion', async () => {
    const router = createAppRouter(createMemoryHistory());

    // Anonyme : la page vide renvoie vers la connexion, sans aucun 401 (sonde get-session = 200 null).
    await router.push('/');
    expect(router.currentRoute.value.name).toBe('login');
    expect(useSession().state.value).toBe('anonymous');

    // Mauvais mot de passe : refus uniforme, aucune session.
    expect(await signIn(owner.email, 'zz_test_wrong_password_value')).toEqual({ ok: false, failure: 'invalid_credentials' });
    expect(jar.has('sy.session')).toBe(false);

    // Connexion : cookie de session posé, identité relue par GET /api/me.
    expect(await signIn(owner.email, owner.password)).toEqual({ ok: true });
    expect(jar.has('sy.session')).toBe(true);
    const session = useSession();
    expect(session.state.value).toBe('authenticated');
    expect(session.me.value).toMatchObject({ id: owner.id, email: owner.email, role: 'owner', via: 'ui', scopes: null });

    // Page vide authentifiée ; la page de connexion renvoie vers l'accueil.
    await router.push('/');
    expect(router.currentRoute.value.name).toBe('home');
    await router.push('/login');
    expect(router.currentRoute.value.name).toBe('home');
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });
    const html = await renderToString(createSSRApp({ render: () => h(HomeView) }).use(i18n));
    expect(html).toContain(en.home.title);
    expect(html).toContain(en.home.empty);

    // Une nouvelle ouverture de la console (état oublié) retrouve la session par le seul cookie.
    resetSession();
    expect(await ensureSession()).toBe('authenticated');

    // Déconnexion : session fermée côté serveur, la garde renvoie vers la connexion.
    await signOut();
    resetSession();
    expect(await ensureSession()).toBe('anonymous');
    await router.push('/login');
    await router.push('/');
    expect(router.currentRoute.value.name).toBe('login');
  });
});
