// SPDX-License-Identifier: AGPL-3.0-only
// Client REST typé de la console (openapi-fetch, types générés depuis l'OpenAPI spécifiée). Aucune logique métier :
// les droits sont décidés par le serveur (06 § 4.1). Une réponse 401 hors connexion signale une session expirée.
import { createApiClient, type ApiClient } from '@runtime/client';

type UnauthorizedHandler = () => void;

const handlers = new Set<UnauthorizedHandler>();
let client: ApiClient | undefined;

/** Appelle `handler` quand une requête authentifiée reçoit 401 (session expirée ou révoquée). Renvoie le désabonnement. */
export function onUnauthorized(handler: UnauthorizedHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** Construit un client ; `baseUrl` et `fetch` sont injectables pour les tests. */
export function buildApi(options: { baseUrl: string; fetch?: (request: Request) => Promise<Response> }): ApiClient {
  const api = createApiClient(options);
  api.use({
    onResponse({ response, schemaPath }) {
      // /api/me et /api/auth/* gèrent eux-mêmes leur 401 (identification, mauvais mot de passe).
      if (response.status === 401 && schemaPath !== '/api/me' && !schemaPath.startsWith('/api/auth/')) {
        for (const handler of handlers) handler();
      }
      return undefined;
    },
  });
  return api;
}

/** Client partagé de la page (même origine que la console). */
export function getApi(): ApiClient {
  client ??= buildApi({ baseUrl: window.location.origin });
  return client;
}

/** Remplace le client partagé (tests). */
export function setApi(next: ApiClient | undefined): void {
  client = next;
}
