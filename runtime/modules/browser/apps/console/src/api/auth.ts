// SPDX-License-Identifier: AGPL-3.0-only
// Connexion admin de la console (tâche 3.5 ; 03 § 7, 04d § 5.3). L'authentification côté serveur est la tâche 2.1 : tant
// qu'elle n'est pas fusionnée, la console parle à cette interface `AuthApi`, servie en développement et en test par la
// simulation `testing/mock-auth.ts`, et en production par `createHttpAuthApi` sur les routes ci-dessous.
// À BRANCHER SUR 2.1 (voir aussi la note du rapport de 3.5) :
//   - routes et statuts : `AUTH_ROUTES` et `testing/fake-server.ts` sont la proposition ; 2.1 les implémente ou la console suit ;
//   - codes d'erreur (`LoginError`, `TotpError`, `SetupError`) : à ajouter au contrat `@sym/contracts/browser` (ERROR_CODES,
//     BROWSER_PROTOCOL_VERSION) par une tâche de contrat, puis à importer ici à la place des listes locales ;
//   - cookie `__Host-` (Secure, HttpOnly, SameSite=Strict, Path=/) posé par la passerelle ; la console ne le lit jamais.
import type { ApiResult, HttpClient } from './client.js';

export const AUTH_ROUTES = {
  status: '/v1/console/auth/status',
  login: '/v1/console/auth/login',
  totp: '/v1/console/auth/totp',
  logout: '/v1/console/auth/logout',
  setup: '/v1/console/setup',
} as const;

/** Mot de passe de l'admin : 12 caractères au moins (04d § 5.3, « à valider »). */
export const PASSWORD_MIN_LENGTH = 12;

export type Admin = { email: string };
/** `initialized` : un admin existe ; `admin` : session ouverte ; `totpPending` : mot de passe vérifié, code TOTP attendu. */
export type AuthStatus = { initialized: boolean; admin: Admin | null; totpPending: boolean };
type LoginOutcome = { step: 'done'; admin: Admin } | { step: 'totp' };

export type LoginError = 'invalid_credentials' | 'rate_limited' | 'not_initialized';
export type TotpError = 'invalid_code' | 'rate_limited' | 'no_pending_login';
export type SetupError = 'invalid_bootstrap_token' | 'already_initialized' | 'weak_password' | 'invalid_email' | 'rate_limited';

type LoginRequest = { email: string; password: string };
type TotpRequest = { code: string };
export type SetupRequest = { token: string; email: string; password: string };

export interface AuthApi {
  status(): Promise<ApiResult<AuthStatus>>;
  login(request: LoginRequest): Promise<ApiResult<LoginOutcome, LoginError>>;
  verifyTotp(request: TotpRequest): Promise<ApiResult<{ admin: Admin }, TotpError>>;
  logout(): Promise<ApiResult<void>>;
  setup(request: SetupRequest): Promise<ApiResult<{ admin: Admin }, SetupError>>;
}

/** Implémentation HTTP (production) : un appel par route, aucune logique de décision côté console. */
export function createHttpAuthApi(http: HttpClient): AuthApi {
  return {
    status: () => http.request<AuthStatus>('GET', AUTH_ROUTES.status),
    login: (request) => http.request<LoginOutcome, LoginError>('POST', AUTH_ROUTES.login, request),
    verifyTotp: (request) => http.request<{ admin: Admin }, TotpError>('POST', AUTH_ROUTES.totp, request),
    logout: () => http.request<void>('POST', AUTH_ROUTES.logout),
    setup: (request) => http.request<{ admin: Admin }, SetupError>('POST', AUTH_ROUTES.setup, request),
  };
}
