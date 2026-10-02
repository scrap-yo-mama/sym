<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ApiCatalogView.vue
 * @description Catalogue des API (06 § 2, 20 § 5.2, planche Catalogue.dc.html) : titre Bricolage de 44 px et phrase de synthèse,
 * recherche à droite du titre, carte de santé (les API bloquées à part, hors du ratio), pastilles-filtres avec compteurs en texte
 * (« À traiter » d'abord s'il y en a), filtres de 06 par statut, exécution et réseau, tableau en carte à pagination serveur avec
 * une action utile par ligne. Rafraîchi toutes les 15 s et par le flux
 * SSE ; la région `status` n'annonce que le changement de statut d'une ligne et la variation d'un compteur de pastille.
 * @page
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import ApiCatalogTable from '@/components/catalog/ApiCatalogTable.vue';
import CatalogHealth from '@/components/catalog/CatalogHealth.vue';
import CatalogPills from '@/components/catalog/CatalogPills.vue';
import EmptyState from '@/components/EmptyState.vue';
import ErrorState from '@/components/ErrorState.vue';
import LoadingState from '@/components/LoadingState.vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ATTENTION_MAX_ROWS } from '@/composables/useApiCatalog';
import { useCatalogScreen } from '@/composables/useCatalogScreen';
import { activePill } from '@/lib/catalog-health';
import { API_STATUSES, EXECUTIONS, NETWORKS } from '@/lib/status';

const { t, te } = useI18n();
const { catalog, overview, opened } = useCatalogScreen();
const { filters } = catalog;

const health = overview.health;
const pill = computed(() => activePill(filters));

/**
 * « 6 API en service, 1 arrêtée. Deux demandent ton attention. » (planche, mot pour mot) : des comptes réels, jamais un nombre
 * d'exemple. En tête de phrase, le nombre à traiter s'écrit en lettres jusqu'à dix, en chiffres au-delà.
 */
const summary = computed(() => {
  const current = health.value;
  if (!current || current.total === 0) return '';
  const parts = [t('catalog.summary.service', { n: current.inService }, current.inService)];
  if (current.stopped > 0) parts.push(t('catalog.summary.stopped', { n: current.stopped }, current.stopped));
  const word = `catalog.summary.words.n${current.attention}`;
  const count = te(word) ? t(word) : String(current.attention);
  return `${parts.join(', ')}. ${t('catalog.summary.attention', { count }, current.attention)}`;
});

// Suivi suspendu (2.2.2) : la région annonce l'état du bouton, puis plus rien ne change tant que le suivi reste suspendu.
// Sinon : le changement de statut d'une ligne, puis la variation d'un compteur de pastille (06 § 3, assert_attention_filters_counts).
const announcement = computed(() => {
  if (catalog.suspended.value) return t('catalog.follow.suspended');
  const rows = catalog.statusChanges.value.map((change) => t('catalog.statusChanged', { slug: change.slug, status: t(`status.${change.to}`) }));
  const counters = overview.changes.value.map((change) => t('catalog.pills.changed', { label: t(`catalog.pills.${change.pill}`), n: change.count }));
  return [...rows, ...counters].join(' ');
});

function resetFilters(): void {
  filters.status = '';
  filters.attention = false;
  filters.execution = '';
  filters.network = '';
  filters.q = '';
}

const selectClass = 'h-11 rounded-md border-[1.5px] border-foreground bg-card px-2 text-sm focus-visible:border-ring outline-none';
</script>

