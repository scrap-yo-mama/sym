<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file BudgetCounter.vue
 * @description Compteur de budget en direct (06 § 2) : dollars et secondes sur `investigation_budget_usd` et
 * `investigation_timeout_s`, plus « retenu : ~X $ ; un agent complet : ~Y $ » (estimation, toujours préfixée de ~).
 * Les valeurs viennent du serveur ; la console ne recalcule aucun budget.
 * @component
 * @example <BudgetCounter :budget="state.budget" :elapsed-s="elapsedS" />
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatDuration, formatUsd } from '@/lib/format';
import type { BudgetView } from '@/lib/investigation';

interface Props {
  budget: BudgetView | null;
  /** Secondes écoulées, déjà avancées par le chronomètre de l'écran. */
  elapsedS: number | null;
}

const props = defineProps<Props>();
const { t, locale } = useI18n();

const unknown = computed(() => t('common.unknown'));
const spent = computed(() => formatUsd(props.budget?.spentUsd, locale.value) ?? unknown.value);
const max = computed(() => formatUsd(props.budget?.maxUsd, locale.value) ?? unknown.value);
const elapsed = computed(() => formatDuration(props.elapsedS === null ? null : props.elapsedS * 1000, locale.value) ?? unknown.value);
const timeout = computed(() => formatDuration(props.budget?.timeoutS === null || props.budget?.timeoutS === undefined ? null : props.budget.timeoutS * 1000, locale.value) ?? unknown.value);
const retained = computed(() => formatUsd(props.budget?.retainedEstUsd, locale.value, true));
const full = computed(() => formatUsd(props.budget?.fullAgentEstUsd, locale.value, true));
</script>

<template>
  <section class="flex flex-col gap-3 rounded-lg border p-3" aria-labelledby="budget-title" data-testid="budget-counter">
    <h2 id="budget-title" class="text-sm font-medium">{{ t('investigation.budget.title') }}</h2>
    <div class="flex flex-col gap-1">
      <label for="budget-money" class="text-sm text-muted-foreground">{{ t('investigation.budget.moneyLine', { spent, max }) }}</label>
      <progress id="budget-money" class="h-2 w-full" :value="budget?.spentUsd ?? 0" :max="budget?.maxUsd && budget.maxUsd > 0 ? budget.maxUsd : 1" />
    </div>
    <div class="flex flex-col gap-1">
      <label for="budget-time" class="text-sm text-muted-foreground">{{ t('investigation.budget.timeLine', { elapsed, timeout }) }}</label>
      <progress id="budget-time" class="h-2 w-full" :value="elapsedS ?? 0" :max="budget?.timeoutS && budget.timeoutS > 0 ? budget.timeoutS : 1" />
    </div>
    <p class="text-sm text-muted-foreground" data-testid="budget-estimate">
      {{ retained && full ? t('investigation.budget.estimate', { retained, full }) : t('investigation.budget.estimateUnknown') }}
    </p>
  </section>
</template>
