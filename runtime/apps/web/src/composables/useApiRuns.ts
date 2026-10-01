// SPDX-License-Identifier: AGPL-3.0-only
// Onglet « Runs & datasets » (06 § 2) : historique paginé des runs d'une API (métadonnées seulement) et items du dataset
// d'un run, pour la vue Table (champs absents marqués). L'export JSON ou CSV passe par la route de flux du serveur, qui
// neutralise les cellules (08b) ; la console ne fabrique jamais le fichier elle-même.
import type { components } from '@runtime/client';
import { ref, toValue, type MaybeRefOrGetter } from 'vue';
import { useLiveRefresh } from '@/composables/useLiveRefresh';
import { usePagedList } from '@/composables/usePagedList';
import { getApi } from '@/lib/api';
import { ApiRequestError, toRequestError, unwrap } from '@/lib/api-result';

export type RunSummary = components['schemas']['RunSummary'];

export function useApiRuns(slug: MaybeRefOrGetter<string>, options: { immediate?: boolean } = {}) {
  const list = usePagedList<RunSummary>(async (cursor) => {
    const page = unwrap(await getApi().GET('/api/runs', { params: { query: { api: toValue(slug), ...(cursor ? { cursor } : {}), limit: 25 } } }));
    return { items: page.runs, nextCursor: page.next_cursor };
  }, options);

  // Un run qui se termine ou change l'état de l'API rafraîchit l'historique.
  useLiveRefresh(() => list.refetch(), { events: ['status.changed', 'attempt.finished'] });

  const items = ref<Record<string, unknown>[]>([]);
  const itemsLoading = ref(false);
  const itemsError = ref<ApiRequestError | null>(null);
  const itemsNext = ref<string | null>(null);
  let datasetId: string | null = null;

  /** Items du dataset d'un run (page suivante comprise quand `more` est vrai). */
  async function loadItems(dataset: string, more = false): Promise<void> {
    itemsLoading.value = true;
    itemsError.value = null;
    try {
      const after = more && datasetId === dataset ? itemsNext.value : null;
      const page = unwrap(await getApi().GET('/api/datasets/{id}/items', { params: { path: { id: dataset }, query: { format: 'json', limit: 50, ...(after ? { after } : {}) } } }));
      // La route répond aussi en NDJSON ou CSV (texte) selon `format` ; la console ne demande que du JSON.
      if (typeof page === 'string') throw new ApiRequestError(0, null);
      items.value = after ? [...items.value, ...page.items] : page.items;
      itemsNext.value = page.next_cursor;
      datasetId = dataset;
    } catch (cause) {
      itemsError.value = toRequestError(cause);
    } finally {
      itemsLoading.value = false;
    }
  }

  return {
    runs: list.items,
    loading: list.loading,
    loadingMore: list.loadingMore,
    error: list.error,
    hasMore: list.hasMore,
    loadMore: list.loadMore,
    refetch: list.refetch,
    items,
    itemsLoading,
    itemsError,
    itemsHasMore: () => itemsNext.value !== null,
    loadItems,
  };
}

/** Adresse d'export d'un dataset (flux JSON, NDJSON ou CSV à cellules neutralisées, rendu par le serveur). */
export function datasetExportUrl(datasetId: string, format: 'json' | 'csv'): string {
  return `/api/datasets/${encodeURIComponent(datasetId)}/items?format=${format}`;
}
