// SPDX-License-Identifier: AGPL-3.0-only
// Utilisateurs et invitations (06 § 2, 13 § 6) : l'admin invite (lien copiable sans SMTP, e-mail sinon), fixe le rôle, désactive,
// supprime, révoque les accès, réinitialise la 2FA, émet un lien de réinitialisation, et l'owner transfère la propriété. L'admin ne
// voit que des comptes et des métadonnées : aucune de ces routes ne renvoie de contenu d'un autre, et la console n'en demande pas
// (INV5, A3). Un lien d'invitation ou de réinitialisation n'est montré qu'une fois ; il n'est jamais relu.
import type { components } from '@runtime/client';
import { ref, shallowRef } from 'vue';
import { useAsyncResource } from '@/composables/useAsyncResource';
import { usePagedList } from '@/composables/usePagedList';
import { loadSession } from '@/composables/useSession';
import { call, type CallResult } from '@/lib/api-call';
import { getApi } from '@/lib/api';
import { unwrap } from '@/lib/api-result';

type Schemas = components['schemas'];
export type AccountUser = Schemas['User'];
export type Invitation = Schemas['Invitation'];
export type InvitableRole = Schemas['InvitationCreate']['role'];

/** Lien à usage unique montré une fois : invitation sans SMTP, ou lien de réinitialisation d'un compte à 2FA. */
export type OneTimeLink = { kind: 'invitation' | 'reset'; subject: string; link: string; expiresAt: string | null };

/** Message de réussite : clé i18n et paramètres, annoncé dans une région `role="status"`. */
export type Notice = { key: string; params: Record<string, string> };

export function useUsers() {
  const accounts = usePagedList<AccountUser>(async (cursor) => {
    const data = unwrap(await getApi().GET('/api/users', { params: { query: { ...(cursor ? { cursor } : {}), limit: 50 } } }));
    return { items: data.users, nextCursor: data.next_cursor };
  });
  const invitations = useAsyncResource<Invitation[]>(async () => unwrap(await getApi().GET('/api/invitations')).invitations);

  const busy = ref(false);
  /** Clé i18n de la dernière erreur d'action, sinon null. */
  const failure = ref<string | null>(null);
  const notice = shallowRef<Notice | null>(null);
  const oneTimeLink = shallowRef<OneTimeLink | null>(null);

  /** Exécute une action : état occupé, erreur ou réussite annoncée, puis relecture des listes touchées. */
  async function act<T>(run: () => Promise<CallResult<T>>, done: (data: T) => void): Promise<boolean> {
    busy.value = true;
    failure.value = null;
    notice.value = null;
    const result = await run();
    busy.value = false;
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    done(result.data);
    return true;
  }

  const say = (key: string, params: Record<string, string> = {}): void => void (notice.value = { key, params });

  async function invite(email: string, role: InvitableRole, locale?: string): Promise<boolean> {
    const ok = await act(
      () => call(() => getApi().POST('/api/invitations', { body: { email, role, ...(locale === undefined ? {} : { locale }) } })),
      (created) => {
        oneTimeLink.value = created.link ? { kind: 'invitation', subject: created.email, link: created.link, expiresAt: created.expires_at } : null;
        if (!created.link) say('users.invite.emailed', { email: created.email });
      },
    );
    if (ok) await invitations.refetch({ silent: true });
    return ok;
  }

  async function resend(invitation: Invitation): Promise<boolean> {
    const ok = await act(
      () => call(() => getApi().POST('/api/invitations/{id}/resend', { params: { path: { id: invitation.id } } })),
      (created) => {
        oneTimeLink.value = created.link ? { kind: 'invitation', subject: created.email, link: created.link, expiresAt: created.expires_at } : null;
        if (!created.link) say('users.done.invitationResent');
      },
    );
    if (ok) await invitations.refetch({ silent: true });
    return ok;
  }

  async function revokeInvitation(invitation: Invitation): Promise<boolean> {
    const ok = await act(
      () => call<undefined>(() => getApi().DELETE('/api/invitations/{id}', { params: { path: { id: invitation.id } } })),
      () => say('users.done.invitationRevoked'),
    );
    if (ok) await invitations.refetch({ silent: true });
    return ok;
  }

  async function patch(user: AccountUser, body: Schemas['UserPatch'], done: string): Promise<boolean> {
    const ok = await act(
      () => call(() => getApi().PATCH('/api/users/{id}', { params: { path: { id: user.id } }, body })),
      () => say(done),
    );
    if (ok) await accounts.refetch();
    return ok;
  }

  const setRole = (user: AccountUser, role: 'member' | 'admin'): Promise<boolean> => patch(user, { role }, 'users.done.role');
  const setStatus = (user: AccountUser, status: 'active' | 'disabled'): Promise<boolean> => patch(user, { status }, status === 'disabled' ? 'users.done.disabled' : 'users.done.enabled');

  async function remove(user: AccountUser): Promise<boolean> {
    const ok = await act(
      () => call<undefined>(() => getApi().DELETE('/api/users/{id}', { params: { path: { id: user.id } } })),
      () => say('users.done.deleted'),
    );
    if (ok) await accounts.refetch();
    return ok;
  }

  const revokeAccess = (user: AccountUser): Promise<boolean> =>
    act(
      () => call<undefined>(() => getApi().POST('/api/users/{id}/revoke-access', { params: { path: { id: user.id } } })),
      () => say('users.done.revoked'),
    );

  async function resetTwoFactor(user: AccountUser): Promise<boolean> {
    const ok = await act(
      () => call<undefined>(() => getApi().DELETE('/api/users/{id}/2fa', { params: { path: { id: user.id } } })),
      () => say('users.done.twoFactorReset'),
    );
    if (ok) await accounts.refetch();
    return ok;
  }

  const createResetLink = (user: AccountUser): Promise<boolean> =>
    act(
      () => call(() => getApi().POST('/api/users/{id}/reset-link', { params: { path: { id: user.id } } })),
      (created) => void (oneTimeLink.value = { kind: 'reset', subject: user.display_name || user.email, link: created.link, expiresAt: created.expires_at }),
    );

  /** Transfert de propriété : mot de passe et code TOTP envoyés une fois, jamais conservés. L'appelant devient admin : identité relue. */
  async function transferOwnership(input: { toUserId: string; currentPassword: string; totpCode: string }): Promise<boolean> {
    const body: Schemas['OwnerTransferRequest'] = { to_user_id: input.toUserId, totp_code: input.totpCode };
    if (input.currentPassword) body.current_password = input.currentPassword;
    const ok = await act(
      () => call<undefined>(() => getApi().POST('/api/owner/transfer', { body })),
      () => say('users.transfer.done'),
    );
    if (ok) {
      await loadSession();
      await accounts.refetch();
    }
    return ok;
  }

  return {
    accounts,
    invitations,
    busy,
    failure,
    notice,
    oneTimeLink,
    invite,
    resend,
    revokeInvitation,
    setRole,
    setStatus,
    remove,
    revokeAccess,
    resetTwoFactor,
    createResetLink,
    transferOwnership,
    dismissLink: () => void (oneTimeLink.value = null),
    clearFeedback: () => {
      failure.value = null;
      notice.value = null;
    },
  };
}
