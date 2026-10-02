// SPDX-License-Identifier: AGPL-3.0-only
// Faux serveur de la console (tâche 3.5) : expose une `AuthApi` (la simulation) sur les routes HTTP prévues pour la tâche
// 2.1 (`AUTH_ROUTES`), avec les statuts et la forme d'erreur du contrat (`{ error: { code, message, retryable, what_to_do,
// requestId } }`, 04 § 6). Fonction `Request → Response` : branchée telle quelle sur `fetch` (tests unitaires) ou derrière
// un serveur HTTP local (e2e/harness.ts). Elle fixe ce que la passerelle de 2.1 devra répondre.
import type { ApiResult } from '../api/client.js';
import { AUTH_ROUTES, type AuthApi } from '../api/auth.js';

type Handler = (body: Record<string, unknown>) => Promise<ApiResult<unknown>>;

const errorResponse = (status: number, code: string, requestId = 'req_fake'): Response =>
  Response.json(
    { error: { code, message: code, retryable: status === 429 || status >= 500, what_to_do: code, requestId } },
    { status, headers: status === 429 ? { 'retry-after': '60' } : {} },
  );

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function createFakeConsoleServer(api: AuthApi): (request: Request) => Promise<Response> {
  const routes: Record<string, Handler> = {
    [`GET ${AUTH_ROUTES.status}`]: () => api.status(),
    [`POST ${AUTH_ROUTES.login}`]: (b) => api.login({ email: text(b.email), password: text(b.password) }),
    [`POST ${AUTH_ROUTES.totp}`]: (b) => api.verifyTotp({ code: text(b.code) }),
    [`POST ${AUTH_ROUTES.logout}`]: () => api.logout(),
    [`POST ${AUTH_ROUTES.setup}`]: (b) => api.setup({ token: text(b.token), email: text(b.email), password: text(b.password) }),
  };

  return async (request) => {
    const { pathname } = new URL(request.url);
    const handler = routes[`${request.method} ${pathname}`];
    if (!handler) return errorResponse(404, 'not_found');
    let body: Record<string, unknown> = {};
    if (request.method !== 'GET') {
      const raw = await request.text();
      try {
        const parsed: unknown = raw === '' ? {} : JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return errorResponse(400, 'invalid_option');
        body = parsed as Record<string, unknown>;
      } catch {
        return errorResponse(400, 'invalid_option');
      }
    }
    const result = await handler(body);
    if (!result.ok) return errorResponse(result.status, result.code, result.requestId);
    return result.status === 204 || result.data === undefined ? new Response(null, { status: result.status }) : Response.json(result.data, { status: result.status });
  };
}
