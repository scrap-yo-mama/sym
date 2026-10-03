<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file SessionsView.vue
 * @description Écran Sessions (04d § 5.2, tâche 3.6) : onglets « En cours » et « Passées » (motif ARIA des onglets, flèches
 * gauche et droite, Début et Fin), filtres (état, type, clé, nœud, période, recherche par metadata) reflétés dans l'URL,
 * tableau légendé (identifiant, état, type, durée, octets, clé, création) et pagination par curseur (`GET /v1/sessions`).
 * États vide, sans résultat et erreur ; la suite chargée est annoncée.
 * @page
 */
import { SESSION_TYPES, type SessionState, type SessionType } from '@sym/contracts/browser';
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, useRoute, useRouter, type LocationQueryRaw } from 'vue-router';
import { CURRENT_STATES, PAST_STATES } from '../api/console.js';
import type { ConsoleSession, SessionQuery, SessionTab } from '../api/types.js';
import ConsoleButton from '../components/ConsoleButton.vue';
import ErrorAlert from '../components/ErrorAlert.vue';
import StatusBadge from '../components/StatusBadge.vue';
import SymMessage from '../components/SymMessage.vue';
import { useConsoleApi } from '../composables/console-api.js';
import { useLoad } from '../composables/load.js';
import { formatBytes, formatDate, formatDuration, sessionSeconds } from '../lib/format.js';

const { t, locale } = useI18n();
const api = useConsoleApi();
const route = useRoute();
const router = useRouter();

const METADATA = /^([A-Za-z0-9_.-]{1,64})=(.*)$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TABS: SessionTab[] = ['current', 'past'];

const one = (value: unknown): string => (typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : '');

type Filters = { tab: SessionTab; state: SessionState | ''; type: SessionType | ''; key: string; node: string; from: string; to: string; metadata: string };

/** Filtres lus dans l'URL (source de vérité : un lien partagé rouvre la même liste). */
const applied = computed((): Filters => {
  const q = route.query;
  const tab: SessionTab = one(q.tab) === 'past' ? 'past' : 'current';
  const states = tab === 'current' ? CURRENT_STATES : PAST_STATES;
  const state = one(q.state);
  return {
    tab,
    state: states.includes(state as SessionState) ? (state as SessionState) : '',
    type: SESSION_TYPES.includes(one(q.type) as SessionType) ? (one(q.type) as SessionType) : '',
    key: one(q.key),
    node: one(q.node),
    from: DAY.test(one(q.from)) ? one(q.from) : '',
    to: DAY.test(one(q.to)) ? one(q.to) : '',
    metadata: METADATA.test(one(q.metadata)) ? one(q.metadata) : '',
  };
});

function toQuery(f: Filters, cursor?: string): SessionQuery {
  const query: SessionQuery = { tab: f.tab };
  if (f.state) query.state = f.state;
  if (f.type) query.type = f.type;
  if (f.key) query.apiKeyId = f.key;
  if (f.node) query.nodeId = f.node;
  if (f.from) query.createdAfter = `${f.from}T00:00:00.000Z`;
  if (f.to) query.createdBefore = new Date(Date.parse(`${f.to}T00:00:00.000Z`) + 86_400_000).toISOString();
  const m = METADATA.exec(f.metadata);
  if (m) query.metadata = { key: m[1]!, value: m[2]! };
  if (cursor) query.cursor = cursor;
  return query;
}

const hasFilters = computed(() => Boolean(applied.value.state || applied.value.type || applied.value.key || applied.value.node || applied.value.from || applied.value.to || applied.value.metadata));

const first = useLoad(() => api.listSessions(toQuery(applied.value)));
const extra = ref<ConsoleSession[]>([]);
const extraCursor = ref<string | null | undefined>(undefined);
const moreLoading = ref(false);
const moreError = ref<string | null>(null);
const announcement = ref('');

