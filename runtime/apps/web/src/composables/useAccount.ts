// SPDX-License-Identifier: AGPL-3.0-only
// Mon compte (06 § 2, 13 § 5 et § 7) : mot de passe, 2FA TOTP, sessions d'interface ouvertes, identités SSO liées, activité
// récente. Après un changement de mot de passe ou de 2FA, la fermeture des autres sessions est proposée (ASVS 7.4.3). Mot de
// passe, code et graine partent dans la requête et ne sont jamais conservés ; les codes de secours et la graine ne vivent
// que le temps de leur affichage (« une seule fois »). Les droits sont ceux du serveur : un refus devient un message.
import type { components } from '@runtime/client';
import { computed, readonly, ref, shallowRef } from 'vue';
import { usePagedList } from '@/composables/usePagedList';
import { loadSession } from '@/composables/useSession';
import { useResource } from '@/composables/useResource';
import { call } from '@/lib/api-call';
import { getApi } from '@/lib/api';
import { unwrap } from '@/lib/api-result';

type Schemas = components['schemas'];

/** `current_password` n'est envoyé que s'il est saisi : un compte SSO seul le laisse vide (13 § 5, 7.5.1). */
const withPassword = <T extends object>(body: T, currentPassword: string): T & { current_password?: string } => (currentPassword === '' ? body : { ...body, current_password: currentPassword });

/** Activation, confirmation, régénération des codes de secours et retrait de la 2FA. */
export function useTwoFactor() {
  /** `idle` : rien en cours ; `enrolling` : graine affichée, premier code attendu ; `backup` : codes de secours à ranger. */
  const phase = ref<'idle' | 'enrolling' | 'backup'>('idle');
  const enrollment = shallowRef<{ secret: string; uri: string } | null>(null);
  const backupCodes = shallowRef<string[]>([]);
  const busy = ref(false);
  const failure = ref<string | null>(null);
  const disabledDone = ref(false);
  /** Un facteur vient de changer (2FA activée, codes régénérés, 2FA retirée) : proposer de fermer les autres sessions. */
  const offerCloseOthers = ref(false);

  async function start(currentPassword: string): Promise<boolean> {
    busy.value = true;
    failure.value = null;
    disabledDone.value = false;
    const result = await call(() => getApi().POST('/api/me/2fa/enroll', { body: withPassword({}, currentPassword) }));
    busy.value = false;
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    enrollment.value = { secret: result.data.secret, uri: result.data.otpauth_uri };
    phase.value = 'enrolling';
    return true;
  }

  async function confirm(code: string): Promise<boolean> {
    busy.value = true;
    failure.value = null;
    const result = await call(() => getApi().POST('/api/me/2fa/confirm', { body: { code } }));
    busy.value = false;
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    enrollment.value = null;
    backupCodes.value = result.data.backup_codes;
    phase.value = 'backup';
    offerCloseOthers.value = true;
    await loadSession();
    return true;
  }

  async function regenerate(currentPassword: string, code: string): Promise<boolean> {
    busy.value = true;
    failure.value = null;
    const result = await call(() => getApi().POST('/api/me/2fa/backup-codes', { body: withPassword({ code }, currentPassword) }));
    busy.value = false;
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    backupCodes.value = result.data.backup_codes;
    phase.value = 'backup';
    offerCloseOthers.value = true;
    return true;
  }

  async function disable(currentPassword: string, code: string): Promise<boolean> {
    busy.value = true;
    failure.value = null;
    const result = await call<undefined>(() => getApi().DELETE('/api/me/2fa', { body: withPassword({ code }, currentPassword) }));
    busy.value = false;
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    disabledDone.value = true;
    offerCloseOthers.value = true;
    await loadSession();
    return true;
  }

  /** Abandonne l'activation en cours (la graine non confirmée n'active rien). */
  function cancel(): void {
    enrollment.value = null;
    phase.value = 'idle';
    failure.value = null;
  }

  /** Les codes de secours sont rangés : ils quittent la mémoire de l'écran. */
  function acknowledgeBackup(): void {
    backupCodes.value = [];
    phase.value = 'idle';
  }

  /** La proposition de fermer les autres sessions est traitée (fermées, ou « plus tard »). */
  function dismissCloseOthers(): void {
    offerCloseOthers.value = false;
  }

  return {
    phase: readonly(phase),
    enrollment,
    backupCodes,
    busy: readonly(busy),
    failure: readonly(failure),
    disabledDone: readonly(disabledDone),
    offerCloseOthers: readonly(offerCloseOthers),
    start,
    confirm,
    regenerate,
    disable,
    cancel,
    acknowledgeBackup,
    dismissCloseOthers,
  };
}

