// SPDX-License-Identifier: AGPL-3.0-only
// « Tous les runs » (06 § 2) : vue transversale filtrable par API, état, déclencheur et période, à pagination serveur
// (curseur opaque, jamais d'index de page). Métadonnées seules : état, coût, durée, jamais le contenu d'un run d'autrui
// (INV12). Aucune logique de droit ici : c'est le serveur qui filtre par `owner_id`.
import type { components, paths } from '@runtime/client';
import { computed, reactive, readonly, ref } from 'vue';
import { call } from '@/lib/api-call';
import { getApi } from '@/lib/api';

type Schemas = components['schemas'];
type RunsQuery = NonNullable<paths['/api/runs']['get']['parameters']['query']>;
export type RunSummary = Schemas['RunSummary'];
export type RunState = Schemas['RunState'];
export type RunTrigger = Schemas['RunTrigger'];

export const RUN_STATES: readonly RunState[] = [
  'queued',
  'running',
  'waiting_tunnel',
  'succeeded',
  'failed',
  'cancelled',
  'skipped_tunnel_offline',
  'skipped_window',
  'skipped_quota',
  'skipped_status',
  'skipped_overlap',
];
export const RUN_TRIGGERS: readonly RunTrigger[] = ['mcp', 'rest', 'schedule', 'ui', 'canary'];

export interface RunFilters {
  /** Slug de l'API (vide : toutes). */
  api: string;
  state: RunState | '';
  trigger: RunTrigger | '';
  /** Jour local `AAAA-MM-JJ` (vide : sans borne). */
  since: string;
  until: string;
}

export const PAGE_SIZE = 25;

const emptyFilters = (): RunFilters => ({ api: '', state: '', trigger: '', since: '', until: '' });

/** Début du jour local en ISO 8601 UTC ; null si la date est illisible. */
function startOfDay(day: string): string | null {
  const date = new Date(`${day}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function endOfDay(day: string): string | null {
  const date = new Date(`${day}T23:59:59.999`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Paramètres de requête de la liste : seuls les filtres renseignés sont envoyés. */
export function runQuery(filters: RunFilters, cursor: string | undefined): RunsQuery {
  return {
    api: filters.api.trim() || undefined,
    state: filters.state || undefined,
    trigger: filters.trigger || undefined,
    since: filters.since ? (startOfDay(filters.since) ?? undefined) : undefined,
    until: filters.until ? (endOfDay(filters.until) ?? undefined) : undefined,
    cursor,
    limit: PAGE_SIZE,
  };
}

export function useRuns() {
  const filters = reactive<RunFilters>(emptyFilters());
  const runs = ref<RunSummary[]>([]);
  const loading = ref(false);
  /** Clé i18n de l'erreur de chargement. */
  const failure = ref<string | null>(null);
  const nextCursor = ref<string | null>(null);
  /** Curseurs des pages précédentes (le premier est `undefined` : première page). */
  const history = ref<(string | undefined)[]>([]);
  const currentCursor = ref<string | undefined>(undefined);
  let sequence = 0;

  async function load(cursor: string | undefined): Promise<void> {
    const mine = ++sequence;
    loading.value = true;
    failure.value = null;
    const query = runQuery(filters, cursor);
    const result = await call<Schemas['RunList']>(() => getApi().GET('/api/runs', { params: { query } }));
    if (mine !== sequence) return; // une requête plus récente a pris la place
    loading.value = false;
    if (!result.ok) {
      failure.value = result.messageKey;
      return;
    }
    runs.value = result.data.runs;
    nextCursor.value = result.data.next_cursor;
    currentCursor.value = cursor;
  }

  /** Recharge depuis la première page (ouverture, changement de filtre). */
  function apply(): Promise<void> {
    history.value = [];
    return load(undefined);
  }

  function refresh(): Promise<void> {
    return load(currentCursor.value);
  }

  async function next(): Promise<void> {
    if (!nextCursor.value || loading.value) return;
    const cursor = nextCursor.value;
    history.value = [...history.value, currentCursor.value];
    await load(cursor);
  }

  async function previous(): Promise<void> {
    if (history.value.length === 0 || loading.value) return;
    const stack = [...history.value];
    const cursor = stack.pop();
    history.value = stack;
    await load(cursor);
  }

  function reset(): Promise<void> {
    Object.assign(filters, emptyFilters());
    return apply();
  }

  return {
    filters,
    runs,
    loading: readonly(loading),
    failure: readonly(failure),
    hasNext: computed(() => nextCursor.value !== null),
    hasPrevious: computed(() => history.value.length > 0),
    pageNumber: computed(() => history.value.length + 1),
    apply,
    refresh,
    next,
    previous,
    reset,
  };
}
