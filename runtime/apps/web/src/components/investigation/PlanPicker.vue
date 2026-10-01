<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file PlanPicker.vue
 * @description Plan d'essais affiché après la reconnaissance (06 § 2) : restreignable avant l'exécution (exclure le mode
 * agentique, par exemple), dans les bornes de la politique réseau. On peut retirer des méthodes, jamais en ajouter ; au
 * moins une reste cochée. Le serveur applique la restriction (`exclude_executions`).
 * @component
 * @example <PlanPicker :plan="state.plan" v-model="excluded" />
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatUsd } from '@/lib/format';
import { toggleExcluded, type Execution, type PlanStep } from '@/lib/investigation';

interface Props {
  plan: readonly PlanStep[];
  /** Méthodes exclues. */
  modelValue: readonly Execution[];
  disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), { disabled: false });

interface Emits {
  (e: 'update:modelValue', value: Execution[]): void;
}
const emit = defineEmits<Emits>();

const { t, locale } = useI18n();
const remaining = computed(() => props.plan.filter((step) => !props.modelValue.includes(step.execution)).length);

function toggle(execution: Execution, box: HTMLInputElement): void {
  const next = toggleExcluded(props.plan, props.modelValue, execution, box.checked);
  emit('update:modelValue', next);
  // Si la liste n'a pas changé (dernière méthode), la case revient à son état : le DOM ne se re-rend pas de lui-même.
  box.checked = !next.includes(execution);
}
</script>

<template>
  <fieldset class="flex flex-col gap-2 rounded-lg border p-3" :disabled="disabled" data-testid="plan-picker">
    <legend class="px-1 text-sm font-medium">{{ t('investigation.plan.title') }}</legend>
    <p class="text-sm text-muted-foreground">{{ t('investigation.plan.hint') }}</p>
    <label v-for="step in plan" :key="`${step.execution}-${step.network}`" class="flex min-h-11 items-center gap-2 text-sm">
      <input
        type="checkbox"
        class="size-4"
        :checked="!modelValue.includes(step.execution)"
        :aria-describedby="remaining <= 1 ? 'plan-at-least-one' : undefined"
        @change="toggle(step.execution, $event.target as HTMLInputElement)"
      />
      <span>
        {{ t(`execution.${step.execution}`) }}<template v-if="step.network">, {{ t(`network.${step.network}`) }}</template>
        <span v-if="formatUsd(step.estCostUsd, locale, true)" class="text-muted-foreground"> ({{ t('investigation.plan.estimate', { cost: formatUsd(step.estCostUsd, locale, true) }) }})</span>
      </span>
    </label>
    <p v-if="remaining <= 1" id="plan-at-least-one" class="text-sm text-muted-foreground">{{ t('investigation.plan.atLeastOne') }}</p>
  </fieldset>
</template>
