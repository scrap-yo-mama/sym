// SPDX-License-Identifier: AGPL-3.0-only
// Onglet « Bugs & statut » (06 § 2) : chronologie des transitions de statut (raison et run lié) ; les erreurs sont
// regroupées par `failure_class` à partir des runs de l'API. Regroupement = comptage d'affichage, pas une règle métier.
import type { components } from '@runtime/client';
import { toValue, type MaybeRefOrGetter } from 'vue';
import { useLiveRefresh } from '@/composables/useLiveRefresh';
import { usePagedList } from '@/composables/usePagedList';
import { getApi } from '@/lib/api';
import { unwrap } from '@/lib/api-result';

export type StatusEvent = components['schemas']['StatusEvent'];
export type RunSummary = components['schemas']['RunSummary'];

export function useStatusEvents(slug: MaybeRefOrGetter<string>, options: { immediate?: boolean } = {}) {
  const events = usePagedList<StatusEvent>(async (cursor) => {
    const page = unwrap(await getApi().GET('/api/apis/{slug}/status-events', { params: { path: { slug: toValue(slug) }, query: { ...(cursor ? { cursor } : {}), limit: 25 } } }));
    return { items: page.events, nextCursor: page.next_cursor };
  }, options);
  useLiveRefresh(() => events.refetch(), { events: ['status.changed'] });
  return { events: events.items, loading: events.loading, loadingMore: events.loadingMore, error: events.error, hasMore: events.hasMore, loadMore: events.loadMore, refetch: events.refetch };
}

/** Erreurs regroupées par `failure_class` (runs en échec ou dégradés), la classe la plus fréquente d'abord. */
export function groupFailures(runs: readonly RunSummary[]): { failureClass: string; count: number; lastRunId: string }[] {
  const groups = new Map<string, { count: number; lastRunId: string; lastAt: string }>();
  for (const run of runs) {
    if (!run.failure_class) continue;
    const group = groups.get(run.failure_class);
    if (!group) groups.set(run.failure_class, { count: 1, lastRunId: run.id, lastAt: run.created_at });
    else {
      group.count += 1;
      if (run.created_at > group.lastAt) {
        group.lastAt = run.created_at;
        group.lastRunId = run.id;
      }
    }
  }
  return [...groups].map(([failureClass, { count, lastRunId }]) => ({ failureClass, count, lastRunId })).sort((a, b) => b.count - a.count || a.failureClass.localeCompare(b.failureClass));
}
