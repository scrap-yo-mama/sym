// SPDX-License-Identifier: AGPL-3.0-only
// Client REST typé de la console (tâche 3.5). La console est servie par la passerelle (même origine, 04d § 5) : le cookie
// de session `__Host-` (03 § 7) est envoyé par le navigateur, jamais lu ni écrit ici. Une erreur du contrat
// (`ApiError`, 04 § 6) est réduite à son code stable : l'interface le traduit, elle n'affiche jamais la phrase du serveur.
import type { ApiError } from '@sym/contracts/browser';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Codes produits par le client lui-même : réseau coupé, réponse illisible. */
export type TransportCode = 'network' | 'unexpected';

type ApiSuccess<T> = { ok: true; status: number; data: T };
export type ApiFailure<C extends string> = { ok: false; status: number; code: C | TransportCode; requestId?: string };
export type ApiResult<T, C extends string = string> = ApiSuccess<T> | ApiFailure<C>;

export type HttpClient = {
  request<T, C extends string = string>(method: HttpMethod, path: string, body?: unknown): Promise<ApiResult<T, C>>;
};

export type HttpClientOptions = {
  /** Origine de la passerelle ; `''` ou `window.location.origin` en production (même origine). */
  baseUrl: string;
  fetch?: FetchLike;
  /** Langue de l'interface, transmise en `Accept-Language` (le `what_to_do` du serveur suit la même langue). */
  locale?: () => string;
  /** Appelé sur un 401 hors des routes de connexion : session expirée ou révoquée. */
  onUnauthorized?: () => void;
};

/** Routes qui gèrent elles-mêmes leur 401 (mauvais mot de passe, mauvais jeton) : pas de « session expirée ». */
const AUTH_PREFIXES = ['/v1/console/auth/', '/v1/console/setup'];

/** Forme des erreurs du contrat ; les codes propres à la console (connexion, premier démarrage) en étendent la liste. */
type ErrorBody = { error: Omit<ApiError['error'], 'code'> & { code: string } };

function errorOf(body: unknown): { code: string; requestId?: string } | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
  const error = (body as ErrorBody).error as Partial<ErrorBody['error']> | null;
  if (typeof error?.code !== 'string' || !/^[a-z0-9_]{1,64}$/.test(error.code)) return undefined;
  return typeof error.requestId === 'string' ? { code: error.code, requestId: error.requestId } : { code: error.code };
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  return {
    async request<T, C extends string = string>(method: HttpMethod, path: string, body?: unknown): Promise<ApiResult<T, C>> {
      // Chemin absolu de la passerelle seulement : jamais une URL complète ni `//hôte` (autre origine).
      if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new Error(`chemin d'API invalide : ${path}`);
      const headers = new Headers({ accept: 'application/json' });
      const locale = options.locale?.();
      if (locale) headers.set('accept-language', locale);
      if (body !== undefined) headers.set('content-type', 'application/json');
      let response: Response;
      try {
        response = await doFetch(`${options.baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: 'same-origin',
          redirect: 'error',
        });
      } catch {
        return { ok: false, status: 0, code: 'network' };
      }
      const text = await response.text().catch(() => '');
      let parsed: unknown;
      try {
        parsed = text === '' ? undefined : JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (response.ok) return { ok: true, status: response.status, data: parsed as T };
      if (response.status === 401 && !AUTH_PREFIXES.some((prefix) => path.startsWith(prefix))) options.onUnauthorized?.();
      const error = errorOf(parsed);
      if (!error) return { ok: false, status: response.status, code: 'unexpected' };
      return { ok: false, status: response.status, code: error.code as C, ...(error.requestId ? { requestId: error.requestId } : {}) };
    },
  };
}
