<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ApiCatalogView.vue
 * @description Catalogue des API (06 § 2) : tableau à pagination serveur, filtres par statut, exécution et réseau,
 * recherche plein texte, bouton Nouvelle API. Rafraîchi toutes les 15 s et par le flux SSE ; seule un changement de
 * statut est annoncé (région `status`).
 * @page
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import ApiCatalogTable from '@/components/catalog/ApiCatalogTable.vue';
import EmptyState from '@/components/EmptyState.vue';
import ErrorState from '@/components/ErrorState.vue';
import LoadingState from '@/components/LoadingState.vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useApiCatalog } from '@/composables/useApiCatalog';
import { API_STATUSES, EXECUTIONS, NETWORKS } from '@/lib/status';

const { t } = useI18n();
const catalog = useApiCatalog();
const { filters } = catalog;

// Suivi suspendu (2.2.2) : la région annonce l'état du bouton, puis plus rien ne change tant que le suivi reste suspendu.
const announcement = computed(() =>
  catalog.suspended.value
    ? t('catalog.follow.suspended')
    : catalog.statusChanges.value.map((change) => t('catalog.statusChanged', { slug: change.slug, status: t(`status.${change.to}`) })).join(' '),
);

function resetFilters(): void {
  filters.status = '';
  filters.execution = '';
  filters.network = '';
  filters.q = '';
}

const selectClass =
  'h-9 rounded-md border border-input bg-background px-2 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none';
</script>

<template>
  <section class="mx-auto flex max-w-7xl flex-col gap-4 py-6">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <h1 data-route-heading tabindex="-1" class="text-2xl font-semibold tracking-tight">{{ t('catalog.title') }}</h1>
      <Button as-child>
        <RouterLink to="/apis/new">{{ t('catalog.newApi') }}</RouterLink>
      </Button>
    </header>

    <form role="search" class="flex flex-wrap items-end gap-3" :aria-label="t('catalog.filters.label')" @submit.prevent>
      <div class="flex min-w-56 flex-1 flex-col gap-1">
        <label for="catalog-search" class="text-sm font-medium">{{ t('catalog.filters.search') }}</label>
        <Input id="catalog-search" v-model="filters.q" type="search" :placeholder="t('catalog.filters.searchPlaceholder')" />
      </div>
      <div class="flex flex-col gap-1">
        <label for="catalog-status" class="text-sm font-medium">{{ t('catalog.filters.status') }}</label>
        <select id="catalog-status" v-model="filters.status" :class="selectClass">
          <option value="">{{ t('catalog.filters.all') }}</option>
          <option v-for="status in API_STATUSES" :key="status" :value="status">{{ t(`status.${status}`) }}</option>
        </select>
      </div>
      <div class="flex flex-col gap-1">
        <label for="catalog-execution" class="text-sm font-medium">{{ t('catalog.filters.execution') }}</label>
        <select id="catalog-execution" v-model="filters.execution" :class="selectClass">
          <option value="">{{ t('catalog.filters.all') }}</option>
          <option v-for="execution in EXECUTIONS" :key="execution" :value="execution">{{ t(`execution.${execution}`) }}</option>
        </select>
      </div>
      <div class="flex flex-col gap-1">
        <label for="catalog-network" class="text-sm font-medium">{{ t('catalog.filters.network') }}</label>
        <select id="catalog-network" v-model="filters.network" :class="selectClass">
          <option value="">{{ t('catalog.filters.all') }}</option>
          <option v-for="network in NETWORKS" :key="network" :value="network">{{ t(`network.${network}`) }}</option>
        </select>
      </div>
      <Button type="button" variant="outline" data-testid="catalog-follow-toggle" @click="catalog.suspended.value = !catalog.suspended.value">
        {{ catalog.suspended.value ? t('catalog.follow.resume') : t('catalog.follow.suspend') }}
      </Button>
    </form>

    <!-- Région `status` du plan de 06 § 3 : seul le changement de statut d'une ligne est annoncé. Toujours présente. -->
    <div role="status" aria-live="polite" class="sr-only" data-testid="catalog-live">{{ announcement }}</div>

    <LoadingState v-if="catalog.loading.value && catalog.apis.value.length === 0" />
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
      <ApiCatalogTable :apis="catalog.apis.value" :busy="catalog.loading.value" />
      <nav class="flex flex-wrap items-center justify-between gap-2" :aria-label="t('catalog.pagination.label')">
        <Button variant="outline" size="sm" :disabled="!catalog.hasPrevious.value" @click="catalog.previous()">{{ t('catalog.pagination.previous') }}</Button>
        <span class="text-sm text-muted-foreground">{{ t('catalog.pagination.page', { n: catalog.pageNumber.value }) }}</span>
        <Button variant="outline" size="sm" :disabled="!catalog.hasNext.value" @click="catalog.next()">{{ t('catalog.pagination.next') }}</Button>
      </nav>
    </template>
  </section>
</template>
