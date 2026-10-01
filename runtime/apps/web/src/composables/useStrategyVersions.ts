// SPDX-License-Identifier: AGPL-3.0-only
// Onglet « Stratégie & versions » (06 § 2) : liste des versions, une version en lecture seule, et le diff à trois niveaux
// entre deux versions (phrase, tableau des champs, diff brut). La phrase et le tableau sont calculés par le serveur.
// `useRevertPreview` : l'aperçu de « Revenir à cette version » (diff de la version visée contre la courante), distinct
// du comparateur de l'onglet.
import type { components } from '@runtime/client';
import { computed, readonly, ref, toValue, type MaybeRefOrGetter } from 'vue';
import { usePagedList } from '@/composables/usePagedList';
import { getApi } from '@/lib/api';
import { toRequestError, unwrap, type ApiRequestError } from '@/lib/api-result';

export type StrategyVersionSummary = components['schemas']['StrategyVersionSummary'];
export type StrategyVersion = components['schemas']['StrategyVersion'];
export type StrategyDiff = components['schemas']['StrategyDiff'];

/** Diff à trois niveaux entre deux versions d'une API : une seule requête utile à la fois (la dernière l'emporte). */
function useStrategyDiff(slug: MaybeRefOrGetter<string>) {
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

  return { diff: computed(() => diff.value), diffLoading: computed(() => diffLoading.value), diffError: computed(() => diffError.value), loadDiff, clearDiff };
}

export function useStrategyVersions(slug: MaybeRefOrGetter<string>, options: { immediate?: boolean } = {}) {
  const list = usePagedList<StrategyVersionSummary>(async (cursor) => {
    const page = unwrap(await getApi().GET('/api/apis/{slug}/versions', { params: { path: { slug: toValue(slug) }, query: { ...(cursor ? { cursor } : {}), limit: 20 } } }));
    return { items: page.versions, nextCursor: page.next_cursor };
  }, options);
  const strategyDiff = useStrategyDiff(slug);

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
    ...strategyDiff,
    loadVersion,
  };
}

/**
 * « Revenir à cette version » n'existe que depuis `sain` (transition 7) ou `warning` (transition 8) : ce sont les seuls
 * retours de version de la machine à états (04 § 6). Une API `bloquee` n'a qu'une reprise, la ré-enquête manuelle
 * (transition 18, 06 § 2) ; les autres statuts n'ont aucune transition de retour.
 */
export function revertAllowed(status: components['schemas']['ApiStatus']): boolean {
  return status === 'sain' || status === 'warning';
}

/**
 * Aperçu de « Revenir à cette version » (06 § 2) : la version visée et son diff contre la version courante (ce qui
 * changera), avant toute confirmation. Sans version courante, l'aperçu se limite à la conséquence.
 */
export function useRevertPreview(slug: MaybeRefOrGetter<string>, current: MaybeRefOrGetter<number | null | undefined>) {
  const target = ref<number | null>(null);
  const strategyDiff = useStrategyDiff(slug);

  function start(version: number): void {
    target.value = version;
    const from = toValue(current);
    // Jamais l'aperçu d'une autre version pendant le chargement de celle-ci.
    strategyDiff.clearDiff();
    if (from && from !== version) void strategyDiff.loadDiff(version, from);
  }

  function cancel(): void {
    target.value = null;
    strategyDiff.clearDiff();
  }

  return { target: readonly(target), diff: strategyDiff.diff, diffLoading: strategyDiff.diffLoading, diffError: strategyDiff.diffError, start, cancel };
}
