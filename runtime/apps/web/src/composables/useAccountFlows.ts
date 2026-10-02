// SPDX-License-Identifier: AGPL-3.0-only
// Parcours publics des comptes (13 § 4, § 5, § 6) : assistant de premier démarrage, acceptation d'une invitation, mot de
// passe oublié et réinitialisation. Aucun mot de passe, jeton ou code n'est conservé ici : chaque valeur part dans la requête
// et la fonction rend un résultat typé. Le serveur répond avec des codes stables que la console traduit (06 § 4.1) ; une
// invitation inconnue, expirée ou consommée reçoit la même réponse (`invitation_invalid`, 6.3.8) et la console n'en dit pas plus.
import type { components } from '@runtime/client';
import { ref } from 'vue';
import { loadSession } from '@/composables/useSession';
import { call, type CallResult } from '@/lib/api-call';
import { getApi } from '@/lib/api';

type Schemas = components['schemas'];
export type SetupResult = Schemas['SetupResult'];
export type SsoPublic = Schemas['SsoPublic'];

/** Premier démarrage : jeton de démarrage, e-mail, mot de passe. Après la création, `/setup` répond 404 pour toujours. */
export function postSetup(input: { token: string; email: string; password: string; displayName?: string; instanceContact?: string }): Promise<CallResult<SetupResult>> {
  const body: Schemas['SetupRequest'] = { token: input.token, email: input.email, password: input.password };
  if (input.displayName) body.displayName = input.displayName;
  if (input.instanceContact) body.instanceContact = input.instanceContact;
  return call(() => getApi().POST('/api/setup', { body }));
}

/** Acceptation d'une invitation : le serveur ouvre la session (cookie) ; l'identité est relue ensuite. */
export async function acceptInvitation(input: { token: string; password: string; displayName?: string }): Promise<CallResult<Schemas['Me']>> {
  const body: Schemas['InvitationAccept'] = { token: input.token, password: input.password };
  if (input.displayName) body.display_name = input.displayName;
  const result = await call(() => getApi().POST('/api/invitations/accept', { body }));
  if (result.ok) await loadSession();
  return result;
}

/** Mot de passe oublié : réponse identique que le compte existe ou non (6.3.8). */
export function requestPasswordReset(email: string): Promise<CallResult<{ status: 'accepted' }>> {
  return call(() => getApi().POST('/api/auth/password-reset/request', { body: { email } }));
}

/** Nouveau mot de passe par lien à usage unique ; le second facteur est exigé si le compte en a un. */
export function confirmPasswordReset(input: { token: string; password: string; code?: string }): Promise<CallResult<undefined>> {
  const body: Schemas['PasswordReset'] = { token: input.token, password: input.password };
  if (input.code) body.code = input.code;
  return call<undefined>(() => getApi().POST('/api/auth/password-reset/confirm', { body }));
}

/** SSO proposé sur les pages publiques (connexion, invitation) : public, sans secret. Une panne se lit « pas de SSO ». */
export function useSsoPublic() {
  const sso = ref<SsoPublic | null>(null);
  async function load(): Promise<void> {
    const result = await call(() => getApi().GET('/api/sso'));
    sso.value = result.ok ? result.data : null;
  }
  return { sso, load };
}
