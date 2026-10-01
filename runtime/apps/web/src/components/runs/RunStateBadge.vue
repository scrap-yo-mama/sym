<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file RunStateBadge.vue
 * @description État d'un run : icône de forme distincte plus libellé en texte. Un état n'est jamais porté par la couleur
 * seule (WCAG 1.4.1, 06 § 1).
 * @component
 * @example <RunStateBadge state="running" />
 */
import { useI18n } from 'vue-i18n';
import type { RunState } from '@/composables/useRuns';

interface Props {
  state: RunState;
}

defineProps<Props>();
const { t } = useI18n();

/** Une forme par famille d'état (les icônes sont décoratives, le libellé porte le sens). */
const GLYPHS: Record<RunState, string> = {
  queued: '◷',
  running: '▶',
  waiting_tunnel: '⏸',
  succeeded: '✓',
  failed: '✕',
  cancelled: '■',
  skipped_tunnel_offline: '↷',
  skipped_window: '↷',
  skipped_quota: '↷',
  skipped_status: '↷',
  skipped_overlap: '↷',
};
</script>

<template>
  <span class="inline-flex items-center gap-1 whitespace-nowrap text-sm" :data-state="state">
    <span aria-hidden="true">{{ GLYPHS[state] }}</span>
    <span>{{ t(`runs.state.${state}`) }}</span>
  </span>
</template>
