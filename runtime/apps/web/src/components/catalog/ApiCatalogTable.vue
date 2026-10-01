<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ApiCatalogTable.vue
 * @description Tableau du catalogue (06 § 2) : nom et description, badge d'exécution, badge réseau, statut et raison
 * (la « colonne warning » ; pour une action requise, le titre de la tâche, même verbe que le bandeau de la fiche), dernier run, coût moyen (préfixe « ~ » s'il est estimé), taux de succès sur 30 jours, icône
 * « ordinateur requis » et pastille Accès. La raison est toujours visible en texte. Pagination et filtres : la vue.
 * @component
 * @example <ApiCatalogTable :apis="apis" />
 */
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import AccessSignal from '@/components/catalog/AccessSignal.vue';
import ExecutionBadge from '@/components/catalog/ExecutionBadge.vue';
import NetworkBadge from '@/components/catalog/NetworkBadge.vue';
import StatusBadge from '@/components/catalog/StatusBadge.vue';
import StatusReason from '@/components/catalog/StatusReason.vue';
import type { ApiSummary } from '@/composables/useApiCatalog';
import { formatAgo, formatPercent, formatUsd } from '@/lib/display-format';

defineProps<{ apis: readonly ApiSummary[]; busy?: boolean }>();
const { t, locale } = useI18n();
</script>

<template>
  <div class="overflow-x-auto rounded-lg border">
    <table class="w-full min-w-[60rem] border-collapse text-left text-sm" :aria-busy="busy ? 'true' : 'false'" data-testid="catalog-table">
      <caption class="sr-only">{{ t('catalog.caption') }}</caption>
      <thead class="bg-muted text-xs uppercase tracking-wide text-muted-foreground">
        <tr>
          <th scope="col" class="px-3 py-2 font-medium">{{ t('catalog.columns.name') }}</th>
          <th scope="col" class="px-3 py-2 font-medium">{{ t('catalog.columns.execution') }}</th>
          <th scope="col" class="px-3 py-2 font-medium">{{ t('catalog.columns.network') }}</th>
          <th scope="col" class="px-3 py-2 font-medium">{{ t('catalog.columns.status') }}</th>
          <th scope="col" class="px-3 py-2 font-medium">{{ t('catalog.columns.lastRun') }}</th>
          <th scope="col" class="px-3 py-2 font-medium">{{ t('catalog.columns.cost') }}</th>
          <th scope="col" class="px-3 py-2 font-medium">{{ t('catalog.columns.success') }}</th>
          <th scope="col" class="px-3 py-2 font-medium">{{ t('catalog.columns.access') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="api in apis" :key="api.id" class="border-t align-top" data-testid="catalog-row" :data-slug="api.slug" :data-status="api.status">
          <th scope="row" class="max-w-[18rem] px-3 py-3 font-normal">
            <RouterLink :to="`/apis/${api.slug}`" class="font-medium underline-offset-4 hover:underline focus-visible:underline">{{ api.slug }}</RouterLink>
            <p class="mt-0.5 line-clamp-2 text-muted-foreground">{{ api.description }}</p>
          </th>
          <td class="px-3 py-3"><ExecutionBadge :execution="api.execution" /></td>
          <td class="px-3 py-3">
            <div class="flex flex-col items-start gap-1">
              <NetworkBadge :network="api.network" />
              <span v-if="api.requires.tunnel" class="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid="computer-required">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" class="size-4">
                  <rect x="3" y="4" width="18" height="12" rx="2" />
                  <path d="M8 20h8M12 16v4" />
                </svg>
                {{ t('catalog.computerRequired') }}
              </span>
            </div>
          </td>
          <td class="px-3 py-3">
            <StatusBadge :status="api.status" :stale="api.stale" />
            <StatusReason :status="api.status" :reason="api.status_reason" :session-domain="api.requires.session_domain" task class="mt-1" />
          </td>
          <td class="px-3 py-3 whitespace-nowrap">{{ formatAgo(api.last_run_at, locale) }}</td>
          <td class="px-3 py-3 whitespace-nowrap">{{ formatUsd(api.avg_cost_usd, locale, api.avg_cost_estimated ?? false) }}</td>
          <td class="px-3 py-3 whitespace-nowrap">{{ formatPercent(api.success_rate_30d, locale) }}</td>
          <td class="px-3 py-3"><AccessSignal :signal="api.access_signal" /></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
