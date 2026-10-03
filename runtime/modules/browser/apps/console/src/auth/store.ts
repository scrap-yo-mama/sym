// SPDX-License-Identifier: AGPL-3.0-only
// État de connexion de la console (tâche 3.5) : une seule source, alimentée par `AuthApi`. Les droits sont décidés par le
// serveur ; la console ne fait que refléter son statut (instance initialisée, session ouverte, code TOTP attendu).
import { inject, readonly, ref, type InjectionKey, type Ref } from 'vue';
import type { TransportCode } from '../api/client.js';
import type { Admin, AuthApi, LoginError, SetupError, SetupRequest, TotpError } from '../api/auth.js';

type AuthState = 'unknown' | 'unavailable' | 'not_initialized' | 'anonymous' | 'totp_pending' | 'authenticated';
type Failure<C extends string> = { ok: false; code: C | TransportCode | (string & {}) };

export type AuthStore = {
  state: Readonly<Ref<AuthState>>;
  admin: Readonly<Ref<Admin | null>>;
  /** L'admin vient d'être créé par /setup : la page de connexion le confirme. */
  justInitialized: Readonly<Ref<boolean>>;
  /** Une requête authentifiée a reçu 401 : la page de connexion l'explique. */
  expired: Readonly<Ref<boolean>>;
  ensureLoaded(): Promise<void>;
  refresh(): Promise<void>;
  login(email: string, password: string): Promise<{ ok: true; step: 'done' | 'totp' } | Failure<LoginError>>;
  verifyTotp(code: string): Promise<{ ok: true } | Failure<TotpError>>;
  cancelTotp(): Promise<void>;
  logout(): Promise<void>;
  setup(request: SetupRequest): Promise<{ ok: true } | Failure<SetupError>>;
  markExpired(): void;
};

export const AUTH_KEY: InjectionKey<AuthStore> = Symbol('sym-browser-console-auth');

export function createAuthStore(api: AuthApi): AuthStore {
  const state = ref<AuthState>('unknown');
  const admin = ref<Admin | null>(null);
  const justInitialized = ref(false);
  const expired = ref(false);
  let loading: Promise<void> | undefined;

  async function refresh(): Promise<void> {
    const result = await api.status();
    if (!result.ok) {
      state.value = 'unavailable';
      admin.value = null;
      return;
    }
    const { initialized, admin: current, totpPending } = result.data;
    admin.value = current;
    state.value = !initialized ? 'not_initialized' : current ? 'authenticated' : totpPending ? 'totp_pending' : 'anonymous';
  }

  function signedIn(current: Admin): void {
    admin.value = current;
    state.value = 'authenticated';
    expired.value = false;
    justInitialized.value = false;
  }

  return {
    state: readonly(state),
    admin: readonly(admin),
    justInitialized: readonly(justInitialized),
    expired: readonly(expired),
    ensureLoaded() {
      loading ??= refresh();
      return loading;
    },
    refresh() {
      loading = refresh();
      return loading;
    },
    async login(email, password) {
      const result = await api.login({ email, password });
      if (!result.ok) {
        if (result.code === 'not_initialized') await this.refresh();
        return { ok: false, code: result.code };
      }
      if (result.data.step === 'totp') {
        state.value = 'totp_pending';
        return { ok: true, step: 'totp' };
      }
      signedIn(result.data.admin);
      return { ok: true, step: 'done' };
    },
    async verifyTotp(code) {
      const result = await api.verifyTotp({ code });
      if (!result.ok) {
        if (result.code === 'no_pending_login') state.value = 'anonymous';
        return { ok: false, code: result.code };
      }
      signedIn(result.data.admin);
      return { ok: true };
    },
    async cancelTotp() {
      await api.logout();
      state.value = 'anonymous';
    },
    async logout() {
      await api.logout();
      admin.value = null;
      state.value = 'anonymous';
    },
    async setup(request) {
      const result = await api.setup(request);
      if (!result.ok) {
        if (result.code === 'already_initialized') await this.refresh();
        return { ok: false, code: result.code };
      }
      justInitialized.value = true;
      state.value = 'anonymous';
      return { ok: true };
    },
    markExpired() {
      if (state.value !== 'authenticated') return;
      expired.value = true;
      admin.value = null;
      state.value = 'anonymous';
    },
  };
}

export function useAuth(): AuthStore {
  const store = inject(AUTH_KEY);
  if (!store) throw new Error('AuthStore absent : la console doit être créée par createConsoleApp');
  return store;
}
