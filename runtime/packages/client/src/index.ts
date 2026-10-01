// SPDX-License-Identifier: MIT
// Client TypeScript (MIT) de l'API REST : types générés par openapi-typescript depuis l'OpenAPI spécifiée
// (openapi/openapi.yaml, `pnpm gen:openapi`), appels typés par openapi-fetch. Aucune logique métier ici (06 § 4.1).
import createOpenApiClient, { type ClientOptions } from 'openapi-fetch';
import type { paths } from './generated/schema.js';

export type { components, paths } from './generated/schema.js';
export const PACKAGE_NAME = '@runtime/client';

/** Client typé : `client.GET('/api/me')`, `client.POST('/api/auth/sign-in/email', { body })`… */
export type ApiClient = ReturnType<typeof createApiClient>;

/**
 * Crée un client typé. Le cookie de session part avec les requêtes de même origine (`credentials: 'same-origin'`) ;
 * une clé d'API s'ajoute par `headers: { authorization: 'Bearer …' }`.
 */
export function createApiClient(options: ClientOptions = {}) {
  return createOpenApiClient<paths>({ credentials: 'same-origin', ...options });
}
