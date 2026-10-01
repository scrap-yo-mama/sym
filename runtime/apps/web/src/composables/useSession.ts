// SPDX-License-Identifier: AGPL-3.0-only
// Session de la console : identité relue du serveur (`GET /api/me`) à l'ouverture et après chaque connexion. Le jeton
// de session ne vit que dans le cookie HttpOnly ; la console ne le voit jamais. Aucune décision de droit ici : le
// serveur répond 401, 403 ou 404 (06 § 4.1).
import type { components } from '@runtime/client';
import { computed, readonly, ref } from 'vue';
import { getApi } from '@/lib/api';

type Me = components['schemas']['Me'];

/** `unknown` : pas encore interrogé ; `unavailable` : serveur injoignable ; `not_initialized` : assistant à terminer (13 § 4). */
export type SessionState = 'unknown' | 'anonymous' | 'authenticated' | 'not_initialized' | 'unavailable';

/** Codes d'échec de connexion, traduits par `auth.errors.<code>`. */
export type SignInFailure = 'invalid_credentials' | 'too_many_attempts' | 'not_initialized' | 'network' | 'unknown';

/** Code stable d'une erreur `{ error: { code } }` du serveur, sinon null. */
function apiErrorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const inner = body.error;
  return typeof inner === 'object' && inner !== null && 'code' in inner && typeof inner.code === 'string' ? inner.code : null;
}

const state = ref<SessionState>('unknown');
const me = ref<Me | null>(null);
/** Vrai quand une session authentifiée vient d'être perdue (affiche « session terminée » sur la page de connexion). */
const expired = ref(false);

export function useSession() {
  return {
    state: readonly(state),
    me: readonly(me),
    expired: readonly(expired),
    isAuthenticated: computed(() => state.value === 'authenticated'),
  };
}

function setAnonymous(next: SessionState = 'anonymous'): void {
  state.value = next;
  me.value = null;
}

/**
 * Interroge le serveur sur l'identité courante. La sonde est `GET /api/auth/get-session` (200 avec `null` sans session) :
 * un visiteur anonyme ne provoque aucune erreur 401 dans la console du navigateur (06 § 4.3, 0 erreur de console).
 * `GET /api/me` n'est lu qu'une fois la session confirmée : il relit rôle et statut en base (13 § 2).
 */
export async function loadSession(): Promise<SessionState> {
  try {
    const api = getApi();
    const probe = await api.GET('/api/auth/get-session');
    if (probe.response.status === 503 && apiErrorCode(probe.error) === 'not_initialized') {
      setAnonymous('not_initialized');
    } else if (!probe.response.ok) {
      setAnonymous('unavailable');
    } else if (probe.data === null || probe.data === undefined) {
      setAnonymous();
    } else {
      const { data, response } = await api.GET('/api/me');
      if (data) {
        me.value = data;
        state.value = 'authenticated';
        expired.value = false;
      } else {
        // 401 : compte désactivé ou session révoquée entre-temps ; autre statut : serveur en difficulté.
        setAnonymous(response.status === 401 ? 'anonymous' : 'unavailable');
      }
    }
  } catch {
    setAnonymous('unavailable');
  }
  return state.value;
}

/** Charge la session une seule fois (garde du routeur). */
let pending: Promise<SessionState> | null = null;
export function ensureSession(): Promise<SessionState> {
  if (state.value !== 'unknown') return Promise.resolve(state.value);
  pending ??= loadSession().finally(() => {
    pending = null;
  });
  return pending;
}

export async function signIn(email: string, password: string): Promise<{ ok: true } | { ok: false; failure: SignInFailure }> {
  try {
    const { data, error, response } = await getApi().POST('/api/auth/sign-in/email', { body: { email, password } });
    if (!data) {
      if (response.status === 401) return { ok: false, failure: 'invalid_credentials' };
      if (response.status === 429) return { ok: false, failure: 'too_many_attempts' };
      if (response.status === 503 && apiErrorCode(error) === 'not_initialized') {
        setAnonymous('not_initialized');
        return { ok: false, failure: 'not_initialized' };
      }
      return { ok: false, failure: 'unknown' };
    }
  } catch {
    return { ok: false, failure: 'network' };
  }
  return (await loadSession()) === 'authenticated' ? { ok: true } : { ok: false, failure: 'unknown' };
}

/** Ferme la session côté serveur ; la session locale est effacée même si le serveur est injoignable. */
export async function signOut(): Promise<void> {
  try {
    await getApi().POST('/api/auth/sign-out', { body: {} });
  } catch {
    /* injoignable : le cookie expirera côté serveur ; la console retombe sur la connexion */
  }
  setAnonymous();
}

/** Session perdue en cours d'usage (401 d'une requête authentifiée). */
export function markExpired(): void {
  if (state.value !== 'authenticated') return;
  setAnonymous();
  expired.value = true;
}

/** Réinitialise l'état (tests). */
export function resetSession(): void {
  state.value = 'unknown';
  me.value = null;
  expired.value = false;
  pending = null;
}
