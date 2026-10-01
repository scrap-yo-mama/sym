<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ApiStrategyTab.vue
 * @description « Stratégie & versions » (06 § 2) : spécification déclarative ou script en lecture seule, liste des versions
 * (origine, date, coût, « validée sur N échantillons »), diff à trois niveaux entre deux versions, retour à une version avec
 * aperçu de la conséquence (l'API passe en `warning`, raison `reverted`, transitions 7 ou 8), proposé seulement depuis
 * `sain` ou `warning` (jamais sur une API `bloquee`, dont la seule reprise est Ré-enquêter). Chaque version renvoie à
 * l'enquête ou à la réparation qui l'a produite (onglet Enquêtes).
 * @component
 * @example <ApiStrategyTab :detail="detail" slug="zz-books" @updated="onUpdated" />
 */
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import ErrorState from '@/components/ErrorState.vue';
import JsonTree from '@/components/api/JsonTree.vue';
import LoadingState from '@/components/LoadingState.vue';
import RevertConfirm from '@/components/api/RevertConfirm.vue';
import StrategyDiffView from '@/components/api/StrategyDiffView.vue';
import ExecutionBadge from '@/components/catalog/ExecutionBadge.vue';
import NetworkBadge from '@/components/catalog/NetworkBadge.vue';
import { Button } from '@/components/ui/button';
import { useApiActions } from '@/composables/useApiActions';
import type { ApiDetail } from '@/composables/useApiDetail';
import { revertAllowed, useRevertPreview, useStrategyVersions, type StrategyVersion } from '@/composables/useStrategyVersions';
import { formatDateTime, formatUsd } from '@/lib/display-format';

const props = defineProps<{ detail: ApiDetail; slug: string }>();
const emit = defineEmits<{ updated: [detail: ApiDetail] }>();
const { t, te, locale } = useI18n();
const versions = useStrategyVersions(() => props.slug);
const actions = useApiActions(() => props.slug);

const current = ref<StrategyVersion | null>(null);
watch(
  () => props.detail.current_strategy_version,
  async (version) => {
    current.value = null;
    if (version && !props.detail.metadata_only) current.value = await versions.loadVersion(version).catch(() => null);
  },
  { immediate: true },
);

const compareFrom = ref('');
const compareAgainst = ref('');
async function compare(version: number, against: number): Promise<void> {
  compareFrom.value = String(version);
  compareAgainst.value = String(against);
  await versions.loadDiff(version, against);
}
async function compareSelected(): Promise<void> {
  if (compareFrom.value && compareAgainst.value && compareFrom.value !== compareAgainst.value) await versions.loadDiff(Number(compareFrom.value), Number(compareAgainst.value));
}

/** Retour à une version : seulement depuis sain ou warning (transitions 7 et 8), jamais sur une API bloquée (18). */
const canRevert = computed(() => !props.detail.metadata_only && revertAllowed(props.detail.status));

/** Retour à une version : aperçu (diff de la courante vers la visée) et conséquence avant confirmation. */
const reverting = useRevertPreview(() => props.slug, () => props.detail.current_strategy_version);
async function confirmRevert(): Promise<void> {
  const target = reverting.target.value;
  if (target === null) return;
  const updated = await actions.revert(target);
  if (updated) {
    emit('updated', updated);
    reverting.cancel();
    await versions.refetch();
  }
}

const errorText = computed(() => {
  const code = actions.error.value?.code;
  return actions.error.value ? (code && te(`apiErrors.${code}`) ? t(`apiErrors.${code}`) : t('apiErrors.generic')) : null;
});
</script>

<template>
  <div class="flex flex-col gap-6">
    <section v-if="!detail.metadata_only" aria-labelledby="strategy-current" class="flex flex-col gap-2">
      <h2 id="strategy-current" class="text-lg font-semibold">{{ t('strategy.current') }}</h2>
      <p v-if="!detail.current_strategy_version" class="text-sm text-muted-foreground">{{ t('strategy.none') }}</p>
      <template v-else-if="current">
        <p class="text-sm text-muted-foreground">{{ current.spec ? t('strategy.declarative') : t('strategy.script') }}</p>
        <JsonTree v-if="current.spec" :value="current.spec" />
        <p v-else class="font-mono text-sm" data-testid="script-ref">{{ current.script_ref }}</p>
      </template>
    </section>
    <p v-else class="rounded-md border p-3 text-sm" data-testid="metadata-only">{{ t('detail.metadataOnly') }}</p>

    <section aria-labelledby="strategy-versions" class="flex flex-col gap-3">
      <h2 id="strategy-versions" class="text-lg font-semibold">{{ t('strategy.versions') }}</h2>
      <LoadingState v-if="versions.loading.value && versions.versions.value.length === 0" />
      <ErrorState v-else-if="versions.error.value" :error="versions.error.value" @retry="versions.refetch()" />
      <p v-else-if="versions.versions.value.length === 0" class="text-sm text-muted-foreground">{{ t('strategy.noVersions') }}</p>
      <div v-else class="relative overflow-x-auto rounded-lg border">
        <table class="w-full min-w-[44rem] text-left text-sm" data-testid="versions-table">
          <caption class="sr-only">{{ t('strategy.versions') }}</caption>
          <thead class="bg-muted text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('strategy.columns.version') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('strategy.columns.strategy') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('strategy.columns.origin') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('strategy.columns.date') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('strategy.columns.cost') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('strategy.columns.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in versions.versions.value" :key="item.version" class="border-t align-top">
              <th scope="row" class="px-3 py-2 font-normal">
                v{{ item.version }}
                <span v-if="item.version === detail.current_strategy_version" class="ml-1 rounded-md border px-1.5 text-xs">{{ t('strategy.currentTag') }}</span>
                <p v-if="item.validated_samples" class="text-xs text-muted-foreground">{{ t('strategy.validated', { n: String(item.validated_samples) }, item.validated_samples) }}</p>
              </th>
              <td class="px-3 py-2">
                <div class="flex flex-wrap items-center gap-1.5"><ExecutionBadge :execution="item.execution" /><NetworkBadge :network="item.network" /></div>
              </td>
              <td class="px-3 py-2">
                {{ t(`strategy.origins.${item.created_by}`) }}
                <RouterLink v-if="item.run_id" :to="{ path: `/apis/${slug}/investigations`, query: { run: item.run_id } }" class="block text-xs underline underline-offset-4">{{ t('strategy.seeInvestigation') }}</RouterLink>
              </td>
              <td class="px-3 py-2 whitespace-nowrap">{{ formatDateTime(item.created_at, locale) }}</td>
              <td class="px-3 py-2 whitespace-nowrap">{{ formatUsd(item.est_cost_usd, locale, true) }}</td>
              <td class="px-3 py-2">
                <div class="flex flex-wrap gap-2">
                  <Button v-if="item.parent_version" variant="outline" size="xs" @click="compare(item.version, item.parent_version)">
                    {{ t('strategy.compareWith', { a: String(item.version), b: String(item.parent_version) }) }}
                  </Button>
                  <Button v-if="canRevert && item.version !== detail.current_strategy_version" variant="outline" size="xs" @click="reverting.start(item.version)">
                    {{ t('strategy.revert') }}
                  </Button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="versions.hasMore()"><Button variant="outline" size="sm" :disabled="versions.loadingMore.value" @click="versions.loadMore()">{{ t('ui.loadMore') }}</Button></div>

      <RevertConfirm
        v-if="canRevert && reverting.target.value !== null"
        :key="reverting.target.value"
        :version="reverting.target.value"
        :current="detail.current_strategy_version"
        :diff="reverting.diff.value"
        :diff-loading="reverting.diffLoading.value"
        :diff-error="reverting.diffError.value"
        :pending="actions.pending.value === 'revert'"
        @confirm="confirmRevert"
        @cancel="reverting.cancel()"
      />
      <p v-if="errorText" role="alert" class="text-sm text-destructive">{{ errorText }}</p>
    </section>

    <section v-if="versions.versions.value.length > 1" aria-labelledby="strategy-compare" class="flex flex-col gap-3">
      <h2 id="strategy-compare" class="text-lg font-semibold">{{ t('strategy.compare') }}</h2>
      <form class="flex flex-wrap items-end gap-3" @submit.prevent="compareSelected">
        <div class="flex flex-col gap-1">
          <label for="compare-from" class="text-sm font-medium">{{ t('strategy.compareFrom') }}</label>
          <select id="compare-from" v-model="compareFrom" class="h-9 rounded-md border border-input bg-background px-2 text-sm">
            <option value="" disabled>{{ t('ui.choose') }}</option>
            <option v-for="item in versions.versions.value" :key="item.version" :value="String(item.version)">v{{ item.version }}</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label for="compare-against" class="text-sm font-medium">{{ t('strategy.compareAgainst') }}</label>
          <select id="compare-against" v-model="compareAgainst" class="h-9 rounded-md border border-input bg-background px-2 text-sm">
            <option value="" disabled>{{ t('ui.choose') }}</option>
            <option v-for="item in versions.versions.value" :key="item.version" :value="String(item.version)">v{{ item.version }}</option>
          </select>
        </div>
        <Button type="submit" variant="outline" size="sm">{{ t('strategy.compareAction') }}</Button>
      </form>
      <LoadingState v-if="versions.diffLoading.value" />
      <ErrorState v-else-if="versions.diffError.value" :error="versions.diffError.value" @retry="compareSelected" />
      <StrategyDiffView v-else-if="versions.diff.value" :diff="versions.diff.value" />
    </section>
  </div>
</template>