/**
 * Changement du mot de passe (06 § 2, 13 § 5) : mot de passe actuel (ré-authentification) et nouveau, répété. Les sessions restent
 * ouvertes ; `otherSessions` dit combien d'autres le sont, pour proposer de les fermer (ASVS 7.4.3).
 */
export function usePasswordChange() {
  const busy = ref(false);
  const failure = ref<string | null>(null);
  const done = ref(false);
  const otherSessions = ref(0);

  async function change(currentPassword: string, newPassword: string, repeated: string): Promise<boolean> {
    failure.value = null;
    done.value = false;
    if (newPassword !== repeated) {
      failure.value = 'account.password.mismatch';
      return false;
    }
    busy.value = true;
    const result = await call(() => getApi().POST('/api/me/password', { body: withPassword({ new_password: newPassword }, currentPassword) }));
    busy.value = false;
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    otherSessions.value = result.data.other_sessions;
    done.value = true;
    return true;
  }

  return { busy: readonly(busy), failure: readonly(failure), done: readonly(done), otherSessions: readonly(otherSessions), change };
}

/** Fermeture des autres sessions proposée après un changement de facteur (`DELETE /api/me/sessions`, la courante reste). */
export function useCloseOtherSessions() {
  const busy = ref(false);
  const failure = ref<string | null>(null);
  const closed = ref(false);

  async function close(): Promise<boolean> {
    busy.value = true;
    failure.value = null;
    const result = await call<undefined>(() => getApi().DELETE('/api/me/sessions'));
    busy.value = false;
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    closed.value = true;
    return true;
  }

  return { busy: readonly(busy), failure: readonly(failure), closed: readonly(closed), close };
}

/** Sessions d'interface ouvertes de l'appelant : lister, fermer une, fermer toutes les autres (13 § 5, 7.5.2). */
export function useMySessions() {
  const resource = useResource<Schemas['AuthSessionList']>(() => call(() => getApi().GET('/api/me/sessions')));
  const failure = ref<string | null>(null);
  const sessions = computed(() => resource.data.value?.sessions ?? []);

  async function close(id: string): Promise<boolean> {
    failure.value = null;
    const result = await call<undefined>(() => getApi().DELETE('/api/me/sessions/{id}', { params: { path: { id } } }));
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    await resource.reload();
    return true;
  }

  async function closeOthers(): Promise<boolean> {
    failure.value = null;
    const result = await call<undefined>(() => getApi().DELETE('/api/me/sessions'));
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    await resource.reload();
    return true;
  }

  return { ...resource, sessions, actionFailure: failure, close, closeOthers };
}

/** Identités SSO liées : lister, lier après ré-authentification (redirection chez le fournisseur), délier. */
export function useIdentities() {
  const resource = useResource<Schemas['LinkedIdentityList']>(() => call(() => getApi().GET('/api/me/identities')));
  const failure = ref<string | null>(null);
  const identities = computed(() => resource.data.value?.identities ?? []);

  /** Renvoie l'URL d'autorisation à ouvrir ; le retour du fournisseur lie l'identité (`/api/auth/oidc/callback`). */
  async function startLink(currentPassword: string, code: string): Promise<string | null> {
    failure.value = null;
    const body: Schemas['OidcLinkRequest'] = {};
    if (currentPassword) body.current_password = currentPassword;
    if (code) body.code = code;
    const result = await call(() => getApi().POST('/api/me/identities/oidc', { body }));
    if (!result.ok) {
      failure.value = result.messageKey;
      return null;
    }
    return result.data.authorization_url;
  }

  async function unlink(id: string): Promise<boolean> {
    failure.value = null;
    const result = await call<undefined>(() => getApi().DELETE('/api/me/identities/{id}', { params: { path: { id } } }));
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    await resource.reload();
    return true;
  }

  return { ...resource, identities, actionFailure: failure, startLink, unlink };
}

/** Activité récente du compte (`GET /api/me/audit`, tous les rôles lisent leurs propres événements). */
export function useMyAudit() {
  return usePagedList<Schemas['AuditEvent']>(async (cursor) => {
    const data = unwrap(await getApi().GET('/api/me/audit', { params: { query: { ...(cursor ? { cursor } : {}), limit: 10 } } }));
    return { items: data.events, nextCursor: data.next_cursor };
  });
}
