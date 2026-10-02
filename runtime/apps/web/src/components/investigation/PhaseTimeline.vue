<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file PhaseTimeline.vue
 * @description Frise des quatre jalons d'une enquête (06 § 2, 20 § 5.3, planche NouvelleApi.dc.html) : pastilles « 1 · Décrire »,
 * « 2 · Reconnaître », « 3 · Valider le schéma », « 4 · Essayer », reliées par des traits. Fait : pastille papier avec une coche ;
 * en cours : pastille bleue (`aria-current="step"`) ; à faire : pastille en pointillés ; arrêté : pastille anthracite avec un
 * carré plein. Mêmes clés et mêmes libellés que le récit MCP et les journaux (`packages/core/src/investigation/milestones.ts`,
 * `assert_milestones_same_labels`). L'état d'un jalon n'est jamais porté par la couleur seule : il est écrit (« (fait) »), pour
 * les lecteurs d'écran, à côté de la forme (coche, carré, pointillés). Un arrêt marque le jalon où l'enquête s'est arrêtée
 * « arrêté », jamais « fait », et ne propose aucune suite.
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

/** Pastille par état (planche) : papier coché, bleue en cours, pointillés à faire, anthracite arrêtée. */
const TONES: Record<MilestoneState, string> = {
  done: 'bg-card text-card-foreground',
  current: 'bg-primary text-primary-foreground',
  todo: 'border-[1.5px] border-dashed border-sym-todo text-muted-foreground',
  stopped: 'bg-status-bloquee text-status-bloquee-foreground',
};

/** Trait qui suit un jalon : plein jusqu'au jalon en cours, clair ensuite. */
const linkTone = (state: MilestoneState): string => (state === 'done' ? 'bg-foreground' : 'bg-nav-muted-foreground');
</script>

<template>
  <ol class="flex flex-wrap items-center gap-x-2.5 gap-y-2" :aria-label="t('investigation.milestones.label')" data-testid="phase-timeline">
    <li
      v-for="(milestone, at) in INVESTIGATION_MILESTONES"
      :key="milestone"
      class="flex items-center gap-2.5"
      :aria-current="states[milestone] === 'current' ? 'step' : undefined"
      :data-milestone="milestone"
      :data-state="states[milestone]"
    >
      <span class="inline-flex min-h-9 items-center gap-2 rounded-full px-3.5 py-2 text-sm leading-none font-bold" :class="TONES[states[milestone]]" data-testid="milestone-pill">
        <svg v-if="states[milestone] === 'done'" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true" focusable="false" class="size-3.5 text-sym-aqua-ink dark:text-status-sain">
          <path d="M5 12l5 5L20 7" />
        </svg>
        <span v-else-if="states[milestone] === 'stopped'" aria-hidden="true">■</span>
        {{ t('investigation.milestones.step', { n: at + 1, label: t(`investigation.milestones.${milestone}`) }) }}
      </span>
      <span class="sr-only">({{ t(`investigation.milestones.state.${states[milestone]}`) }})</span>
      <span v-if="at < INVESTIGATION_MILESTONES.length - 1" class="h-0.5 w-7" :class="linkTone(states[milestone])" aria-hidden="true" data-testid="milestone-link"></span>
    </li>
  </ol>
</template>
