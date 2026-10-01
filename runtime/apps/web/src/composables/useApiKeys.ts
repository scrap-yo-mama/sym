// SPDX-License-Identifier: AGPL-3.0-only
// Clés d'API à scopes et à expiration (06 § 2, 13 § 8) : créer (ré-authentification), lister sans aucun secret, révoquer. Le
// secret d'une clé n'existe que dans la réponse de création : il est montré une fois, copiable, puis effacé de la mémoire de
// l'écran (INV8, « une clé ne s'affiche qu'une fois »). Les scopes limitent les actions, le propriétaire limite les données.
import type { components } from '@runtime/client';
import { computed, ref, shallowRef } from 'vue';
import { useResource } from '@/composables/useResource';
import { call } from '@/lib/api-call';
import { getApi } from '@/lib/api';

type Schemas = components['schemas'];
export type ApiKey = Schemas['ApiKey'];
export type ApiKeyScope = Schemas['ApiKeyScope'];
export const API_KEY_SCOPES: readonly ApiKeyScope[] = ['apis:read', 'apis:run', 'apis:write', 'runs:read', 'datasets:read', 'schedules:write', 'sites:read'];
/** Durée par défaut d'une clé (13 § 8) : 90 jours. */
export const DEFAULT_KEY_DAYS = 90;

export type KeyState = 'active' | 'revoked' | 'expired';

/** État affiché d'une clé : révoquée, expirée (à `now`) ou active. */
export function keyState(key: Pick<ApiKey, 'revokedAt' | 'expiresAt'>, now: number = Date.now()): KeyState {
  if (key.revokedAt) return 'revoked';
  return new Date(key.expiresAt).getTime() <= now ? 'expired' : 'active';
}

export function useApiKeys() {
  const resource = useResource<{ items: ApiKey[] }>(() => call(() => getApi().GET('/api/api-keys')));
  const keys = computed(() => resource.data.value?.items ?? []);
  const busy = ref(false);
  const failure = ref<string | null>(null);
  /** Secret de la clé qui vient d'être créée : montré une fois, effacé par `dismissCreated`. */
  const created = shallowRef<{ label: string; key: string } | null>(null);

  async function create(input: { label: string; scopes: ApiKeyScope[]; expiresInDays: number | null; currentPassword: string }): Promise<boolean> {
    busy.value = true;
    failure.value = null;
    const body: Schemas['ApiKeyCreate'] = { label: input.label, scopes: input.scopes };
    if (input.expiresInDays !== null) body.expiresInDays = input.expiresInDays;
    if (input.currentPassword) body.currentPassword = input.currentPassword;
    const result = await call(() => getApi().POST('/api/api-keys', { body }));
    busy.value = false;
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    created.value = { label: result.data.label, key: result.data.key };
    await resource.reload();
    return true;
  }

  async function revoke(id: string): Promise<boolean> {
    failure.value = null;
    const result = await call<undefined>(() => getApi().DELETE('/api/api-keys/{id}', { params: { path: { id } } }));
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    await resource.reload();
    return true;
  }

  return { ...resource, keys, busy, failure, created, create, revoke, dismissCreated: () => void (created.value = null) };
}
