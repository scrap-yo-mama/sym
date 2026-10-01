// SPDX-License-Identifier: AGPL-3.0-only
// Fiche d'une API (06 § 2) : fiche REST, rafraîchie par le flux SSE. Porte aussi l'état du bandeau « Action requise » :
// quand l'utilisateur agit et que l'API repasse en enquête (transition 17), le bandeau devient « Reprise de l'enquête… »
// au lieu de disparaître, puis s'efface quand l'enquête se termine, sans rechargement de la page.
import type { components } from '@runtime/client';
import { computed, ref, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useAsyncResource } from '@/composables/useAsyncResource';
import { useLiveRefresh } from '@/composables/useLiveRefresh';
import { getApi } from '@/lib/api';
import { unwrap } from '@/lib/api-result';
import type { SseEvent } from '@/lib/sse';

export type ApiDetail = components['schemas']['ApiDetail'];

/** Vrai si la trame du flux concerne cette API (charge JSON avec `slug` ou `api_slug`), ou si elle ne dit pas laquelle. */
export function eventConcernsApi(event: SseEvent, slug: string): boolean {
  try {
    const body: unknown = JSON.parse(event.data);
    if (typeof body !== 'object' || body === null) return true;
    const record = body as Record<string, unknown>;
    const named = record.api_slug ?? record.slug ?? (typeof record.payload === 'object' && record.payload !== null ? ((record.payload as Record<string, unknown>).api_slug ?? (record.payload as Record<string, unknown>).slug) : undefined);
    return typeof named !== 'string' || named === slug;
  } catch {
    return true;
  }
}

export function useApiDetail(slug: MaybeRefOrGetter<string>) {
  const resource = useAsyncResource(async () => unwrap(await getApi().GET('/api/apis/{slug}', { params: { path: { slug: toValue(slug) } } })));

  // Un changement d'API dans la route relit la fiche.
  watch(() => toValue(slug), () => void resource.refetch());

  useLiveRefresh(() => resource.refetch({ silent: true }), {
    events: ['status.changed', 'action.required', 'investigation.started', 'phase.started', 'schema.proposed', 'attempt.finished'],
    accepts: (event) => eventConcernsApi(event, toValue(slug)),
  });

  /** Vrai entre la reprise de l'enquête (action_requise → enquete) et la fin de cette enquête. */
  const resuming = ref(false);
  let previousStatus: string | null = null;
  watch(
    () => resource.data.value?.status ?? null,
    (status) => {
      if (status === 'enquete' && previousStatus === 'action_requise') resuming.value = true;
      else if (status !== 'enquete') resuming.value = false;
      previousStatus = status;
    },
    { immediate: true },
  );
  // Une autre API ne reprend pas l'état de la précédente.
  watch(() => toValue(slug), () => {
    resuming.value = false;
    previousStatus = null;
  });

  return {
    detail: resource.data,
    loading: resource.loading,
    error: resource.error,
    refetch: resource.refetch,
    setDetail: resource.set,
    resuming,
    isBlocked: computed(() => resource.data.value?.status === 'bloquee'),
  };
}
