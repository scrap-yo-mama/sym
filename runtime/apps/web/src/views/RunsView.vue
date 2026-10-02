<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file RunsView.vue
 * @description « Tous les runs » (06 § 2) : vue transversale filtrable par API, état, déclencheur et période, à pagination
 * serveur (curseur). Métadonnées seules : état, coût, durée ; jamais le contenu d'un run d'un autre membre, et aucun
 * contrôle d'impersonation (INV12, A3). États chargement, erreur avec relance et vide.
 * @page
 */
import { computed, onMounted, onServerPrefetch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import RunStateBadge from '@/components/runs/RunStateBadge.vue';
import PageHeader from '@/components/brand/PageHeader.vue';
import SymIllustration from '@/components/brand/SymIllustration.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useReason } from '@/composables/useReason';
import { RUN_STATES, RUN_TRIGGERS, useRuns, type RunSummary } from '@/composables/useRuns';
import { useSession } from '@/composables/useSession';
import { selectClass } from '@/lib/classes';
import { formatDateTime, formatDuration, formatUsd } from '@/lib/format';

const { t, locale } = useI18n();
const { reasonShort, resultLabel } = useReason();
const { me } = useSession();
const { filters, runs, loading, failure, hasNext, hasPrevious, pageNumber, apply, refresh, next, previous, reset } = useRuns();

onMounted(() => void apply());
onServerPrefetch(() => apply());

const filtered = computed(() => filters.api.trim() !== '' || filters.state !== '' || filters.trigger !== '' || filters.since !== '' || filters.until !== '');

const isOthers = (run: RunSummary): boolean => me.value !== null && run.owner_id !== me.value.id;
const costOf = (run: RunSummary): string => formatUsd(run.cost.total_usd, locale.value, run.cost.estimated === true) ?? '—';
const startedOf = (run: RunSummary): string => formatDateTime(run.started_at ?? run.created_at, locale.value) ?? '—';
const outcomeOf = (run: RunSummary): string => {
  if (run.outcome) return t(`runs.outcome.${run.outcome}`);
  return run.failure_class ? resultLabel(run.failure_class) : '—';
};
</script>

<template>
  <section class="mx-auto flex max-w-7xl flex-col gap-4 py-8" aria-labelledby="runs-heading">
    <PageHeader heading-id="runs-heading" :title="t('runs.title')" :kicker="t('brand.kicker.runs')">
      <p class="sym-lead">{{ t('runs.intro') }}</p>
    </PageHeader>

    <form class="flex flex-wrap items-end gap-3" novalidate data-testid="runs-filters" @submit.prevent="apply()">
      <fieldset class="flex flex-wrap items-end gap-3">
        <legend class="sr-only">{{ t('runs.filters.legend') }}</legend>
        <div class="flex flex-col gap-1">
          <Label for="runs-api">{{ t('runs.filters.api') }}</Label>
          <Input id="runs-api" class="w-48" autocomplete="off" :model-value="filters.api" @update:model-value="(value: string | number) => (filters.api = String(value))" />
        </div>
        <div class="flex flex-col gap-1">
          <Label for="runs-state">{{ t('runs.filters.state') }}</Label>
          <select id="runs-state" v-model="filters.state" :class="selectClass">
            <option value="">{{ t('runs.filters.all') }}</option>
            <option v-for="state in RUN_STATES" :key="state" :value="state">{{ t(`runs.state.${state}`) }}</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <Label for="runs-trigger">{{ t('runs.filters.trigger') }}</Label>
          <select id="runs-trigger" v-model="filters.trigger" :class="selectClass">
            <option value="">{{ t('runs.filters.all') }}</option>
            <option v-for="trigger in RUN_TRIGGERS" :key="trigger" :value="trigger">{{ t(`runs.trigger.${trigger}`) }}</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <Label for="runs-since">{{ t('runs.filters.since') }}</Label>
          <Input id="runs-since" type="date" :model-value="filters.since" @update:model-value="(value: string | number) => (filters.since = String(value))" />
        </div>
        <div class="flex flex-col gap-1">
          <Label for="runs-until">{{ t('runs.filters.until') }}</Label>
          <Input id="runs-until" type="date" :model-value="filters.until" @update:model-value="(value: string | number) => (filters.until = String(value))" />
        </div>
      </fieldset>
      <Button type="submit">{{ t('runs.filters.apply') }}</Button>
      <Button type="button" variant="outline" @click="reset()">{{ t('runs.filters.reset') }}</Button>
      <Button type="button" variant="outline" @click="refresh()">{{ t('runs.filters.refresh') }}</Button>
    </form>

    <p v-if="loading && runs.length === 0" role="status" class="text-sm text-muted-foreground">{{ t('runs.loading') }}</p>

    <Alert v-else-if="failure" variant="destructive" data-testid="runs-error">
      <AlertDescription class="flex flex-wrap items-center gap-3">
        {{ t(failure) }}
        <Button type="button" variant="outline" size="sm" @click="refresh()">{{ t('common.retry') }}</Button>
      </AlertDescription>
    </Alert>

    <div v-else-if="runs.length === 0" class="flex flex-col items-start gap-3 rounded-xl border bg-card p-6" data-testid="runs-empty">
      <SymIllustration compact class="max-w-sm" />
      <h2 class="text-lg font-semibold">{{ filtered ? t('runs.emptyFiltered.title') : t('runs.empty.title') }}</h2>
      <p class="text-sm text-muted-foreground">{{ filtered ? t('runs.emptyFiltered.text') : t('runs.empty.text') }}</p>
      <Button v-if="!filtered" as-child><RouterLink to="/apis/new">{{ t('runs.empty.button') }}</RouterLink></Button>
    </div>

    <div v-else class="relative overflow-x-auto rounded-xl border bg-card">
      <table class="w-full text-left text-sm" data-testid="runs-table" :aria-busy="loading">
        <caption class="sr-only">{{ t('runs.caption') }}</caption>
        <thead class="border-b bg-muted/50">
          <tr>
            <th scope="col" class="p-3 font-medium">{{ t('runs.columns.api') }}</th>
            <th scope="col" class="p-3 font-medium">{{ t('runs.columns.trigger') }}</th>
            <th scope="col" class="p-3 font-medium">{{ t('runs.columns.state') }}</th>
            <th scope="col" class="p-3 font-medium">{{ t('runs.columns.outcome') }}</th>
            <th scope="col" class="p-3 font-medium">{{ t('runs.columns.reasons') }}</th>
            <th scope="col" class="p-3 font-medium">{{ t('runs.columns.duration') }}</th>
            <th scope="col" class="p-3 font-medium">{{ t('runs.columns.cost') }}</th>
            <th scope="col" class="p-3 font-medium">{{ t('runs.columns.items') }}</th>
            <th scope="col" class="p-3 font-medium">{{ t('runs.columns.started') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="run in runs" :key="run.id" class="border-b last:border-0" data-testid="run-row">
            <th scope="row" class="p-3 font-normal">
              <RouterLink :to="`/apis/${run.api_slug}`" class="font-medium underline underline-offset-4">{{ run.api_slug }}</RouterLink>
              <span v-if="isOthers(run)" class="block text-xs text-muted-foreground" data-testid="run-other">{{ t('runs.other') }}</span>
            </th>
            <td class="p-3">{{ t(`runs.trigger.${run.trigger}`) }}</td>
            <td class="p-3"><RunStateBadge :state="run.state" /></td>
            <td class="p-3">{{ outcomeOf(run) }}</td>
            <td class="p-3">{{ run.degraded_reasons.map(reasonShort).join(', ') || '—' }}</td>
            <td class="p-3">{{ formatDuration(run.duration_ms, locale) ?? '—' }}</td>
            <td class="p-3">{{ costOf(run) }}</td>
            <td class="p-3">{{ run.items ?? '—' }}</td>
            <td class="p-3">{{ startedOf(run) }}<span v-if="!run.started_at" class="block text-xs text-muted-foreground">{{ t('runs.notStarted') }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>

    <nav v-if="hasPrevious || hasNext" class="flex flex-wrap items-center gap-3" :aria-label="t('runs.page', { n: pageNumber })">
      <Button type="button" variant="outline" :disabled="!hasPrevious || loading" @click="previous()">{{ t('runs.previous') }}</Button>
      <span class="text-sm" aria-live="polite">{{ t('runs.page', { n: pageNumber }) }}</span>
      <Button type="button" variant="outline" :disabled="!hasNext || loading" @click="next()">{{ t('runs.next') }}</Button>
    </nav>
  </section>
</template>