<template>
  <section class="mx-auto flex max-w-[75rem] flex-col gap-[22px] py-6">
    <!-- Planche Catalogue.dc.html : titre Bricolage de 44 px et phrase de synthèse à gauche, recherche à droite. -->
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div class="flex flex-col gap-1.5">
        <h1 data-route-heading tabindex="-1" class="font-display text-[44px] leading-[1.1] font-extrabold tracking-[-1px]">{{ t('catalog.title') }}</h1>
        <p v-if="summary" class="text-base text-muted-foreground" data-testid="catalog-summary">{{ summary }}</p>
      </div>
      <div class="flex flex-wrap items-end gap-3">
        <form role="search" class="flex flex-col gap-1" :aria-label="t('catalog.filters.searchLabel')" @submit.prevent>
          <label for="catalog-search" class="text-[13px] font-bold">{{ t('catalog.filters.search') }}</label>
          <Input id="catalog-search" v-model="filters.q" type="search" class="h-11 w-[280px] max-w-full border-[1.5px] border-foreground bg-card px-3.5 text-[15px]" :placeholder="t('catalog.filters.searchPlaceholder')" />
        </form>
        <!-- La barre de navigation n'a pas (encore) le bouton « Nouvelle API » de la planche : il reste à portée ici. -->
        <Button as-child variant="signature" class="rounded-md">
          <RouterLink to="/apis/new">{{ t('catalog.newApi') }}</RouterLink>
        </Button>
      </div>
    </header>

    <CatalogHealth v-if="health && health.total > 0" :health="health" :partial="overview.snapshot.value?.truncated ?? false" />

    <CatalogPills :counts="overview.pills.value" :active="pill" @select="(selected) => catalog.setPill(selected)" />

    <!-- Filtres de 06 § 2 (statut, exécution, réseau) et suivi : sous les pastilles de la planche. -->
    <div role="group" class="flex flex-wrap items-end gap-3" :aria-label="t('catalog.filters.label')">
      <div class="flex flex-col gap-1">
        <label for="catalog-status" class="text-[13px] font-bold">{{ t('catalog.filters.status') }}</label>
        <select id="catalog-status" v-model="filters.status" :class="selectClass">
          <option value="">{{ t('catalog.filters.all') }}</option>
          <option v-for="status in API_STATUSES" :key="status" :value="status">{{ t(`status.${status}`) }}</option>
        </select>
      </div>
      <div class="flex flex-col gap-1">
        <label for="catalog-execution" class="text-[13px] font-bold">{{ t('catalog.filters.execution') }}</label>
        <select id="catalog-execution" v-model="filters.execution" :class="selectClass">
          <option value="">{{ t('catalog.filters.all') }}</option>
          <option v-for="execution in EXECUTIONS" :key="execution" :value="execution">{{ t(`execution.${execution}`) }}</option>
        </select>
      </div>
      <div class="flex flex-col gap-1">
        <label for="catalog-network" class="text-[13px] font-bold">{{ t('catalog.filters.network') }}</label>
        <select id="catalog-network" v-model="filters.network" :class="selectClass">
          <option value="">{{ t('catalog.filters.all') }}</option>
          <option v-for="network in NETWORKS" :key="network" :value="network">{{ t(`network.${network}`) }}</option>
        </select>
      </div>
      <Button type="button" variant="outline" data-testid="catalog-follow-toggle" @click="catalog.suspended.value = !catalog.suspended.value">
        {{ catalog.suspended.value ? t('catalog.follow.resume') : t('catalog.follow.suspend') }}
      </Button>
    </div>

    <!-- Région `status` du plan de 06 § 3 : seul le changement de statut d'une ligne et la variation d'un compteur sont annoncés. Toujours présente. -->
    <div role="status" aria-live="polite" class="sr-only" data-testid="catalog-live">{{ announcement }}</div>

    <LoadingState v-if="!opened || (catalog.loading.value && catalog.apis.value.length === 0)" />
    <ErrorState v-else-if="catalog.error.value && catalog.apis.value.length === 0" :error="catalog.error.value" @retry="catalog.refetch()" />
    <EmptyState v-else-if="catalog.apis.value.length === 0 && catalog.hasActiveFilter.value" :title="t('catalog.noMatch.title')" :description="t('catalog.noMatch.description')">
      <template #action>
        <Button variant="outline" @click="resetFilters">{{ t('catalog.noMatch.reset') }}</Button>
      </template>
    </EmptyState>
    <EmptyState v-else-if="catalog.apis.value.length === 0" :title="t('catalog.empty.title')" :description="t('catalog.empty.description')">
      <template #action>
        <Button as-child>
          <RouterLink to="/apis/new">{{ t('catalog.newApi') }}</RouterLink>
        </Button>
      </template>
    </EmptyState>
    <template v-else>
      <ErrorState v-if="catalog.error.value" :error="catalog.error.value" @retry="catalog.refetch()" />
      <p v-if="filters.attention && catalog.attentionTruncated.value" class="text-sm text-muted-foreground" data-testid="attention-partial">{{ t('catalog.attentionPartial', { n: ATTENTION_MAX_ROWS }) }}</p>
      <ApiCatalogTable :apis="catalog.apis.value" :busy="catalog.loading.value" :resuming="catalog.resuming.value" />
      <nav v-if="catalog.hasPrevious.value || catalog.hasNext.value" class="flex flex-wrap items-center justify-between gap-2" :aria-label="t('catalog.pagination.label')">
        <Button variant="outline" size="sm" :disabled="!catalog.hasPrevious.value" @click="catalog.previous()">{{ t('catalog.pagination.previous') }}</Button>
        <span class="text-sm text-muted-foreground">{{ t('catalog.pagination.page', { n: catalog.pageNumber.value }) }}</span>
        <Button variant="outline" size="sm" :disabled="!catalog.hasNext.value" @click="catalog.next()">{{ t('catalog.pagination.next') }}</Button>
      </nav>
    </template>
  </section>
</template>
