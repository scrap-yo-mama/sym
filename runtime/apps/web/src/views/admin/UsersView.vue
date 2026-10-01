<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file UsersView.vue
 * @description Utilisateurs (admin, 06 § 2, 13 § 6) : inviter (lien copiable sans SMTP, e-mail sinon), rôle, désactiver, supprimer,
 * révoquer les accès, réinitialiser la 2FA, lien de réinitialisation, transfert de propriété (owner). L'admin voit des comptes et
 * des métadonnées : aucun contenu de run, de dataset ou de cookie d'un autre, et aucune fonction « se faire passer pour » (INV5, A3,
 * `assert_admin_metadata_only`, `assert_no_impersonation`). Les actions à conséquence demandent une confirmation en ligne.
 * @page
 */
import { computed, onMounted, onServerPrefetch, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import SecretReveal from '@/components/account/SecretReveal.vue';
import TextField from '@/components/account/TextField.vue';
import ConfirmPanel from '@/components/api/ConfirmPanel.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useSession } from '@/composables/useSession';
import { useUsers, type AccountUser, type Invitation } from '@/composables/useUsers';
import { selectClass } from '@/lib/classes';
import { readFieldValue, takeFieldValue } from '@/lib/form-field';
import { formatDateTime } from '@/lib/format';
import { actionsFor, type UserAction } from '@/lib/user-actions';

const { t, locale } = useI18n();
const { me, can } = useSession();
const users = useUsers();
const { accounts, invitations, busy, failure, notice, oneTimeLink } = users;

onMounted(() => void invitations.refetch());
onServerPrefetch(() => Promise.all([invitations.refetch(), accounts.refetch()]).then(() => undefined));

const date = (iso: string | null | undefined): string => formatDateTime(iso, locale.value) ?? '—';
const nameOf = (user: AccountUser): string => user.display_name || user.email;
const viewer = computed(() => (me.value ? { id: me.value.id, role: me.value.role, canSetRole: can('users:set_role') } : null));
const actionsOf = (user: AccountUser): UserAction[] => (viewer.value ? actionsFor(viewer.value, user) : []);

// --- Invitation -------------------------------------------------------------------------------------------------------
const inviteEmail = ref('');
const inviteRole = ref<'member' | 'admin'>('member');
async function invite(event: Event): Promise<void> {
  const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : null;
  const email = readFieldValue(form, 'email', inviteEmail.value).trim();
  if (email === '') return;
  if (await users.invite(email, inviteRole.value)) inviteEmail.value = '';
}

function invitationState(invitation: Invitation): 'accepted' | 'revoked' | 'expired' | 'pending' {
  if (invitation.accepted_at) return 'accepted';
  if (invitation.revoked_at) return 'revoked';
  return new Date(invitation.expires_at).getTime() <= Date.now() ? 'expired' : 'pending';
}

// --- Actions à confirmer ----------------------------------------------------------------------------------------------
type Pending =
  | { kind: 'account'; action: UserAction; user: AccountUser }
  | { kind: 'revokeInvitation'; invitation: Invitation }
  | { kind: 'transfer'; user: AccountUser };
const pending = ref<Pending | null>(null);
/** Mot de passe et code du transfert, gardés le temps de la confirmation seulement. */
const transferDraft = ref<{ password: string; code: string } | null>(null);

function ask(action: UserAction, user: AccountUser): void {
  users.clearFeedback();
  pending.value = { kind: 'account', action, user };
}

const confirmation = computed(() => {
  const current = pending.value;
  if (!current) return null;
  if (current.kind === 'revokeInvitation') {
    return { title: t('users.invitations.revokeTitle'), consequence: t('users.invitations.revokeConsequence', { email: current.invitation.email }), label: t('users.invitations.revoke') };
  }
  if (current.kind === 'transfer') {
    return { title: t('users.transfer.confirmTitle', { name: nameOf(current.user) }), consequence: t('users.transfer.confirmConsequence'), label: t('users.transfer.submit') };
  }
  const name = nameOf(current.user);
  switch (current.action) {
    case 'disable':
      return { title: t('users.confirm.disable', { name }), consequence: t('users.confirm.disableConsequence'), label: t('users.action.disable') };
    case 'delete':
      return { title: t('users.confirm.delete', { name }), consequence: t('users.confirm.deleteConsequence'), label: t('users.action.delete') };
    case 'revokeAccess':
      return { title: t('users.confirm.revokeAccess', { name }), consequence: t('users.confirm.revokeAccessConsequence'), label: t('users.action.revokeAccess') };
    case 'resetTwoFactor':
      return { title: t('users.confirm.resetTwoFactor', { name }), consequence: t('users.confirm.resetTwoFactorConsequence'), label: t('users.action.resetTwoFactor') };
    case 'resetLink':
      return { title: t('users.confirm.resetLink', { name }), consequence: t('users.confirm.resetLinkConsequence'), label: t('users.action.resetLink') };
    case 'makeAdmin':
    case 'makeMember':
      return { title: t('users.confirm.role', { name, role: t(`users.roles.${current.action === 'makeAdmin' ? 'admin' : 'member'}`) }), consequence: t('users.confirm.roleConsequence'), label: t(`users.action.${current.action}`) };
    default:
      return { title: t(`users.action.${current.action}`), consequence: '', label: t(`users.action.${current.action}`) };
  }
});

async function confirm(): Promise<void> {
  const current = pending.value;
  pending.value = null;
  if (!current) return;
  if (current.kind === 'revokeInvitation') {
    await users.revokeInvitation(current.invitation);
    return;
  }
  if (current.kind === 'transfer') {
    const draft = transferDraft.value;
    transferDraft.value = null;
    if (draft && (await users.transferOwnership({ toUserId: current.user.id, currentPassword: draft.password, totpCode: draft.code }))) transferTarget.value = '';
    return;
  }
  const { action, user } = current;
  if (action === 'disable') await users.setStatus(user, 'disabled');
  else if (action === 'enable') await users.setStatus(user, 'active');
  else if (action === 'delete') await users.remove(user);
  else if (action === 'revokeAccess') await users.revokeAccess(user);
  else if (action === 'resetTwoFactor') await users.resetTwoFactor(user);
  else if (action === 'resetLink') await users.createResetLink(user);
  else if (action === 'makeAdmin') await users.setRole(user, 'admin');
  else if (action === 'makeMember') await users.setRole(user, 'member');
}

function cancel(): void {
  pending.value = null;
  transferDraft.value = null;
}

// --- Transfert de propriété ------------------------------------------------------------------------------------------
const transferTarget = ref('');
const transferPassword = ref('');
const transferCode = ref('');
const candidates = computed(() => accounts.items.value.filter((user) => user.status === 'active' && user.role !== 'owner'));
function startTransfer(event: Event): void {
  const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : null;
  const target = candidates.value.find((user) => user.id === transferTarget.value);
  if (!target) return;
  users.clearFeedback();
  transferDraft.value = { password: takeFieldValue(form, 'currentPassword', transferPassword), code: takeFieldValue(form, 'code', transferCode).trim() };
  pending.value = { kind: 'transfer', user: target };
}
</script>

<template>
  <section class="mx-auto flex max-w-6xl flex-col gap-6 py-8" aria-labelledby="users-heading">
    <header class="flex flex-col gap-1">
      <h1 id="users-heading" data-route-heading tabindex="-1" class="text-2xl font-semibold tracking-tight">{{ t('users.title') }}</h1>
      <p class="text-sm text-muted-foreground">{{ t('users.intro') }}</p>
    </header>

    <Alert v-if="failure" variant="destructive" data-testid="users-error"><AlertDescription>{{ t(failure) }}</AlertDescription></Alert>
    <p v-if="notice" role="status" class="text-sm" data-testid="users-notice">{{ t(notice.key, notice.params) }}</p>

    <SecretReveal
      v-if="oneTimeLink && oneTimeLink.kind === 'invitation'"
      :title="t('users.invite.link', { email: oneTimeLink.subject })"
      :text="t('users.invite.linkHelp')"
      :value="oneTimeLink.link"
      :copy-label="t('users.invite.copy')"
      :dismiss-label="t('users.invite.dismiss')"
      @dismiss="users.dismissLink()"
    />
    <SecretReveal
      v-else-if="oneTimeLink"
      :title="t('users.resetLink.title', { name: oneTimeLink.subject })"
      :text="`${t('users.resetLink.help')} ${t('users.resetLink.expires', { date: date(oneTimeLink.expiresAt) })}`"
      :value="oneTimeLink.link"
      :copy-label="t('users.invite.copy')"
      :dismiss-label="t('users.invite.dismiss')"
      @dismiss="users.dismissLink()"
    />

    <ConfirmPanel v-if="confirmation" id="user-confirm" :title="confirmation.title" :consequence="confirmation.consequence" :confirm-label="confirmation.label" :pending="busy" @confirm="confirm()" @cancel="cancel()" />

    <form class="flex flex-col gap-3 rounded-xl border p-4" novalidate data-testid="invite-form" @submit.prevent="invite">
      <h2 class="text-lg font-semibold">{{ t('users.invite.title') }}</h2>
      <TextField id="invite-email" v-model="inviteEmail" :label="t('users.invite.email')" :hint="t('users.invite.emailHint')" type="email" name="email" class="max-w-md" autocomplete="off" required />
      <div class="flex flex-col gap-1">
        <Label for="invite-role">{{ t('users.invite.role') }}</Label>
        <select id="invite-role" v-model="inviteRole" name="role" class="max-w-48" :class="selectClass">
          <option value="member">{{ t('users.roles.member') }}</option>
          <option v-if="can('users:set_role')" value="admin">{{ t('users.roles.admin') }}</option>
        </select>
      </div>
      <div><Button type="submit" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="busy">{{ busy ? t('users.invite.submitting') : t('users.invite.submit') }}</Button></div>
    </form>

    <div class="flex flex-col gap-2">
      <h2 class="text-lg font-semibold">{{ t('users.invitations.title') }}</h2>
      <p v-if="invitations.loading.value && !invitations.data.value" role="status" class="text-sm text-muted-foreground">{{ t('ui.loading') }}</p>
      <p v-else-if="(invitations.data.value ?? []).length === 0" class="text-sm text-muted-foreground" data-testid="invitations-empty">{{ t('users.invitations.empty') }}</p>
      <div v-else class="relative overflow-x-auto rounded-xl border">
        <table class="w-full text-left text-sm" data-testid="invitations-table">
          <caption class="sr-only">{{ t('users.invitations.caption') }}</caption>
          <thead class="border-b bg-muted/50">
            <tr>
              <th scope="col" class="p-3 font-medium">{{ t('users.invitations.email') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('users.invitations.role') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('users.invitations.expires') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('users.invitations.state') }}</th>
              <th scope="col" class="p-3 font-medium"><span class="sr-only">{{ t('users.accounts.actions') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="invitation in invitations.data.value ?? []" :key="invitation.id" class="border-b last:border-0" data-testid="invitation-row">
              <th scope="row" class="p-3 font-medium">{{ invitation.email }}</th>
              <td class="p-3">{{ t(`users.roles.${invitation.role}`) }}</td>
              <td class="p-3">{{ date(invitation.expires_at) }}</td>
              <td class="p-3">{{ t(`users.invitations.${invitationState(invitation)}`) }}</td>
              <td class="p-3">
                <div v-if="invitationState(invitation) === 'pending' || invitationState(invitation) === 'expired'" class="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" :aria-label="t('users.action.for', { action: t('users.invitations.resend'), name: invitation.email })" @click="users.resend(invitation)">{{ t('users.invitations.resend') }}</Button>
                  <Button type="button" variant="outline" size="sm" :aria-label="t('users.action.for', { action: t('users.invitations.revoke'), name: invitation.email })" @click="pending = { kind: 'revokeInvitation', invitation }">{{ t('users.invitations.revoke') }}</Button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="flex flex-col gap-2">
      <h2 class="text-lg font-semibold">{{ t('users.accounts.title') }}</h2>
      <p class="text-xs text-muted-foreground">{{ t('users.resetLink.note') }}</p>
      <p v-if="accounts.loading.value && !accounts.loaded.value" role="status" class="text-sm text-muted-foreground">{{ t('ui.loading') }}</p>
      <p v-else-if="accounts.error.value" class="sym-error" data-testid="accounts-error">{{ t('errors.generic') }}</p>
      <p v-else-if="accounts.items.value.length === 0" class="text-sm text-muted-foreground">{{ t('users.accounts.empty') }}</p>
      <div v-else class="relative overflow-x-auto rounded-xl border">
        <table class="w-full text-left text-sm" data-testid="accounts-table">
          <caption class="sr-only">{{ t('users.accounts.caption') }}</caption>
          <thead class="border-b bg-muted/50">
            <tr>
              <th scope="col" class="p-3 font-medium">{{ t('users.accounts.name') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('users.accounts.role') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('users.accounts.status') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('users.accounts.mfa') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('users.accounts.lastLogin') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('users.accounts.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in accounts.items.value" :key="user.id" class="border-b last:border-0" data-testid="account-row">
              <th scope="row" class="p-3 font-normal">
                <span class="font-medium">{{ nameOf(user) }}</span>
                <span v-if="user.display_name" class="block text-xs text-muted-foreground">{{ user.email }}</span>
                <span v-if="user.id === me?.id" class="block text-xs">{{ t('users.accounts.you') }}</span>
              </th>
              <td class="p-3">{{ t(`users.roles.${user.role}`) }}</td>
              <td class="p-3">{{ t(`users.statuses.${user.status}`) }}</td>
              <td class="p-3">{{ user.mfa_enabled ? t('users.accounts.mfaOn') : t('users.accounts.mfaOff') }}</td>
              <td class="p-3">{{ user.last_login_at ? date(user.last_login_at) : t('users.accounts.never') }}</td>
              <td class="p-3">
                <p v-if="user.role === 'owner' && user.id !== me?.id" class="text-xs text-muted-foreground">{{ t('users.accounts.ownerNoActions') }}</p>
                <div class="flex flex-wrap gap-2">
                  <Button
                    v-for="action in actionsOf(user)"
                    :key="action"
                    type="button"
                    variant="outline"
                    size="sm"
                    :data-testid="`action-${action}`"
                    :aria-label="t('users.action.for', { action: t(`users.action.${action}`), name: nameOf(user) })"
                    @click="ask(action, user)"
                  >
                    {{ t(`users.action.${action}`) }}
                  </Button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="accounts.hasMore()"><Button type="button" variant="outline" size="sm" :disabled="accounts.loadingMore.value" @click="accounts.loadMore()">{{ t('users.accounts.loadMore') }}</Button></div>
    </div>

    <form v-if="can('owner:transfer')" class="flex flex-col gap-3 rounded-xl border p-4" novalidate data-testid="transfer-form" @submit.prevent="startTransfer">
      <h2 class="text-lg font-semibold">{{ t('users.transfer.title') }}</h2>
      <p class="text-sm text-muted-foreground">{{ t('users.transfer.intro') }}</p>
      <div class="flex flex-col gap-1">
        <Label for="transfer-to">{{ t('users.transfer.to') }}</Label>
        <select id="transfer-to" v-model="transferTarget" name="to" class="max-w-md" :class="selectClass" required>
          <option value="">{{ t('users.transfer.choose') }}</option>
          <option v-for="user in candidates" :key="user.id" :value="user.id">{{ nameOf(user) }} ({{ user.email }})</option>
        </select>
      </div>
      <TextField id="transfer-password" v-model="transferPassword" :label="t('users.transfer.password')" type="password" name="currentPassword" class="max-w-xs" autocomplete="current-password" />
      <TextField id="transfer-code" v-model="transferCode" :label="t('users.transfer.code')" name="code" class="max-w-xs" inputmode="numeric" autocomplete="one-time-code" required />
      <div><Button type="submit" variant="outline">{{ t('users.transfer.submit') }}</Button></div>
    </form>
  </section>
</template>
