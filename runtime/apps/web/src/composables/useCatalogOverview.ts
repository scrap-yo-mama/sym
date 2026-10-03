// SPDX-License-Identifier: AGPL-3.0-only
// Vue d'ensemble du catalogue (20 § 5.2) : comptes par statut de TOUTES les API du propriétaire, indépendants des filtres et de
// la pagination du tableau. Alimente la phrase de synthèse, la barre de santé et les compteurs des pastilles-filtres.
// L'API REST n'a pas de route de comptage : la console relit le catalogue sans filtre, par pages de 200 (au plus 5, soit
// 1 000 API ; au-delà, `truncated` est vrai et les comptes sont dits partiels). Rafraîchie comme le tableau (15 s, flux SSE),
// et seule la variation d'un compteur de pastille est annoncée (région `status`, `assert_attention_filters_counts`).
import { computed, ref, shallowRef } from 'vue';
import { useAsyncResource } from '@/composables/useAsyncResource';
import { useLiveRefresh } from '@/composables/useLiveRefresh';
import { getApi } from '@/lib/api';
import { unwrap } from '@/lib/api-result';
import { catalogHealth, countByStatus, countChanges, pillCounts, type PillCounts, type StatusCounts } from '@/lib/catalog-health';
import type { ApiStatus } from '@/lib/status';

const OVERVIEW_PAGE_SIZE = 200;
const OVERVIEW_MAX_PAGES = 5;

export type OverviewSnapshot = { counts: StatusCounts; truncated: boolean };
export type PillChange = ReturnType<typeof countChanges>[number];

export function useCatalogOverview(options: { pollMs?: number; immediate?: boolean; suspended?: () => boolean } = {}) {
  const lastPills = shallowRef<PillCounts | null>(null);
  const changes = ref<PillChange[]>([]);

  const resource = useAsyncResource(
    async (): Promise<OverviewSnapshot> => {
      const statuses: { status: ApiStatus }[] = [];
      let cursor: string | null = null;
      let truncated = false;
      for (let page = 0; page < OVERVIEW_MAX_PAGES; page += 1) {
        const query: { limit: number; cursor?: string } = { limit: OVERVIEW_PAGE_SIZE, ...(cursor ? { cursor } : {}) };
        const part = unwrap(await getApi().GET('/api/apis', { params: { query } }));
        for (const api of part.apis) statuses.push({ status: api.status });
        cursor = part.next_cursor;
        if (!cursor) break;
        if (page === OVERVIEW_MAX_PAGES - 1) truncated = true;
      }
      const counts = countByStatus(statuses);
      const next = pillCounts(counts);
      changes.value = countChanges(lastPills.value, next);
      lastPills.value = next;
      return { counts, truncated };
    },
    { immediate: options.immediate ?? true },
  );

  useLiveRefresh(() => resource.refetch({ silent: true }), {
    pollMs: options.pollMs ?? 15_000,
    events: ['status.changed', 'action.required'],
    ...(options.suspended ? { paused: options.suspended } : {}),
  });

  return {
    snapshot: resource.data,
    error: resource.error,
    loading: resource.loading,
    refetch: resource.refetch,
    /** Santé du catalogue ; nulle tant qu'aucune lecture n'est revenue. */
    health: computed(() => (resource.data.value ? catalogHealth(resource.data.value.counts) : null)),
    pills: computed((): PillCounts | null => (resource.data.value ? pillCounts(resource.data.value.counts) : null)),
    /** Pastilles dont le compteur a changé à la dernière lecture. */
    changes,
  };
}
