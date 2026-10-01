// SPDX-License-Identifier: AGPL-3.0-only
// Relais d'un navigateur sans navigateur (tests d'intégration de la console) : le `fetch` du client généré est branché sur
// `app.inject` du vrai serveur, avec le pot de cookies d'un navigateur (le cookie de session HttpOnly n'est jamais lu par la
// console) et l'en-tête `Origin` que le navigateur ajoute aux requêtes de mutation.
import { PUBLIC_URL, type TestServer } from '../../../../tests/helpers/server.js';

/** Cookies posés par le serveur, renvoyés à chaque requête (même origine). */
export class CookieJar {
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
export function injectFetch(srv: TestServer, jar: CookieJar, remoteAddress?: string): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const headers: Record<string, string> = Object.fromEntries(request.headers);
    const cookie = jar.header();
    if (cookie) headers.cookie = cookie;
    if (request.method !== 'GET' && request.method !== 'HEAD') headers.origin = PUBLIC_URL;
    const payload = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
    const res = await srv.app.inject({ method: request.method as 'GET', url: url.pathname + url.search, headers, payload, ...(remoteAddress ? { remoteAddress } : {}) });
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

