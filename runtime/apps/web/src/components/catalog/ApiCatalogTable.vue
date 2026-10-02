<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ApiCatalogTable.vue
 * @description Tableau du catalogue (06 § 2, planche Catalogue.dc.html : carte papier, nom puis domaine, en-têtes « API · STATUT · MODE · RÉSEAU ·
 * COÛT / RUN · DERNIER RUN », ligne action requise surlignée) : nom et description, statut et raison, exécution et réseau
 * (la « colonne warning » ; pour une action requise, le titre de la tâche, même verbe que le bandeau de la fiche), dernier run, coût moyen (préfixe « ~ » s'il est estimé), taux de succès sur 30 jours, icône
 * « ordinateur requis » et pastille Accès, puis UNE action utile par ligne (20 § 5.2) : « Voir les alternatives » pour une API
 * bloquée, le verbe du bandeau de la fiche pour une action requise (qui devient « Reprise de l'enquête… » dès que l'enquête
 * reprend), rien sur une ligne saine ; jamais de relance ni de tunnel après un blocage (A7). La raison est toujours visible en
 * texte. Pagination et filtres : la vue.
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

import { rowAction } from '@/lib/catalog-actions';

withDefaults(defineProps<{ apis: readonly ApiSummary[]; busy?: boolean; resuming?: ReadonlySet<string> }>(), { busy: false, resuming: () => new Set<string>() });
const { t, locale } = useI18n();

/** Domaine de la ligne (20 § 5.2, « nom et domaine ») : celui de la page enquêtée, sinon celui de la session connectée. */
const domainOf = (api: ApiSummary): string | null => api.domain ?? api.requires.session_domain ?? null;
</script>

<template>
  <div class="relative overflow-x-auto rounded-xl bg-card px-2 py-1.5 text-card-foreground">
    <table class="w-full min-w-[60rem] border-collapse text-left text-sm" :aria-busy="busy ? 'true' : 'false'" data-testid="catalog-table">
      <caption class="sr-only">{{ t('catalog.caption') }}</caption>
      <thead class="text-xs text-muted-foreground uppercase">
        <tr>
          <th scope="col" class="px-4 py-3 font-bold">{{ t('catalog.columns.name') }}</th>
          <th scope="col" class="px-4 py-3 font-bold">{{ t('catalog.columns.status') }}</th>
          <th scope="col" class="px-4 py-3 font-bold">{{ t('catalog.columns.mode') }}</th>
          <th scope="col" class="px-4 py-3 font-bold">{{ t('catalog.columns.cost') }}</th>
          <th scope="col" class="px-4 py-3 font-bold">{{ t('catalog.columns.lastRun') }}</th>
          <th scope="col" class="px-4 py-3 font-bold">{{ t('catalog.columns.success') }}</th>
          <th scope="col" class="px-4 py-3 font-bold">{{ t('catalog.columns.access') }}</th>
          <th scope="col" class="px-4 py-3 font-bold"><span class="sr-only">{{ t('catalog.columns.action') }}</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="api in apis" :key="api.id" class="border-t align-middle" :class="api.status === 'action_requise' ? 'bg-accent' : ''" data-testid="catalog-row" :data-slug="api.slug" :data-status="api.status">
          <th scope="row" class="max-w-[18rem] px-4 py-3.5 font-normal">
            <RouterLink :to="`/apis/${api.slug}`" class="text-[15px] font-bold underline-offset-4 hover:underline focus-visible:underline">{{ api.slug }}</RouterLink>
            <!-- Planche : le nom, puis le domaine (donnée, jamais traduite). Sans domaine connu, la description de 06 § 2. -->
            <p v-if="domainOf(api)" class="mt-0.5 truncate text-[13px] text-muted-foreground" translate="no" data-testid="row-domain">{{ domainOf(api) }}</p>
            <p v-else class="mt-0.5 line-clamp-2 text-[13px] text-muted-foreground">{{ api.description }}</p>
          </th>
          <td class="px-4 py-3.5">
            <StatusBadge :status="api.status" :stale="api.stale" />
            <StatusReason :status="api.status" :reason="api.status_reason" :session-domain="api.requires.session_domain" task class="mt-1" />
          </td>
          <td class="px-4 py-3.5">
            <div class="flex flex-col items-start gap-1">
              <span class="text-sm"><ExecutionBadge :execution="api.execution" plain /> · <NetworkBadge :network="api.network" plain /></span>
              <span v-if="api.requires.tunnel" class="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid="computer-required">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" class="size-4">
                  <rect x="3" y="4" width="18" height="12" rx="2" />
                  <path d="M8 20h8M12 16v4" />
                </svg>
                {{ t('catalog.computerRequired') }}
              </span>
            </div>
          </td>
          <td class="px-4 py-3.5 whitespace-nowrap">{{ formatUsd(api.avg_cost_usd, locale, api.avg_cost_estimated ?? false) }}</td>
          <td class="px-4 py-3.5 whitespace-nowrap text-muted-foreground">
            <time v-if="api.last_run_at" :datetime="api.last_run_at">{{ formatAgo(api.last_run_at, locale) }}</time>
            <template v-else>{{ formatAgo(api.last_run_at, locale) }}</template>
          </td>
          <td class="px-4 py-3.5 whitespace-nowrap">{{ formatPercent(api.success_rate_30d, locale) }}</td>
          <td class="px-4 py-3.5"><AccessSignal :signal="api.access_signal" /></td>
          <td class="px-4 py-3.5" data-testid="row-action-cell">
            <!-- La ligne se coche seule (flux SSE) puis dit « Reprise de l'enquête… » : une action requise n'est plus à faire. -->
            <p v-if="resuming.has(api.slug)" class="text-sm font-bold" data-testid="row-resuming">{{ t('actionRequired.resuming') }}</p>
            <template v-else-if="rowAction(api)">
              <a v-if="rowAction(api)!.href" :href="rowAction(api)!.href" target="_blank" rel="noopener noreferrer" class="text-sm font-bold whitespace-nowrap text-primary underline underline-offset-4 focus-visible:underline" data-testid="row-action" :data-kind="rowAction(api)!.kind">{{ t(rowAction(api)!.labelKey) }}</a>
              <RouterLink v-else :to="rowAction(api)!.to" class="text-sm font-bold whitespace-nowrap text-primary underline underline-offset-4 focus-visible:underline" data-testid="row-action" :data-kind="rowAction(api)!.kind">{{ t(rowAction(api)!.labelKey) }}</RouterLink>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
