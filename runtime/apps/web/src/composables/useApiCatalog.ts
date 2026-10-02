// SPDX-License-Identifier: AGPL-3.0-only
// Catalogue (06 § 2) : tableau à pagination serveur (curseurs), filtres par statut, exécution et réseau, recherche plein
// texte. Rafraîchi toutes les 15 s et à chaque changement de statut annoncé par le flux SSE (06 § 3). Seul le changement
// de statut d'une ligne est annoncé aux lecteurs d'écran (région `status` du plan de 06 § 3).
import type { components } from '@runtime/client';
import { useDebounceFn } from '@vueuse/core';
import { computed, nextTick, reactive, readonly, ref, shallowRef, watch } from 'vue';
import { useAsyncResource } from '@/composables/useAsyncResource';
import { useLiveRefresh } from '@/composables/useLiveRefresh';
import { getApi } from '@/lib/api';
import { unwrap } from '@/lib/api-result';
import { ATTENTION_STATUSES, type PillId } from '@/lib/catalog-health';

export type ApiSummary = components['schemas']['ApiSummary'];
export type Execution = components['schemas']['Execution'];
export type Network = components['schemas']['Network'];
type ApiStatus = components['schemas']['ApiStatus'];

const CATALOG_PAGE_SIZE = 25;
export const CATALOG_POLL_MS = 15_000;

/** `attention` : la pastille « À traiter » (à surveiller, en erreur, action requise) ; exclusive du filtre de statut précis. */
export type CatalogFilters = { status: ApiStatus | ''; execution: Execution | ''; network: Network | ''; q: string; attention: boolean };

/** Pas de pagination pour « À traiter » : trois lectures au plus grand pas de l'API, fusionnées (l'ensemble à traiter reste petit). */
const ATTENTION_PAGE_SIZE = 200;

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

export function useApiCatalog(options: { pollMs?: number; searchDebounceMs?: number; immediate?: boolean } = {}) {
  const filters = reactive<CatalogFilters>({ status: '', execution: '', network: '', q: '', attention: false });
  /** Curseur de chaque page visitée ; la page courante est la dernière (`null` : première page). */
  const cursors = ref<(string | null)[]>([null]);
  const lastChanges = ref<StatusChange[]>([]);
  /** API dont l'utilisateur vient d'agir (transition 17) : la ligne dit « Reprise de l'enquête… » tant que l'enquête est en cours. */
  const resuming = shallowRef<ReadonlySet<string>>(new Set());
  /** « Suspendre le suivi » (WCAG 2.2.2) : plus de relecture automatique ni d'annonce ; la reprise relit une fois. */
  const suspended = ref(false);
  let rows: ApiSummary[] = [];

  const resource = useAsyncResource(
    async () => {
      const shared = {
        ...(filters.execution ? { execution: filters.execution } : {}),
        ...(filters.network ? { network: filters.network } : {}),
        ...(filters.q.trim() ? { q: filters.q.trim() } : {}),
      };
      let page: { apis: ApiSummary[]; next_cursor: string | null };
      if (filters.attention) {
        // « À traiter » : une lecture par statut à traiter, fusionnées par nom (le serveur filtre un seul statut à la fois).
        const parts = await Promise.all(
          ATTENTION_STATUSES.map(async (status) => unwrap(await getApi().GET('/api/apis', { params: { query: { ...shared, status, limit: ATTENTION_PAGE_SIZE } } }))),
        );
        page = { apis: parts.flatMap((part) => part.apis).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)), next_cursor: null };
      } else {
        const query = {
          ...(filters.status ? { status: filters.status } : {}),
          ...shared,
          ...(cursors.value.at(-1) ? { cursor: cursors.value.at(-1) as string } : {}),
          limit: CATALOG_PAGE_SIZE,
        };
        page = unwrap(await getApi().GET('/api/apis', { params: { query } }));
      }
      lastChanges.value = statusChanges(rows, page.apis);
      const next = new Set(resuming.value);
      for (const change of lastChanges.value) if (change.from === 'action_requise' && change.to === 'enquete') next.add(change.slug);
      for (const slug of next) if (page.apis.find((row) => row.slug === slug)?.status !== 'enquete') next.delete(slug);
      resuming.value = next;
      rows = page.apis;
      return page;
    },
    { immediate: options.immediate ?? true },
  );

  const resetToFirstPage = () => {
    cursors.value = [null];
    rows = [];
    lastChanges.value = [];
    void resource.refetch();
  };
  const searchSoon = useDebounceFn(resetToFirstPage, options.searchDebounceMs ?? 300);
  /** Vrai dès que l'utilisateur a touché à un filtre : l'ouverture sur « À traiter » (u3 R16) ne le déplace plus. */
  const touched = ref(false);
  let programmatic = false;
  watch(
    () => [filters.status, filters.execution, filters.network, filters.attention],
    () => {
      if (programmatic) programmatic = false;
      else touched.value = true;
      resetToFirstPage();
    },
  );
  // Un statut précis choisi dans la liste remplace la pastille « À traiter ».
  watch(
    () => filters.status,
    (status) => {
      if (status !== '') filters.attention = false;
    },
    { flush: 'sync' },
  );
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

  const hasActiveFilter = computed(() => filters.status !== '' || filters.execution !== '' || filters.network !== '' || filters.q.trim() !== '' || filters.attention);

  /**
   * Choisit une pastille-filtre : « Tout » vide le statut, « À traiter » active le regroupement, « Saines » et « Arrêts
   * volontaires » filtrent `sain` et `bloquee`. `user: false` : ouverture automatique sur « À traiter », qui ne compte pas
   * comme un choix de l'utilisateur.
   */
  function setPill(pill: PillId, { user = true }: { user?: boolean } = {}): void {
    if (!user) {
      programmatic = true;
      // Le drapeau tombe après le tour de réactivité même si aucun filtre n'a changé.
      void nextTick(() => {
        programmatic = false;
      });
    }
    filters.attention = pill === 'attention';
    filters.status = pill === 'healthy' ? 'sain' : pill === 'stopped' ? 'bloquee' : '';
  }

  return {
    filters,
    touched: readonly(touched),
    resuming,
    setPill,
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