const rows = computed(() => [...(first.data.value?.data ?? []), ...extra.value]);
const nextCursor = computed(() => (extraCursor.value === undefined ? (first.data.value?.nextCursor ?? null) : extraCursor.value));

watch(
  () => route.query,
  () => {
    extra.value = [];
    extraCursor.value = undefined;
    moreError.value = null;
    void first.reload();
  },
);

async function loadMore(): Promise<void> {
  const cursor = nextCursor.value;
  if (!cursor || moreLoading.value) return;
  moreLoading.value = true;
  const result = await api.listSessions(toQuery(applied.value, cursor));
  moreLoading.value = false;
  if (!result.ok) {
    moreError.value = result.code;
    return;
  }
  moreError.value = null;
  extra.value = [...extra.value, ...result.data.data];
  extraCursor.value = result.data.nextCursor;
  announcement.value = t('console.sessions.count', { count: rows.value.length });
}

// Options des filtres : clés et nœuds (une erreur ici laisse « Tous » seulement).
const keys = useLoad(() => api.listKeys());
const nodes = useLoad(() => api.listNodes());

/** Formulaire des filtres : copie modifiable des filtres appliqués. */
const form = reactive({ state: '', type: '', key: '', node: '', from: '', to: '', metadata: '' });
const metadataError = ref(false);
watch(
  applied,
  (f) => {
    Object.assign(form, { state: f.state, type: f.type, key: f.key, node: f.node, from: f.from, to: f.to, metadata: f.metadata });
    metadataError.value = false;
  },
  { immediate: true },
);
const stateOptions = computed(() => (applied.value.tab === 'current' ? CURRENT_STATES : PAST_STATES));

function queryOf(tab: SessionTab, f: { state: string; type: string; key: string; node: string; from: string; to: string; metadata: string; tab?: string }): LocationQueryRaw {
  const query: LocationQueryRaw = { tab };
  // `tab` vient du premier argument seulement : les filtres appliqués portent l'ancien onglet.
  for (const [name, value] of Object.entries(f)) if (value && name !== 'tab') query[name] = value;
  return query;
}

async function apply(): Promise<void> {
  const metadata = form.metadata.trim();
  if (metadata !== '' && !METADATA.test(metadata)) {
    metadataError.value = true;
    await nextTick();
    document.getElementById('filter-metadata')?.focus();
    return;
  }
  metadataError.value = false;
  await router.push({ query: queryOf(applied.value.tab, { ...form, metadata }) });
}

async function reset(): Promise<void> {
  await router.push({ query: { tab: applied.value.tab } });
}

// Onglets : activation automatique, focus mobile (un seul onglet dans l'ordre de tabulation).
const tabRefs = ref<HTMLElement[]>([]);
async function selectTab(tab: SessionTab, focus = false): Promise<void> {
  if (tab !== applied.value.tab) {
    // L'état filtré n'a de sens que dans son onglet : il est retiré au changement d'onglet.
    await router.replace({ query: queryOf(tab, { ...applied.value, state: '' }) });
  }
  if (focus) {
    await nextTick();
    tabRefs.value[TABS.indexOf(tab)]?.focus();
  }
}
function onTabKey(event: KeyboardEvent): void {
  const index = TABS.indexOf(applied.value.tab);
  const target = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
  if (target < 0) return;
  event.preventDefault();
  void selectTab(TABS[target]!, true);
}

const now = Date.now();
const duration = (s: ConsoleSession) => formatDuration(sessionSeconds(s, now), locale.value);
const bytes = (s: ConsoleSession) => formatBytes((s.usage?.bytesIn ?? 0) + (s.usage?.bytesOut ?? 0), locale.value);
</script>

