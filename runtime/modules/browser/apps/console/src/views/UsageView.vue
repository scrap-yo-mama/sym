<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file UsageView.vue
 * @description Écran Consommation (04d § 5.2 et § 4, tâche 3.6) : période (mois UTC courant par défaut), courbe des secondes
 * facturées par jour (SVG titré et décrit, avec le tableau par jour en équivalent textuel), tableau par clé, export CSV
 * (`GET /v1/usage.csv`, même origine) et écart de réconciliation avec réconciliation à la demande.
 * @page
 */
import { computed, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { UsageQuery } from '../api/types.js';
import ConsoleButton from '../components/ConsoleButton.vue';
import ErrorAlert from '../components/ErrorAlert.vue';
import SymMessage from '../components/SymMessage.vue';
import { useConsoleApi } from '../composables/console-api.js';
import { useLoad } from '../composables/load.js';
import { formatBytes, formatDate, formatDay, formatNumber } from '../lib/format.js';

const { t, locale } = useI18n();
const api = useConsoleApi();

const PRESETS = ['current-month', 'previous-month', 'last-7', 'last-30', 'custom'] as const;
type Preset = (typeof PRESETS)[number];
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Bornes d'une période prédéfinie (jours UTC, comme l'API d'usage, 04d § 4.3). */
function presetRange(preset: Exclude<Preset, 'custom'>, now = new Date()): { from: string; to: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const today = day(now.getTime());
  if (preset === 'current-month') return { from: day(Date.UTC(y, m, 1)), to: today };
  if (preset === 'previous-month') return { from: day(Date.UTC(y, m - 1, 1)), to: day(Date.UTC(y, m, 0)) };
  return { from: day(now.getTime() - (preset === 'last-7' ? 6 : 29) * 86_400_000), to: today };
}

const period = reactive(presetRange('current-month'));
const form = reactive({ preset: 'current-month' as Preset, ...period });
function onPreset(): void {
  if (form.preset !== 'custom') Object.assign(form, presetRange(form.preset));
}
function onDate(): void {
  form.preset = 'custom';
}
const periodError = ref(false);

const query = (groupBy: UsageQuery['groupBy']): UsageQuery => ({ from: period.from, to: period.to, groupBy });
const daily = useLoad(() => api.usage(query('day')));
const byKey = useLoad(() => api.usage(query('key')));
const csvHref = computed(() => api.usageCsvHref(query('key')));

async function apply(): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.from) || !/^\d{4}-\d{2}-\d{2}$/.test(form.to) || form.from > form.to) {
    periodError.value = true;
    return;
  }
  periodError.value = false;
  Object.assign(period, { from: form.from, to: form.to });
  await Promise.all([daily.reload(), byKey.reload()]);
}

const notice = ref('');
const reconcileError = ref<string | null>(null);
async function reconcile(): Promise<void> {
  const result = await api.reconcile();
  if (!result.ok) {
    reconcileError.value = result.code;
    return;
  }
  reconcileError.value = null;
  notice.value = t('console.usage.drift.started');
  await Promise.all([daily.reload(), byKey.reload()]);
}

const drift = computed(() => daily.data.value?.drift ?? byKey.data.value?.drift);

/** Barres de la courbe : une par jour, hauteur proportionnelle aux secondes facturées. */
const chart = computed(() => {
  const items = daily.data.value?.items ?? [];
  const max = Math.max(1, ...items.map((i) => i.billedSeconds));
  const width = 640;
  const height = 160;
  const step = items.length > 0 ? width / items.length : width;
  return {
    width,
    height,
    bars: items.map((item, index) => {
      const h = Math.round((item.billedSeconds / max) * (height - 10));
      return { day: item.day ?? '', x: index * step + 1, y: height - h, w: Math.max(1, step - 2), h, seconds: item.billedSeconds };
    }),
  };
});
</script>

