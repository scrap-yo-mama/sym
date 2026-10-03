<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file RunRepairsPanel.vue
 * @description Panneau « Reprises » d'un run (19 § 4, r2 R12, tâche 2.13) : une ligne par essai de reprise d'étape
 * (`step_id` non nul) avec l'étape, le niveau (1 localisateurs enregistrés, 2 agent sur l'étape, 3 segment d'étapes),
 * l'issue, le coût, les jetons et le diff de l'étape (patch RFC 6902). Badge « réparée automatiquement » quand le run
 * l'a été. Le niveau et l'issue sont écrits en toutes lettres (jamais la couleur seule) ; les valeurs du patch, lues sur
 * une page, sont du texte brut.
 * @component
 * @example <RunRepairsPanel :run="run" />
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatUsd } from '@/lib/display-format';
import { attemptTokens, patchLines, repairsCost, stepAttempts, type Run } from '@/lib/step-repairs';

const props = defineProps<{ run: Run }>();
const { t, locale } = useI18n();

const rows = computed(() => stepAttempts(props.run));
const total = computed(() => repairsCost(rows.value));
const number = (value: number): string => new Intl.NumberFormat(locale.value).format(value);
</script>

<template>
  <section aria-labelledby="run-repairs-heading" class="flex flex-col gap-3" data-testid="run-repairs">
    <div class="flex flex-wrap items-center gap-2">
      <h3 id="run-repairs-heading" class="text-base font-semibold">{{ t('repairs.title') }}</h3>
      <span
        v-if="run.repaired_automatically"
        class="inline-flex items-center rounded-md border border-foreground px-2 py-0.5 text-xs font-medium"
        data-testid="repaired-automatically"
      >{{ t('repairs.autoRepaired') }}</span>
    </div>
    <p v-if="rows.length === 0" class="text-sm text-muted-foreground" data-testid="run-repairs-empty">{{ t('repairs.empty') }}</p>
    <template v-else>
      <p class="text-sm text-muted-foreground" data-testid="run-repairs-total">{{ t('repairs.total', { n: String(rows.length), cost: formatUsd(total, locale) }, rows.length) }}</p>
      <div class="relative overflow-x-auto rounded-lg border">
        <table class="w-full min-w-[48rem] text-left text-sm" data-testid="run-repairs-table">
          <caption class="sr-only">{{ t('repairs.caption') }}</caption>
          <thead class="bg-muted text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('repairs.columns.step') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('repairs.columns.level') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('repairs.columns.outcome') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('repairs.columns.cost') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('repairs.columns.tokens') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('repairs.columns.diff') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="attempt in rows" :key="attempt.index" class="border-t align-top" data-testid="run-repair-row" :data-step="attempt.step_id" :data-level="attempt.step_level ?? ''">
              <th scope="row" class="px-3 py-2 font-mono font-normal">{{ attempt.step_id }}</th>
              <td class="px-3 py-2" data-testid="repair-level">
                <template v-if="attempt.step_level">{{ t(`repairs.level.${attempt.step_level}`) }}</template>
                <template v-else>{{ t('ui.none') }}</template>
              </td>
              <td class="px-3 py-2" data-testid="repair-outcome">
                <template v-if="attempt.step_outcome">{{ t(`repairs.outcome.${attempt.step_outcome}`) }}</template>
                <template v-else>{{ t('ui.none') }}</template>
              </td>
              <td class="px-3 py-2 whitespace-nowrap" data-testid="repair-cost">{{ formatUsd(attempt.cost_usd, locale) }}</td>
              <td class="px-3 py-2 whitespace-nowrap" data-testid="repair-tokens">
                <template v-if="attemptTokens(attempt)">{{ t(attemptTokens(attempt)?.estimated ? 'repairs.tokensEstimated' : 'repairs.tokens', { in: number(attemptTokens(attempt)?.in ?? 0), out: number(attemptTokens(attempt)?.out ?? 0) }) }}</template>
                <template v-else>{{ t('ui.none') }}</template>
              </td>
              <td class="px-3 py-2" data-testid="repair-diff">
                <pre v-if="patchLines(attempt.step_patch).length > 0" class="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs"><code><template v-for="(line, i) in patchLines(attempt.step_patch)" :key="i"><span :data-op="line.op"><span class="sr-only">{{ t(`repairs.op.${line.op}`) }} </span><span aria-hidden="true">{{ line.sign }} </span>{{ line.path }}<template v-if="line.value !== null"> {{ line.value }}</template></span>{{ '\n' }}</template></code></pre>
                <span v-else class="text-muted-foreground">{{ t('repairs.noDiff') }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>
