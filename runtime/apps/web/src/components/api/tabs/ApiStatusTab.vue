<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ApiStatusTab.vue
 * @description « Bugs & statut » (06 § 2) : chronologie des transitions de statut avec leur raison et le run lié, et
 * erreurs regroupées par `failure_class`. La machine à états est celle de `packages/core` (INV3) : la console affiche
 * ce que le serveur a enregistré.
 * @component
 * @example <ApiStatusTab slug="zz-books" />
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import ErrorState from '@/components/ErrorState.vue';
import LoadingState from '@/components/LoadingState.vue';
import StatusBadge from '@/components/catalog/StatusBadge.vue';
import { Button } from '@/components/ui/button';
import { useApiRuns } from '@/composables/useApiRuns';
import { groupFailures, useStatusEvents } from '@/composables/useStatusEvents';
import { formatDateTime } from '@/lib/display-format';
import { describeFailureClass, describeReason } from '@/lib/reasons';

const props = defineProps<{ slug: string }>();
const { t, te, locale } = useI18n();
const status = useStatusEvents(() => props.slug);
const runs = useApiRuns(() => props.slug);
const failures = computed(() => groupFailures(runs.runs.value));

function reasonOf(event: (typeof status.events.value)[number]): string {
  return describeReason((key, named) => t(key, named ?? {}), te, locale.value, event.to_status, event.reason);
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <section aria-labelledby="status-timeline" class="flex flex-col gap-3">
      <h2 id="status-timeline" class="text-lg font-semibold">{{ t('statusTab.timeline') }}</h2>
      <LoadingState v-if="status.loading.value && status.events.value.length === 0" />
      <ErrorState v-else-if="status.error.value" :error="status.error.value" @retry="status.refetch()" />
      <p v-else-if="status.events.value.length === 0" class="text-sm text-muted-foreground">{{ t('statusTab.empty') }}</p>
      <ol v-else class="flex flex-col gap-3" data-testid="status-timeline">
        <li v-for="event in status.events.value" :key="event.id" class="flex flex-col gap-1 rounded-lg border p-3">
          <div class="flex flex-wrap items-center gap-2">
            <StatusBadge :status="event.to_status" />
            <span v-if="event.from_status" class="text-sm text-muted-foreground">{{ t('statusTab.from', { status: t(`status.${event.from_status}`) }) }}</span>
            <span v-if="event.transition" class="text-xs text-muted-foreground">{{ t('statusTab.transition', { n: String(event.transition) }) }}</span>
            <time :datetime="event.at" class="ml-auto text-sm text-muted-foreground">{{ formatDateTime(event.at, locale) }}</time>
          </div>
          <p class="text-sm">{{ reasonOf(event) }}</p>
          <RouterLink v-if="event.run_id" :to="`/runs/${event.run_id}`" class="text-sm underline underline-offset-4">{{ t('statusTab.linkedRun') }}</RouterLink>
        </li>
      </ol>
      <div v-if="status.hasMore()"><Button variant="outline" size="sm" :disabled="status.loadingMore.value" @click="status.loadMore()">{{ t('ui.loadMore') }}</Button></div>
    </section>

    <section aria-labelledby="status-errors" class="flex flex-col gap-3">
      <h2 id="status-errors" class="text-lg font-semibold">{{ t('statusTab.errors') }}</h2>
      <p v-if="failures.length === 0" class="text-sm text-muted-foreground">{{ t('statusTab.noErrors') }}</p>
      <ul v-else class="flex flex-col gap-2" data-testid="failure-groups">
        <li v-for="group in failures" :key="group.failureClass" class="flex flex-wrap items-center gap-3 rounded-lg border p-3">
          <span class="font-medium">{{ describeFailureClass((key, named) => t(key, named ?? {}), te, group.failureClass) }}</span>
          <span class="text-sm text-muted-foreground">{{ t('statusTab.occurrences', { n: String(group.count) }, group.count) }}</span>
          <RouterLink :to="`/runs/${group.lastRunId}`" class="text-sm underline underline-offset-4">{{ t('statusTab.lastOccurrence') }}</RouterLink>
        </li>
      </ul>
    </section>
  </div>
</template>
