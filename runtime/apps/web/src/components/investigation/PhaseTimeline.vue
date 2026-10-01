<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file PhaseTimeline.vue
 * @description Frise à 4 jalons de `investigation_phase` (06 § 2). L'état d'un jalon n'est jamais porté par la couleur
 * seule : forme du marqueur et texte (« terminée », « en cours », « à venir ») restent lisibles (WCAG 1.4.1).
 * @component
 * @example <PhaseTimeline :phase="state.phase" />
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { PHASE_MILESTONES, type InvestigationPhase } from '@/lib/investigation';

interface Props {
  phase: InvestigationPhase | null;
}

const props = defineProps<Props>();
const { t } = useI18n();

const stepper = computed(() => {
  const current = props.phase === null ? -1 : props.phase === 'done' ? PHASE_MILESTONES.length : PHASE_MILESTONES.indexOf(props.phase);
  return PHASE_MILESTONES.map((milestone, at) => ({
    milestone,
    state: at < current ? ('done' as const) : at === current ? ('current' as const) : ('upcoming' as const),
  }));
});

const MARKERS = { done: '✓', current: '●', upcoming: '○' } as const;
</script>

<template>
  <ol class="flex flex-wrap gap-x-4 gap-y-1" :aria-label="t('investigation.phase.label')" data-testid="phase-timeline">
    <li v-for="step in stepper" :key="step.milestone" class="flex items-center gap-1 text-sm" :aria-current="step.state === 'current' ? 'step' : undefined" :data-state="step.state">
      <span aria-hidden="true">{{ MARKERS[step.state] }}</span>
      <span :class="step.state === 'upcoming' ? 'text-muted-foreground' : 'font-medium'">{{ t(`investigation.phase.${step.milestone}`) }}</span>
      <span class="sr-only">({{ t(`investigation.phase.state.${step.state}`) }})</span>
    </li>
  </ol>
</template>