<template>
  <section class="mx-auto flex w-full max-w-6xl flex-col gap-6" aria-labelledby="sessions-title">
    <h1 id="sessions-title" data-route-heading tabindex="-1" class="text-4xl">{{ t('console.sessions.title') }}</h1>

    <div role="tablist" :aria-label="t('console.sessions.tabs.label')" class="flex gap-2" @keydown="onTabKey">
      <button
        v-for="tab in TABS"
        :id="`tab-${tab}`"
        :key="tab"
        ref="tabRefs"
        type="button"
        role="tab"
        :aria-selected="applied.tab === tab ? 'true' : 'false'"
        aria-controls="sessions-panel"
        :tabindex="applied.tab === tab ? 0 : -1"
        class="min-h-11 rounded-full border border-border px-5 font-bold aria-selected:bg-nav aria-selected:text-nav-foreground"
        @click="selectTab(tab)"
      >
        {{ t(`console.sessions.tabs.${tab}`) }}
      </button>
    </div>

    <div id="sessions-panel" role="tabpanel" :aria-labelledby="`tab-${applied.tab}`" class="flex flex-col gap-6">
      <form class="rounded-xl border border-border bg-card p-4 text-card-foreground" novalidate @submit.prevent="apply">
        <fieldset class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <legend class="mb-2 font-display text-lg font-extrabold">{{ t('console.sessions.filters.legend') }}</legend>
          <div class="flex flex-col gap-1">
            <label for="filter-state" class="text-sm font-bold">{{ t('console.sessions.filters.state') }}</label>
            <select id="filter-state" v-model="form.state" class="min-h-11 rounded-md border border-input bg-background px-3">
              <option value="">{{ t('console.sessions.filters.any') }}</option>
              <option v-for="state in stateOptions" :key="state" :value="state">{{ t(`console.status.session.${state}`) }}</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <label for="filter-type" class="text-sm font-bold">{{ t('console.sessions.filters.type') }}</label>
            <select id="filter-type" v-model="form.type" class="min-h-11 rounded-md border border-input bg-background px-3">
              <option value="">{{ t('console.sessions.filters.any') }}</option>
              <option v-for="type in SESSION_TYPES" :key="type" :value="type">{{ t(`console.types.${type}`) }}</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <label for="filter-key" class="text-sm font-bold">{{ t('console.sessions.filters.key') }}</label>
            <select id="filter-key" v-model="form.key" class="min-h-11 rounded-md border border-input bg-background px-3">
              <option value="">{{ t('console.sessions.filters.any') }}</option>
              <option v-for="key in keys.data.value?.data ?? []" :key="key.id" :value="key.id">{{ key.name }} ({{ key.prefix }})</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <label for="filter-node" class="text-sm font-bold">{{ t('console.sessions.filters.node') }}</label>
            <select id="filter-node" v-model="form.node" class="min-h-11 rounded-md border border-input bg-background px-3">
              <option value="">{{ t('console.sessions.filters.any') }}</option>
              <option v-for="node in nodes.data.value?.data ?? []" :key="node.id" :value="node.id">{{ node.id }}</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <label for="filter-from" class="text-sm font-bold">{{ t('console.sessions.filters.from') }}</label>
            <input id="filter-from" v-model="form.from" type="date" class="min-h-11 rounded-md border border-input bg-background px-3" />
          </div>
          <div class="flex flex-col gap-1">
            <label for="filter-to" class="text-sm font-bold">{{ t('console.sessions.filters.to') }}</label>
            <input id="filter-to" v-model="form.to" type="date" class="min-h-11 rounded-md border border-input bg-background px-3" />
          </div>
          <div class="flex flex-col gap-1 sm:col-span-2">
            <label for="filter-metadata" class="text-sm font-bold">{{ t('console.sessions.filters.metadata') }}</label>
            <input
              id="filter-metadata"
              v-model="form.metadata"
              type="text"
              autocomplete="off"
              spellcheck="false"
              aria-describedby="filter-metadata-hint"
              :aria-invalid="metadataError ? 'true' : undefined"
              :aria-errormessage="metadataError ? 'filter-metadata-error' : undefined"
              class="min-h-11 rounded-md border border-input bg-background px-3 font-mono"
            />
            <p id="filter-metadata-hint" class="text-sm text-muted-foreground">{{ t('console.sessions.filters.metadataHint') }}</p>
            <p v-if="metadataError" id="filter-metadata-error" role="alert" class="sym-error">{{ t('console.sessions.filters.metadataInvalid') }}</p>
          </div>
        </fieldset>
        <div class="mt-4 flex flex-wrap gap-3">
          <ConsoleButton id="filter-apply" type="submit">{{ t('console.sessions.filters.apply') }}</ConsoleButton>
          <ConsoleButton v-if="hasFilters" type="button" variant="outline" @click="reset">{{ t('console.sessions.filters.reset') }}</ConsoleButton>
        </div>
      </form>

      <p v-if="first.loading.value && !first.data.value" role="status">{{ t('console.common.loading') }}</p>
      <div v-else data-loaded class="flex flex-col gap-4">
        <ErrorAlert v-if="first.error.value" :code="first.error.value" :retry="first.reload" />
        <div v-else-if="rows.length === 0" class="rounded-xl border border-border bg-card p-6 text-card-foreground">
          <SymMessage :text="t(hasFilters ? 'console.sessions.noMatch' : 'console.sessions.empty')" />
        </div>
        <template v-else>
          <div class="overflow-x-auto rounded-xl border border-border bg-card text-card-foreground">
            <table class="w-full text-left text-sm">
              <caption class="p-4 text-left font-bold">{{ t('console.sessions.table.caption', { tab: t(`console.sessions.tabs.${applied.tab}`) }) }}</caption>
              <thead class="border-b border-border">
                <tr>
                  <th scope="col" class="px-4 py-2">{{ t('console.sessions.table.id') }}</th>
                  <th scope="col" class="px-4 py-2">{{ t('console.sessions.table.state') }}</th>
                  <th scope="col" class="px-4 py-2">{{ t('console.sessions.table.type') }}</th>
                  <th scope="col" class="px-4 py-2">{{ t('console.sessions.table.duration') }}</th>
                  <th scope="col" class="px-4 py-2">{{ t('console.sessions.table.bytes') }}</th>
                  <th scope="col" class="px-4 py-2">{{ t('console.sessions.table.key') }}</th>
                  <th scope="col" class="px-4 py-2">{{ t('console.sessions.table.created') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="session in rows" :key="session.id" class="border-b border-border last:border-0">
                  <th scope="row" class="px-4 py-2 font-normal">
                    <RouterLink :to="`/sessions/${encodeURIComponent(session.id)}`" class="inline-flex min-h-6 items-center font-mono font-bold text-primary underline underline-offset-4">{{ session.id }}</RouterLink>
                  </th>
                  <td class="px-4 py-2"><StatusBadge :status="session.state" kind="session" /></td>
                  <td class="px-4 py-2">{{ t(`console.types.${session.type}`) }}</td>
                  <td class="px-4 py-2 whitespace-nowrap">{{ duration(session) }}</td>
                  <td class="px-4 py-2 whitespace-nowrap">{{ bytes(session) }}</td>
                  <td class="px-4 py-2 font-mono">{{ session.apiKeyPrefix }}</td>
                  <td class="px-4 py-2 whitespace-nowrap">{{ formatDate(session.createdAt, locale) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <ConsoleButton v-if="nextCursor" id="sessions-more" type="button" variant="outline" :busy="moreLoading" @click="loadMore">
              {{ t(moreLoading ? 'console.sessions.loadingMore' : 'console.sessions.more') }}
            </ConsoleButton>
            <ErrorAlert v-if="moreError" :code="moreError" :retry="loadMore" />
          </div>
        </template>
      </div>
      <p role="status" class="sr-only">{{ announcement }}</p>
    </div>
  </section>
</template>
