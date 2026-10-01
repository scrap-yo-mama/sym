<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ApiDetailPage.vue
 * @description Contenu de la fiche d'une API (06 § 2), sans accès aux données : en-tête (statut et raison, Lancer,
 * Ré-enquêter), bandeau « Action requise » ou panneau « Bloquée » en tête, puis les huit onglets. La vue
 * `ApiDetailView` lui fournit la fiche lue et les actions ; les tests le rendent avec des fiches de toute forme.
 * @component
 * @example <ApiDetailPage :detail="detail" slug="zz-books" tab="overview" :resuming="false" />
 */
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import ActionRequiredBanner from '@/components/api/ActionRequiredBanner.vue';
import BlockedPanel from '@/components/api/BlockedPanel.vue';
import ApiAccessTab from '@/components/api/tabs/ApiAccessTab.vue';
import ApiInvestigationsTab from '@/components/api/tabs/ApiInvestigationsTab.vue';
import ApiOverviewTab from '@/components/api/tabs/ApiOverviewTab.vue';
import ApiRunsTab from '@/components/api/tabs/ApiRunsTab.vue';
import ApiSchedulesTab from '@/components/api/tabs/ApiSchedulesTab.vue';
import ApiSchemasTab from '@/components/api/tabs/ApiSchemasTab.vue';
import ApiStatusTab from '@/components/api/tabs/ApiStatusTab.vue';
import ApiStrategyTab from '@/components/api/tabs/ApiStrategyTab.vue';
import StatusBadge from '@/components/catalog/StatusBadge.vue';
import StatusReason from '@/components/catalog/StatusReason.vue';
import { Button } from '@/components/ui/button';
import type { ApiDetail } from '@/composables/useApiDetail';
import { API_TABS, type ApiTab } from '@/lib/api-tabs';

defineProps<{
  detail: ApiDetail;
  slug: string;
  tab: ApiTab;
  resuming: boolean;
  /** Run d'enquête demandé dans l'adresse (`?run=`), ouvert dans l'onglet Enquêtes. */
  requestedRun?: string | null;
  reinvestigating?: boolean;
  reinvestigated?: boolean;
  actionFailed?: boolean;
  conflict?: boolean;
}>();
defineEmits<{ reinvestigate: []; updated: [detail: ApiDetail] }>();
const { t } = useI18n();
</script>

<template>
  <header class="flex flex-col gap-2">
    <p class="text-sm"><RouterLink to="/apis" class="underline underline-offset-4">{{ t('detail.backToCatalog') }}</RouterLink></p>
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 data-route-heading tabindex="-1" class="text-2xl font-semibold tracking-tight">{{ slug }}</h1>
      <div v-if="!detail.metadata_only && detail.status !== 'bloquee'" class="flex flex-wrap gap-2">
        <Button as-child><RouterLink :to="{ path: `/apis/${slug}/overview`, hash: '#launch' }">{{ t('actions.launch') }}</RouterLink></Button>
        <Button variant="outline" :disabled="reinvestigating" data-testid="header-reinvestigate" @click="$emit('reinvestigate')">{{ t('actions.reinvestigate') }}</Button>
      </div>
    </div>
    <div class="flex flex-col gap-1">
      <StatusBadge :status="detail.status" :stale="detail.stale" />
      <StatusReason :status="detail.status" :reason="detail.status_reason" />
    </div>
    <p v-if="reinvestigated" role="status" class="text-sm" data-testid="reinvestigation-started">{{ t('detail.reinvestigationStarted') }}</p>
    <p v-if="actionFailed" role="alert" class="text-sm text-destructive">{{ t(conflict ? 'apiErrors.conflict' : 'apiErrors.generic') }}</p>
  </header>

  <BlockedPanel v-if="detail.status === 'bloquee'" :detail="detail" :pending="reinvestigating" @reinvestigate="$emit('reinvestigate')" />
  <ActionRequiredBanner :detail="detail" :resuming="resuming" />

  <nav :aria-label="t('detail.tabs.label')" class="border-b">
    <ul class="flex flex-wrap gap-1">
      <li v-for="entry in API_TABS" :key="entry">
        <RouterLink
          :to="`/apis/${slug}/${entry}`"
          class="inline-flex min-h-11 items-center rounded-t-md border-b-2 px-3 text-sm font-medium focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
          :class="tab === entry ? 'border-primary' : 'border-transparent text-muted-foreground hover:text-foreground'"
          :aria-current="tab === entry ? 'page' : undefined"
          :data-tab="entry"
        >
          {{ t(`detail.tabs.${entry}`) }}
        </RouterLink>
      </li>
    </ul>
  </nav>

  <ApiOverviewTab v-if="tab === 'overview'" :detail="detail" :slug="slug" />
  <ApiSchemasTab v-else-if="tab === 'schemas'" :detail="detail" :slug="slug" @updated="$emit('updated', $event)" />
  <ApiStrategyTab v-else-if="tab === 'strategy'" :detail="detail" :slug="slug" @updated="$emit('updated', $event)" />
  <ApiRunsTab v-else-if="tab === 'runs'" :detail="detail" :slug="slug" />
  <ApiStatusTab v-else-if="tab === 'status'" :slug="slug" />
  <ApiSchedulesTab v-else-if="tab === 'schedules'" :slug="slug" :status="detail.status" />
  <ApiAccessTab v-else-if="tab === 'access'" :detail="detail" />
  <ApiInvestigationsTab v-else :detail="detail" :slug="slug" :initial-run="requestedRun" />
</template>