<template>
  <section class="mx-auto flex w-full max-w-6xl flex-col gap-6" aria-labelledby="usage-title">
    <h1 id="usage-title" data-route-heading tabindex="-1" class="text-4xl">{{ t('console.usage.title') }}</h1>

    <form class="rounded-xl border border-border bg-card p-4 text-card-foreground" novalidate @submit.prevent="apply">
      <fieldset class="flex flex-wrap items-end gap-4">
        <legend class="mb-2 font-display text-lg font-extrabold">{{ t('console.usage.period.legend') }}</legend>
        <div class="flex flex-col gap-1">
          <label for="usage-preset" class="text-sm font-bold">{{ t('console.usage.period.preset') }}</label>
          <select id="usage-preset" v-model="form.preset" class="min-h-11 rounded-md border border-input bg-background px-3" @change="onPreset">
            <option v-for="preset in PRESETS" :key="preset" :value="preset">{{ t(`console.usage.period.presets.${preset}`) }}</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label for="usage-from" class="text-sm font-bold">{{ t('console.usage.period.from') }}</label>
          <input id="usage-from" v-model="form.from" type="date" :aria-invalid="periodError ? 'true' : undefined" class="min-h-11 rounded-md border border-input bg-background px-3" @input="onDate" />
        </div>
        <div class="flex flex-col gap-1">
          <label for="usage-to" class="text-sm font-bold">{{ t('console.usage.period.to') }}</label>
          <input id="usage-to" v-model="form.to" type="date" :aria-invalid="periodError ? 'true' : undefined" class="min-h-11 rounded-md border border-input bg-background px-3" @input="onDate" />
        </div>
        <ConsoleButton id="usage-apply" type="submit">{{ t('console.usage.period.apply') }}</ConsoleButton>
      </fieldset>
      <p v-if="periodError" role="alert" class="sym-error mt-3">{{ t('console.errors.invalid_option') }}</p>
    </form>

    <p v-if="(daily.loading.value && !daily.data.value) || (byKey.loading.value && !byKey.data.value)" role="status">{{ t('console.common.loading') }}</p>
    <div v-else data-loaded class="flex flex-col gap-6">
      <ErrorAlert v-if="daily.error.value" :code="daily.error.value" :retry="daily.reload" />
      <div v-else-if="(daily.data.value?.items.length ?? 0) === 0" class="rounded-xl border border-border bg-card p-6 text-card-foreground">
        <SymMessage :text="t('console.usage.empty')" />
      </div>
      <template v-else>
        <figure class="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 text-card-foreground">
          <svg
            :viewBox="`0 0 ${chart.width} ${chart.height}`"
            role="img"
            aria-labelledby="usage-chart-title usage-chart-desc"
            class="h-40 w-full"
            preserveAspectRatio="none"
          >
            <title id="usage-chart-title">{{ t('console.usage.chart.title') }}</title>
            <desc id="usage-chart-desc">{{ t('console.usage.chart.description', { from: period.from, to: period.to, total: formatNumber(daily.data.value?.totals.billedSeconds ?? 0, locale) }) }}</desc>
            <line x1="0" :y1="chart.height - 0.5" :x2="chart.width" :y2="chart.height - 0.5" class="stroke-foreground" stroke-width="1" />
            <rect v-for="bar in chart.bars" :key="bar.day" :x="bar.x" :y="bar.y" :width="bar.w" :height="bar.h" class="fill-primary" />
          </svg>
          <figcaption class="font-bold">{{ t('console.usage.chart.title') }}</figcaption>
        </figure>

        <div class="max-h-96 overflow-auto rounded-xl border border-border bg-card text-card-foreground" tabindex="0" :aria-label="t('console.usage.daily.caption')">
          <table class="w-full text-left text-sm">
            <caption class="p-4 text-left font-bold">{{ t('console.usage.daily.caption') }}</caption>
            <thead class="border-b border-border">
              <tr>
                <th scope="col" class="px-4 py-2">{{ t('console.usage.daily.day') }}</th>
                <th scope="col" class="px-4 py-2 text-end">{{ t('console.usage.columns.sessions') }}</th>
                <th scope="col" class="px-4 py-2 text-end">{{ t('console.usage.columns.seconds') }}</th>
                <th scope="col" class="px-4 py-2 text-end">{{ t('console.usage.columns.bytesIn') }}</th>
                <th scope="col" class="px-4 py-2 text-end">{{ t('console.usage.columns.bytesOut') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in daily.data.value?.items" :key="item.day" class="border-b border-border last:border-0">
                <th scope="row" class="px-4 py-2 font-normal whitespace-nowrap"><time :datetime="item.day">{{ formatDay(item.day ?? '', locale) }}</time></th>
                <td class="px-4 py-2 text-end">{{ formatNumber(item.sessions, locale) }}</td>
                <td class="px-4 py-2 text-end">{{ formatNumber(item.billedSeconds, locale) }}</td>
                <td class="px-4 py-2 text-end whitespace-nowrap">{{ formatBytes(item.bytesIn, locale) }}</td>
                <td class="px-4 py-2 text-end whitespace-nowrap">{{ formatBytes(item.bytesOut, locale) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <section class="flex flex-col gap-3" aria-labelledby="usage-key-title">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 id="usage-key-title" class="text-2xl">{{ t('console.usage.byKey.heading') }}</h2>
          <a id="usage-csv" :href="csvHref" download class="inline-flex min-h-11 items-center rounded-md border border-input bg-background px-5 font-bold text-foreground hover:bg-accent">{{ t('console.usage.csv') }}</a>
        </div>
        <ErrorAlert v-if="byKey.error.value" :code="byKey.error.value" :retry="byKey.reload" />
        <div v-else class="overflow-x-auto rounded-xl border border-border bg-card text-card-foreground">
          <table id="usage-by-key" class="w-full text-left text-sm">
            <caption class="p-4 text-left font-bold">{{ t('console.usage.byKey.caption') }}</caption>
            <thead class="border-b border-border">
              <tr>
                <th scope="col" class="px-4 py-2">{{ t('console.usage.byKey.key') }}</th>
                <th scope="col" class="px-4 py-2 text-end">{{ t('console.usage.columns.sessions') }}</th>
                <th scope="col" class="px-4 py-2 text-end">{{ t('console.usage.columns.seconds') }}</th>
                <th scope="col" class="px-4 py-2 text-end">{{ t('console.usage.columns.bytesIn') }}</th>
                <th scope="col" class="px-4 py-2 text-end">{{ t('console.usage.columns.bytesOut') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in byKey.data.value?.items" :key="item.apiKeyId" class="border-b border-border">
                <th scope="row" class="px-4 py-2 font-mono font-normal">{{ item.apiKeyPrefix }}</th>
                <td class="px-4 py-2 text-end">{{ formatNumber(item.sessions, locale) }}</td>
                <td class="px-4 py-2 text-end">{{ formatNumber(item.billedSeconds, locale) }}</td>
                <td class="px-4 py-2 text-end whitespace-nowrap">{{ formatBytes(item.bytesIn, locale) }}</td>
                <td class="px-4 py-2 text-end whitespace-nowrap">{{ formatBytes(item.bytesOut, locale) }}</td>
              </tr>
            </tbody>
            <tfoot v-if="byKey.data.value">
              <tr class="font-bold">
                <th scope="row" class="px-4 py-2">{{ t('console.usage.byKey.total') }}</th>
                <td class="px-4 py-2 text-end">{{ formatNumber(byKey.data.value.totals.sessions, locale) }}</td>
                <td class="px-4 py-2 text-end">{{ formatNumber(byKey.data.value.totals.billedSeconds, locale) }}</td>
                <td class="px-4 py-2 text-end whitespace-nowrap">{{ formatBytes(byKey.data.value.totals.bytesIn, locale) }}</td>
                <td class="px-4 py-2 text-end whitespace-nowrap">{{ formatBytes(byKey.data.value.totals.bytesOut, locale) }}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground" aria-labelledby="usage-drift-title">
        <h2 id="usage-drift-title" class="text-2xl">{{ t('console.usage.drift.heading') }}</h2>
        <p id="usage-drift" aria-live="polite">
          <template v-if="!drift || (drift.seconds === 0 && drift.bytes === 0)">{{ t('console.usage.drift.none') }}</template>
          <template v-else>{{ t('console.usage.drift.value', { seconds: formatNumber(drift.seconds, locale), bytes: formatBytes(drift.bytes, locale), when: formatDate(drift.checkedAt, locale) }) }}</template>
        </p>
        <ErrorAlert v-if="reconcileError" :code="reconcileError" />
        <p role="status" class="font-bold">{{ notice }}</p>
        <div>
          <ConsoleButton id="usage-reconcile" type="button" variant="outline" @click="reconcile">{{ t('console.usage.drift.reconcile') }}</ConsoleButton>
        </div>
      </section>
    </div>
  </section>
</template>
