<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ApiRunsTab.vue
 * @description « Runs & datasets » (06 § 2) : historique paginé (déclencheur, état, résultat propre, dégradé ou échec,
 * raisons, durée, coût, items), rétention affichée, vue Table des items avec champs absents marqués, export JSON ou CSV
 * (flux du serveur, cellules neutralisées, 08b). Relancer ouvre le formulaire pré-rempli, avec le choix de la version et
 * un avertissement sur les effets de bord. Métadonnées seules pour l'admin sur un run avec session d'autrui, et pour tout run d'un
 * autre membre (état, coût, durée) : ni items, ni export, ni relance, son contenu n'est jamais lu (`assert_admin_metadata_only`).
 * « Reprises » (tâche 2.13) ouvre le panneau des reprises par étape d'un run de l'appelant (consultation seule).
 * @component
 * @example <ApiRunsTab :detail="detail" slug="zz-books" />
 */
import { computed, onServerPrefetch, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import LaunchForm from '@/components/api/LaunchForm.vue';
import RunRepairsPanel from '@/components/api/RunRepairsPanel.vue';
import ErrorState from '@/components/ErrorState.vue';
import LoadingState from '@/components/LoadingState.vue';
import { Button } from '@/components/ui/button';
import { useApiActions } from '@/composables/useApiActions';
import { datasetExportUrl, useApiRuns, type RunSummary } from '@/composables/useApiRuns';
import type { ApiDetail } from '@/composables/useApiDetail';
import { formatDate, formatDateTime, formatDuration, formatUsd } from '@/lib/display-format';
import { describeFailureClass, describeReasonCode } from '@/lib/reasons';

const props = defineProps<{ detail: ApiDetail; slug: string }>();
const { t, te, locale } = useI18n();
const runs = useApiRuns(() => props.slug);
const actions = useApiActions(() => props.slug);
onServerPrefetch(() => runs.refetch());

function reasons(run: RunSummary): string[] {
  const degraded = run.degraded_reasons.map((code) => describeReasonCode((key, named) => t(key, named ?? {}), te, code));
  return run.failure_class ? [...degraded, describeFailureClass((key, named) => t(key, named ?? {}), te, run.failure_class)] : degraded;
}

/** Colonnes de la vue Table : celles de `views`, sinon la réunion des clés des items. */
const columns = computed(() => {
  const declared = props.detail.views?.columns;
  if (declared && declared.length > 0) return declared;
  return [...new Set(runs.items.value.flatMap((item) => Object.keys(item)))];
});

function cell(item: Record<string, unknown>, column: string): string | null {
  if (!(column in item) || item[column] === undefined || item[column] === null) return null;
  const value = item[column];
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

const openRun = ref<RunSummary | null>(null);
const openDataset = computed(() => openRun.value?.dataset_id ?? null);
async function showItems(run: RunSummary): Promise<void> {
  if (!run.dataset_id || !runs.isOwn(run)) return;
  openRun.value = run;
  await runs.showItems(run);
}

const relaunch = ref<{ run: RunSummary; input: Record<string, unknown> | undefined } | null>(null);
const relaunchedRun = ref<string | null>(null);
const relaunchError = ref(false);

async function startRelaunch(run: RunSummary): Promise<void> {
  relaunchError.value = false;
  relaunchedRun.value = null;
  try {
    const input = await runs.relaunchInput(run);
    if (input === null) return;
    relaunch.value = { run, input };
  } catch {
    relaunchError.value = true;
  }
}

const versions = computed(() => {
  const run = relaunch.value?.run;
  const currentVersion = props.detail.current_strategy_version;
  if (!run || !currentVersion) return undefined;
  const list = [{ version: currentVersion, current: true }];
  if (run.strategy_version && run.strategy_version !== currentVersion) list.push({ version: run.strategy_version, current: false });
  return list;
});

async function submitRelaunch(input: Record<string, unknown>, version: number | undefined): Promise<void> {
  relaunchedRun.value = await actions.launch(input, version);
  if (relaunchedRun.value) {
    relaunch.value = null;
    await runs.refetch();
  }
}

const repairsFor = ref<RunSummary | null>(null);
async function showRepairs(run: RunSummary): Promise<void> {
  if (!runs.isOwn(run)) return;
  repairsFor.value = run;
  await runs.showRepairs(run);
}

const instructedRunUsd = computed(() => (props.detail.instructed_mode === true ? (props.detail.instructed?.estimated_run_usd ?? null) : undefined));

const canRelaunch = computed(() => props.detail.status !== 'bloquee' && !props.detail.metadata_only);
</script>

<template>
  <div class="flex flex-col gap-6">
    <section aria-labelledby="runs-history" class="flex flex-col gap-3">
      <h2 id="runs-history" class="text-lg font-semibold">{{ t('runsTab.history') }}</h2>
      <p v-if="detail.retention_days" class="text-sm text-muted-foreground" data-testid="retention">{{ t('runsTab.retention', { n: String(detail.retention_days) }, detail.retention_days) }}</p>
      <LoadingState v-if="runs.loading.value && runs.runs.value.length === 0" />
      <ErrorState v-else-if="runs.error.value" :error="runs.error.value" @retry="runs.refetch()" />
      <p v-else-if="runs.runs.value.length === 0" class="text-sm text-muted-foreground">{{ t('runsTab.empty') }}</p>
      <div v-else class="relative overflow-x-auto rounded-lg border">
        <table class="w-full min-w-[56rem] text-left text-sm" data-testid="runs-table">
          <caption class="sr-only">{{ t('runsTab.history') }}</caption>
          <thead class="bg-muted text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('runsTab.columns.run') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('runsTab.columns.trigger') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('runsTab.columns.result') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('runsTab.columns.duration') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('runsTab.columns.cost') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('runsTab.columns.items') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('runsTab.columns.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="run in runs.runs.value" :key="run.id" class="border-t align-top" data-testid="runs-tab-row">
              <th scope="row" class="px-3 py-2 font-normal">
                <RouterLink :to="`/runs/${run.id}`" class="underline underline-offset-4">{{ formatDateTime(run.created_at, locale) }}</RouterLink>
                <p v-if="run.retention_until" class="text-xs text-muted-foreground">{{ t('runsTab.keptUntil', { date: formatDate(run.retention_until, locale) }) }}</p>
                <span v-if="!runs.isOwn(run)" class="block text-xs text-muted-foreground" data-testid="run-other">{{ t('runs.other') }}</span>
              </th>
              <td class="px-3 py-2">{{ t(`runsTab.triggers.${run.trigger}`) }}</td>
              <td class="px-3 py-2">
                <p>{{ t(`runsTab.states.${run.state}`) }}<template v-if="run.outcome"> · {{ t(`runsTab.outcomes.${run.outcome}`) }}</template></p>
                <ul v-if="reasons(run).length > 0" class="text-xs text-muted-foreground">
                  <li v-for="reason in reasons(run)" :key="reason">{{ reason }}</li>
                </ul>
              </td>
              <td class="px-3 py-2 whitespace-nowrap">{{ formatDuration(run.duration_ms, locale) }}</td>
              <td class="px-3 py-2 whitespace-nowrap">{{ formatUsd(run.cost.total_usd, locale, run.cost.estimated ?? false) }}</td>
              <td class="px-3 py-2">{{ run.items ?? '—' }}</td>
              <td class="px-3 py-2">
                <div class="flex flex-wrap gap-2">
                  <template v-if="run.dataset_id && !detail.metadata_only && runs.isOwn(run)">
                    <Button variant="outline" size="xs" @click="showItems(run)">{{ t('runsTab.viewItems') }}</Button>
                    <Button variant="outline" size="xs" as-child><a :href="datasetExportUrl(run.dataset_id, 'json')" download>{{ t('runsTab.exportJson') }}</a></Button>
                    <Button variant="outline" size="xs" as-child><a :href="datasetExportUrl(run.dataset_id, 'csv')" download>{{ t('runsTab.exportCsv') }}</a></Button>
                  </template>
                  <Button v-if="canRelaunch && runs.isOwn(run)" variant="outline" size="xs" @click="startRelaunch(run)">{{ t('actions.relaunch') }}</Button>
                  <Button v-if="!detail.metadata_only && runs.isOwn(run)" variant="outline" size="xs" data-testid="show-repairs" @click="showRepairs(run)">{{ t('repairs.show') }}</Button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="runs.hasMore()"><Button variant="outline" size="sm" :disabled="runs.loadingMore.value" @click="runs.loadMore()">{{ t('ui.loadMore') }}</Button></div>
      <p v-if="relaunchError" role="alert" class="sym-error">{{ t('runsTab.relaunchUnavailable') }}</p>
      <p v-if="relaunchedRun" role="status" class="text-sm">
        {{ t('launch.started') }} <RouterLink :to="`/runs/${relaunchedRun}`" class="underline underline-offset-4">{{ t('launch.followRun') }}</RouterLink>
      </p>
    </section>

    <section v-if="relaunch" aria-labelledby="runs-relaunch" class="rounded-lg border p-4">
      <h2 id="runs-relaunch" class="sr-only">{{ t('launch.relaunchTitle') }}</h2>
      <LaunchForm :schema="detail.input_schema" :estimate="detail.cost_estimate" :initial-input="relaunch.input" :instructed-run-usd="instructedRunUsd" :versions="versions ?? [{ version: detail.current_strategy_version ?? 1, current: true }]" :pending="actions.pending.value === 'launch'" :error="actions.error.value" @submit="submitRelaunch" />
    </section>

    <section v-if="repairsFor" aria-labelledby="runs-repairs" class="flex flex-col gap-3">
      <h2 id="runs-repairs" class="text-lg font-semibold">{{ t('repairs.runTitle', { date: formatDateTime(repairsFor.created_at, locale) }) }}</h2>
      <LoadingState v-if="runs.repairsLoading.value && !runs.repairsRun.value" />
      <ErrorState v-else-if="runs.repairsError.value" :error="runs.repairsError.value" @retry="repairsFor && showRepairs(repairsFor)" />
      <RunRepairsPanel v-else-if="runs.repairsRun.value" :run="runs.repairsRun.value" />
    </section>

    <section v-if="openDataset" aria-labelledby="runs-items" class="flex flex-col gap-3">
      <h2 id="runs-items" class="text-lg font-semibold">{{ t('runsTab.items') }}</h2>
      <LoadingState v-if="runs.itemsLoading.value && runs.items.value.length === 0" />
      <ErrorState v-else-if="runs.itemsError.value" :error="runs.itemsError.value" @retry="openRun && showItems(openRun)" />
      <p v-else-if="runs.items.value.length === 0" class="text-sm text-muted-foreground">{{ t('runsTab.noItems') }}</p>
      <div v-else class="relative overflow-x-auto rounded-lg border">
        <table class="w-full text-left text-sm" data-testid="items-table">
          <caption class="sr-only">{{ t('runsTab.items') }}</caption>
          <thead class="bg-muted text-xs uppercase tracking-wide text-muted-foreground">
            <tr><th v-for="column in columns" :key="column" scope="col" class="px-3 py-2 font-medium">{{ column }}</th></tr>
          </thead>
          <tbody>
            <tr v-for="(item, index) in runs.items.value" :key="index" class="border-t">
              <td v-for="column in columns" :key="column" class="px-3 py-2">
                <template v-if="cell(item, column) !== null">{{ cell(item, column) }}</template>
                <span v-else class="text-muted-foreground" data-testid="absent-field"><span aria-hidden="true">∅</span> {{ t('runsTab.absent') }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="runs.itemsHasMore()"><Button variant="outline" size="sm" @click="runs.loadItems(openDataset, true)">{{ t('ui.loadMore') }}</Button></div>
    </section>
  </div>
</template>
