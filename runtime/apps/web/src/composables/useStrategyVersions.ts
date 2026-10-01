// SPDX-License-Identifier: AGPL-3.0-only
// Onglet « Stratégie & versions » (06 § 2) : liste des versions, une version en lecture seule, et le diff à trois niveaux
// entre deux versions (phrase, tableau des champs, diff brut). La phrase et le tableau sont calculés par le serveur.
import type { components } from '@runtime/client';
import { computed, ref, toValue, type MaybeRefOrGetter } from 'vue';
import { usePagedList } from '@/composables/usePagedList';
import { getApi } from '@/lib/api';
import { toRequestError, unwrap, type ApiRequestError } from '@/lib/api-result';

export type StrategyVersionSummary = components['schemas']['StrategyVersionSummary'];
export type StrategyVersion = components['schemas']['StrategyVersion'];
export type StrategyDiff = components['schemas']['StrategyDiff'];

export function useStrategyVersions(slug: MaybeRefOrGetter<string>, options: { immediate?: boolean } = {}) {
  const list = usePagedList<StrategyVersionSummary>(async (cursor) => {
    const page = unwrap(await getApi().GET('/api/apis/{slug}/versions', { params: { path: { slug: toValue(slug) }, query: { ...(cursor ? { cursor } : {}), limit: 20 } } }));
    return { items: page.versions, nextCursor: page.next_cursor };
  }, options);

  const diff = ref<StrategyDiff | null>(null);
  const diffLoading = ref(false);
  const diffError = ref<ApiRequestError | null>(null);
  let ticket = 0;

  /** Diff de `version` contre `against` (niveau 1 phrase, niveau 2 champs, niveau 3 brut). */
  async function loadDiff(version: number, against: number): Promise<void> {
    const mine = ++ticket;
    diffLoading.value = true;
    diffError.value = null;
    try {
      const result = unwrap(await getApi().GET('/api/apis/{slug}/versions/{version}/diff', { params: { path: { slug: toValue(slug), version }, query: { against } } }));
      if (mine === ticket) diff.value = result;
    } catch (cause) {
      if (mine === ticket) {
        diff.value = null;
        diffError.value = toRequestError(cause);
      }
    } finally {
      if (mine === ticket) diffLoading.value = false;
    }
  }

  function clearDiff(): void {
    ticket += 1;
    diff.value = null;
    diffError.value = null;
    diffLoading.value = false;
  }

  /** Une version en lecture seule : spécification déclarative ou référence de script (jamais modifiable ici). */
  async function loadVersion(version: number): Promise<StrategyVersion> {
    return unwrap(await getApi().GET('/api/apis/{slug}/versions/{version}', { params: { path: { slug: toValue(slug), version } } }));
  }

  return {
    versions: list.items,
    loading: list.loading,
    loadingMore: list.loadingMore,
    error: list.error,
    hasMore: list.hasMore,
    loadMore: list.loadMore,
    refetch: list.refetch,
    diff: computed(() => diff.value),
    diffLoading: computed(() => diffLoading.value),
    diffError: computed(() => diffError.value),
    loadDiff,
    clearDiff,
    loadVersion,
  };
}
