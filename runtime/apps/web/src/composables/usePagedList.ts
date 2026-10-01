// SPDX-License-Identifier: AGPL-3.0-only
// Liste à curseur serveur avec « Charger la suite » : versions, runs, transitions de statut. Les éléments déjà chargés
// restent affichés pendant le chargement de la suite ; une relecture repart de la première page.
import { tryOnMounted } from '@vueuse/core';
import { computed, readonly, ref, shallowRef } from 'vue';
import { toRequestError, type ApiRequestError } from '@/lib/api-result';

export type Page<T> = { items: T[]; nextCursor: string | null };

export function usePagedList<T>(fetchPage: (cursor: string | null) => Promise<Page<T>>, options: { immediate?: boolean } = {}) {
  const items = shallowRef<T[]>([]);
  const loading = ref(false);
  const loadingMore = ref(false);
  const error = shallowRef<ApiRequestError | null>(null);
  const nextCursor = ref<string | null>(null);
  const loaded = ref(false);
  let ticket = 0;

  async function load(cursor: string | null): Promise<void> {
    const mine = ++ticket;
    const more = cursor !== null;
    (more ? loadingMore : loading).value = true;
    error.value = null;
    try {
      const page = await fetchPage(cursor);
      if (mine !== ticket) return;
      items.value = more ? [...items.value, ...page.items] : page.items;
      nextCursor.value = page.nextCursor;
      loaded.value = true;
    } catch (cause) {
      if (mine === ticket) error.value = toRequestError(cause);
    } finally {
      if (mine === ticket) (more ? loadingMore : loading).value = false;
    }
  }

  if (options.immediate !== false) tryOnMounted(() => void load(null));

  return {
    items: computed(() => items.value),
    loading: readonly(loading),
    loadingMore: readonly(loadingMore),
    error: computed(() => error.value),
    loaded: readonly(loaded),
    hasMore: () => nextCursor.value !== null,
    refetch: () => load(null),
    loadMore: () => (nextCursor.value === null ? Promise.resolve() : load(nextCursor.value)),
  };
}
