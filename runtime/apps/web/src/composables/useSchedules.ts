// SPDX-License-Identifier: AGPL-3.0-only
// Onglet « Planifications » (06 § 2, 08 § 5) : liste et création. Les prochaines exécutions sont calculées par le
// serveur ; la validation (fréquence minimale d'une minute, fuseau, entrée) aussi : une erreur arrive en code stable.
import type { components } from '@runtime/client';
import { ref, toValue, type MaybeRefOrGetter } from 'vue';
import { useAsyncResource } from '@/composables/useAsyncResource';
import { getApi } from '@/lib/api';
import { toRequestError, unwrap, type ApiRequestError } from '@/lib/api-result';

export type ScheduleWrite = components['schemas']['ScheduleWrite'];

export function useSchedules(slug: MaybeRefOrGetter<string>, options: { immediate?: boolean } = {}) {
  const resource = useAsyncResource(async () => unwrap(await getApi().GET('/api/apis/{slug}/schedules', { params: { path: { slug: toValue(slug) } } })).schedules, options);
  const saving = ref(false);
  const saveError = ref<ApiRequestError | null>(null);

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    saving.value = true;
    saveError.value = null;
    try {
      await action();
      await resource.refetch({ silent: true });
      return true;
    } catch (cause) {
      saveError.value = toRequestError(cause);
      return false;
    } finally {
      saving.value = false;
    }
  }

  return {
    schedules: resource.data,
    loading: resource.loading,
    error: resource.error,
    refetch: resource.refetch,
    saving,
    saveError,
    create: (body: ScheduleWrite) => run(async () => unwrap(await getApi().POST('/api/apis/{slug}/schedules', { params: { path: { slug: toValue(slug) } }, body }))),
    setEnabled: (id: string, enabled: boolean) => run(async () => unwrap(await getApi().PATCH('/api/apis/{slug}/schedules/{id}', { params: { path: { slug: toValue(slug), id } }, body: { enabled } }))),
    remove: (id: string) => run(async () => unwrap(await getApi().DELETE('/api/apis/{slug}/schedules/{id}', { params: { path: { slug: toValue(slug), id } } }))),
  };
}
