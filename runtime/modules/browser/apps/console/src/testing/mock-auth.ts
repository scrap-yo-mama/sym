// SPDX-License-Identifier: AGPL-3.0-only
// Simulation d'`AuthApi` (tâche 3.5) : fausses réponses conformes à la spec (03 § 7, 04d § 5.3, D13) en attendant la tâche
// 2.1. Elle sert le serveur de développement (`vite`), les tests unitaires et le faux serveur des E2E ; elle n'entre jamais
// dans la console construite (test E2E « la simulation d'AuthApi n'est pas dans la console construite »).
// Rien de réel ici : jeton, e-mail, mot de passe et code TOTP sont des valeurs de test fournies par l'appelant ou fixes.
import type { ApiFailure, ApiResult } from '../api/client.js';
import { PASSWORD_MIN_LENGTH, type Admin, type AuthApi, type AuthStatus, type LoginError, type SetupError, type TotpError } from '../api/auth.js';

/** Repère de la simulation : sa présence dans dist/ ferait échouer le test E2E de construction. */
export const MOCK_AUTH_MARKER = 'sym-browser-console:mock-auth';
/** Code TOTP accepté par la simulation (fixe : la simulation ne calcule pas de TOTP). */
export const MOCK_TOTP_CODE = '123456';
/** Échecs consécutifs (mot de passe, code) avant `rate_limited`. */
const MOCK_MAX_FAILURES = 5;

export type MockAuthOptions = {
  /** Jeton de premier démarrage attendu par /setup (consommé à la création de l'admin). */
  bootstrapToken: string;
  /** Admin déjà créé (instance initialisée) ; `totp` : 2FA activée. */
  admin?: { email: string; password: string; totp?: boolean } | undefined;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const fail = <C extends string>(status: number, code: C): ApiFailure<C> => ({ ok: false, status, code, requestId: `req_mock_${code}` });

export function createMockAuthApi(options: MockAuthOptions): AuthApi {
  let bootstrapToken: string | null = options.admin ? null : options.bootstrapToken;
  let account = options.admin ? { ...options.admin, totp: options.admin.totp === true } : null;
  let session: 'none' | 'totp' | 'auth' = 'none';
  let failures = 0;

  const admin = (): Admin => ({ email: account?.email ?? '' });

  const api: AuthApi & { readonly [Symbol.toStringTag]: string } = {
    [Symbol.toStringTag]: MOCK_AUTH_MARKER,

    async status(): Promise<ApiResult<AuthStatus>> {
      return { ok: true, status: 200, data: { initialized: account !== null, admin: session === 'auth' ? admin() : null, totpPending: session === 'totp' } };
    },

    async login({ email, password }) {
      if (!account) return fail<LoginError>(409, 'not_initialized');
      if (failures >= MOCK_MAX_FAILURES) return fail<LoginError>(429, 'rate_limited');
      // Compte inconnu et mauvais mot de passe : même réponse (pas d'énumération des comptes).
      if (email.trim().toLowerCase() !== account.email.toLowerCase() || password !== account.password) {
        failures += 1;
        return fail<LoginError>(401, 'invalid_credentials');
      }
      failures = 0;
      if (account.totp) {
        session = 'totp';
        return { ok: true, status: 200, data: { step: 'totp' } };
      }
      session = 'auth';
      return { ok: true, status: 200, data: { step: 'done', admin: admin() } };
    },

    async verifyTotp({ code }) {
      if (session !== 'totp') return fail<TotpError>(409, 'no_pending_login');
      if (failures >= MOCK_MAX_FAILURES) return fail<TotpError>(429, 'rate_limited');
      if (code.trim() !== MOCK_TOTP_CODE) {
        failures += 1;
        return fail<TotpError>(401, 'invalid_code');
      }
      failures = 0;
      session = 'auth';
      return { ok: true, status: 200, data: { admin: admin() } };
    },

    async logout() {
      session = 'none';
      return { ok: true, status: 204, data: undefined };
    },

    async setup({ token, email, password }) {
      if (account || bootstrapToken === null) return fail<SetupError>(409, 'already_initialized');
      if (failures >= MOCK_MAX_FAILURES) return fail<SetupError>(429, 'rate_limited');
      if (token.trim() !== bootstrapToken) {
        failures += 1;
        return fail<SetupError>(401, 'invalid_bootstrap_token');
      }
      if (!EMAIL.test(email.trim())) return fail<SetupError>(400, 'invalid_email');
      if ([...password].length < PASSWORD_MIN_LENGTH) return fail<SetupError>(400, 'weak_password');
      failures = 0;
      account = { email: email.trim(), password, totp: false };
      bootstrapToken = null;
      return { ok: true, status: 201, data: { admin: admin() } };
    },
  };
  return api;
}
