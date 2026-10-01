// SPDX-License-Identifier: AGPL-3.0-only
// Catalogue (06 § 2) : tableau à pagination serveur (curseurs), filtres par statut, exécution et réseau, recherche plein
// texte. Rafraîchi toutes les 15 s et à chaque changement de statut annoncé par le flux SSE (06 § 3). Seul le changement
// de statut d'une ligne est annoncé aux lecteurs d'écran (région `status` du plan de 06 § 3).
import type { components } from '@runtime/client';
import { useDebounceFn } from '@vueuse/core';
import { computed, reactive, readonly, ref, watch } from 'vue';
import { useAsyncResource } from '@/composables/useAsyncResource';
import { useLiveRefresh } from '@/composables/useLiveRefresh';
import { getApi } from '@/lib/api';
import { unwrap } from '@/lib/api-result';

export type ApiSummary = components['schemas']['ApiSummary'];
export type Execution = components['schemas']['Execution'];
export type Network = components['schemas']['Network'];
type ApiStatus = components['schemas']['ApiStatus'];

const CATALOG_PAGE_SIZE = 25;
export const CATALOG_POLL_MS = 15_000;

export type CatalogFilters = { status: ApiStatus | ''; execution: Execution | ''; network: Network | ''; q: string };

/** Changement de statut d'une ligne entre deux lectures : c'est ce que la région `status` annonce. */
export type StatusChange = { slug: string; from: ApiStatus; to: ApiStatus };

export function statusChanges(before: readonly ApiSummary[], after: readonly ApiSummary[]): StatusChange[] {
  const previous = new Map(before.map((row) => [row.slug, row.status]));
  const changes: StatusChange[] = [];
  for (const row of after) {
    const from = previous.get(row.slug);
    if (from !== undefined && from !== row.status) changes.push({ slug: row.slug, from, to: row.status });
  }
  return changes;
}

export function useApiCatalog(options: { pollMs?: number; searchDebounceMs?: number } = {}) {
  const filters = reactive<CatalogFilters>({ status: '', execution: '', network: '', q: '' });
  /** Curseur de chaque page visitée ; la page courante est la dernière (`null` : première page). */
  const cursors = ref<(string | null)[]>([null]);
  const lastChanges = ref<StatusChange[]>([]);
  /** « Suspendre le suivi » (WCAG 2.2.2) : plus de relecture automatique ni d'annonce ; la reprise relit une fois. */
  const suspended = ref(false);
  let rows: ApiSummary[] = [];

  const resource = useAsyncResource(async () => {
    const query = {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.execution ? { execution: filters.execution } : {}),
      ...(filters.network ? { network: filters.network } : {}),
      ...(filters.q.trim() ? { q: filters.q.trim() } : {}),
      ...(cursors.value.at(-1) ? { cursor: cursors.value.at(-1) as string } : {}),
      limit: CATALOG_PAGE_SIZE,
    };
    const page = unwrap(await getApi().GET('/api/apis', { params: { query } }));
    lastChanges.value = statusChanges(rows, page.apis);
    rows = page.apis;
    return page;
  });

  const resetToFirstPage = () => {
    cursors.value = [null];
    rows = [];
    lastChanges.value = [];
    void resource.refetch();
  };
  const searchSoon = useDebounceFn(resetToFirstPage, options.searchDebounceMs ?? 300);
  watch(() => [filters.status, filters.execution, filters.network], resetToFirstPage);
  watch(() => filters.q, () => void searchSoon());

  useLiveRefresh(() => resource.refetch({ silent: true }), {
    pollMs: options.pollMs ?? CATALOG_POLL_MS,
    events: ['status.changed', 'action.required'],
    paused: () => suspended.value,
  });
  watch(suspended, (value) => {
    if (!value) void resource.refetch({ silent: true });
  });

  const nextCursor = computed(() => resource.data.value?.next_cursor ?? null);
  const hasPrevious = computed(() => cursors.value.length > 1);

  function next(): void {
    const cursor = nextCursor.value;
    if (!cursor) return;
    cursors.value = [...cursors.value, cursor];
    rows = [];
    void resource.refetch();
  }

  function previous(): void {
    if (!hasPrevious.value) return;
    cursors.value = cursors.value.slice(0, -1);
    rows = [];
    void resource.refetch();
  }

  const hasActiveFilter = computed(() => filters.status !== '' || filters.execution !== '' || filters.network !== '' || filters.q.trim() !== '');

  return {
    filters,
    suspended,
    apis: computed(() => resource.data.value?.apis ?? []),
    loading: resource.loading,
    error: resource.error,
    refetch: resource.refetch,
    next,
    previous,
    hasNext: computed(() => nextCursor.value !== null),
    hasPrevious,
    pageNumber: computed(() => cursors.value.length),
    hasActiveFilter,
    /** Changements de statut de la dernière lecture (annoncés une fois par la région `status`). */
    statusChanges: readonly(lastChanges),
  };
}
