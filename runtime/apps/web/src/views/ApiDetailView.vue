<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ApiDetailView.vue
 * @description Fiche d'une API (06 § 2) : lit la fiche (rafraîchie par le flux SSE sans rechargement), porte les actions
 * Ré-enquêter, puis confie l'affichage à `ApiDetailPage` (en-tête, bandeau ou panneau en tête, huit onglets).
 * @page
 */
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import ApiDetailPage from '@/components/api/ApiDetailPage.vue';
import ErrorState from '@/components/ErrorState.vue';
import LoadingState from '@/components/LoadingState.vue';
import { useApiActions } from '@/composables/useApiActions';
import { useApiDetail, type ApiDetail } from '@/composables/useApiDetail';
import { isApiTab, type ApiTab } from '@/lib/api-tabs';

const route = useRoute();
const slug = computed(() => String(route.params.slug ?? ''));
const tab = computed<ApiTab>(() => (isApiTab(route.params.tab) ? route.params.tab : 'overview'));
const requestedRun = computed(() => (typeof route.query.run === 'string' ? route.query.run : null));

const page = useApiDetail(slug);
const actions = useApiActions(slug);
const lastRun = ref<string | null>(null);

async function reinvestigate(): Promise<void> {
  lastRun.value = await actions.reinvestigate();
  if (lastRun.value) await page.refetch({ silent: true });
}

function onUpdated(updated: ApiDetail): void {
  page.setDetail(updated);
}
</script>

<template>
  <section :key="slug" class="mx-auto flex max-w-6xl flex-col gap-4 py-6">
    <LoadingState v-if="page.loading.value && !page.detail.value" />
    <ErrorState v-else-if="page.error.value && !page.detail.value" :error="page.error.value" @retry="page.refetch()" />
    <ApiDetailPage
      v-else-if="page.detail.value"
      :detail="page.detail.value"
      :slug="slug"
      :tab="tab"
      :resuming="page.resuming.value"
      :requested-run="requestedRun"
      :reinvestigating="actions.pending.value === 'reinvestigate'"
      :reinvestigated="lastRun !== null && actions.error.value === null"
      :action-failed="actions.error.value !== null"
      :conflict="actions.error.value?.status === 409"
      @reinvestigate="reinvestigate"
      @updated="onUpdated"
    />
  </section>
</template>
