// SPDX-License-Identifier: AGPL-3.0-only
// Client REST typé de la console (tâche 3.5) : même origine, cookie de session envoyé par le navigateur, erreurs du contrat
// (`{ error: { code, … } }`, 04 § 6) réduites à un code stable que l'interface traduit. Jamais de phrase du serveur affichée.
import { describe, expect, test } from 'vitest';
import { createHttpClient, type FetchLike } from './client.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init = {}) => {
      const call = { url: String(url), init };
      calls.push(call);
      return respond(call);
    },
  };
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (code: string): unknown => ({ error: { code, message: 'm', retryable: false, what_to_do: 'w', requestId: 'req_1' } });

describe('createHttpClient', () => {
  test('GET : URL de base, JSON, cookie de même origine, langue de l’interface', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, { ok: 1 }));
    const http = createHttpClient({ baseUrl: 'https://symb.example', fetch, locale: () => 'fr' });
    const result = await http.request<{ ok: number }>('GET', '/v1/console/auth/status');
    expect(result).toEqual({ ok: true, status: 200, data: { ok: 1 } });
    expect(calls[0]?.url).toBe('https://symb.example/v1/console/auth/status');
    expect(calls[0]?.init.credentials).toBe('same-origin');
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('accept-language')).toBe('fr');
    expect(calls[0]?.init.body).toBeUndefined();
  });

  test('POST : corps JSON', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const http = createHttpClient({ baseUrl: '', fetch });
    const result = await http.request('POST', '/v1/console/auth/logout', { a: 1 });
    expect(result).toEqual({ ok: true, status: 204, data: undefined });
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe('{"a":1}');
    expect(new Headers(calls[0]?.init.headers).get('content-type')).toBe('application/json');
  });

  test('erreur du contrat : code stable et requestId, jamais le message du serveur', async () => {
    const { fetch } = fakeFetch(() => json(401, apiError('invalid_credentials')));
    const result = await createHttpClient({ baseUrl: '', fetch }).request('POST', '/v1/console/auth/login', {});
    expect(result).toEqual({ ok: false, status: 401, code: 'invalid_credentials', requestId: 'req_1' });
  });

  test('corps d’erreur illisible : `unexpected` ; réseau coupé : `network`', async () => {
    const broken = fakeFetch(() => new Response('<html>502</html>', { status: 502 }));
    expect(await createHttpClient({ baseUrl: '', fetch: broken.fetch }).request('GET', '/x')).toEqual({ ok: false, status: 502, code: 'unexpected' });
    const down = fakeFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await createHttpClient({ baseUrl: '', fetch: down.fetch }).request('GET', '/x')).toEqual({ ok: false, status: 0, code: 'network' });
  });

  test('401 hors des routes de connexion : session expirée signalée ; 401 de connexion : laissé à l’appelant', async () => {
    let expired = 0;
    const { fetch } = fakeFetch(() => json(401, apiError('unauthorized')));
    const http = createHttpClient({ baseUrl: '', fetch, onUnauthorized: () => (expired += 1) });
    await http.request('POST', '/v1/console/auth/login', {});
    expect(expired).toBe(0);
    await http.request('GET', '/v1/sessions');
    expect(expired).toBe(1);
  });

  test('chemin absolu exigé : pas d’URL d’un autre hôte par le chemin', async () => {
    const { fetch } = fakeFetch(() => json(200, {}));
    const http = createHttpClient({ baseUrl: '', fetch });
    await expect(http.request('GET', '//evil.example/x')).rejects.toThrow(/chemin/);
    await expect(http.request('GET', 'https://evil.example/x')).rejects.toThrow(/chemin/);
  });
});
