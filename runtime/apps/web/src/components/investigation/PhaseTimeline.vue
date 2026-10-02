<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file PhaseTimeline.vue
 * @description Frise des quatre jalons d'une enquête (06 § 2, 20 § 5.3) : Décrire, Reconnaître, Valider le schéma, Essayer.
 * Mêmes clés et mêmes libellés que le récit MCP et les journaux (`packages/core/src/investigation/milestones.ts`, `assert_milestones_same_labels`).
 * Liste ordonnée `<ol>` ; le jalon en cours porte `aria-current="step"`. L'état d'un jalon n'est jamais porté par la couleur
 * seule : carré numéroté (coche pour « fait », carré plein pour « arrêté ») et état écrit (« à faire », « en cours », « fait », « arrêté »).
 * Un arrêt marque le jalon où l'enquête s'est arrêtée « arrêté », jamais « fait », et ne propose aucune suite.
 * @component
 * @example <PhaseTimeline :states="milestoneView(state, { created: true })" />
 */
import { useI18n } from 'vue-i18n';
import { INVESTIGATION_MILESTONES, type InvestigationMilestone, type MilestoneState } from '@/lib/investigation';

interface Props {
  states: Readonly<Record<InvestigationMilestone, MilestoneState>>;
}

defineProps<Props>();
const { t } = useI18n();

const MARKERS: Record<MilestoneState, (n: number) => string> = {
  todo: (n) => String(n),
  current: (n) => String(n),
  done: () => '✓',
  stopped: () => '■',
};

/** Surface du carré par état : jaune (signature) en cours, aqua fait, anthracite arrêté, carte à faire. */
const TONES: Record<MilestoneState, string> = {
  todo: 'border-border bg-card text-muted-foreground',
  current: 'border-status-border bg-signature text-signature-foreground',
  done: 'border-status-border bg-status-sain text-status-sain-foreground',
  stopped: 'border-status-border bg-status-bloquee text-status-bloquee-foreground',
};
</script>

<template>
  <ol class="flex flex-wrap gap-x-5 gap-y-2" :aria-label="t('investigation.milestones.label')" data-testid="phase-timeline">
    <li
      v-for="(milestone, at) in INVESTIGATION_MILESTONES"
      :key="milestone"
      class="flex items-center gap-2 text-sm"
      :aria-current="states[milestone] === 'current' ? 'step' : undefined"
      :data-milestone="milestone"
      :data-state="states[milestone]"
    >
      <span class="inline-flex size-7 shrink-0 items-center justify-center rounded-md border-2 text-sm font-bold" :class="TONES[states[milestone]]" aria-hidden="true">{{ MARKERS[states[milestone]](at + 1) }}</span>
      <span :class="states[milestone] === 'todo' ? 'text-muted-foreground' : 'font-medium'">{{ t(`investigation.milestones.${milestone}`) }}</span>
      <span class="text-muted-foreground">({{ t(`investigation.milestones.state.${states[milestone]}`) }})</span>
    </li>
  </ol>
</template>
