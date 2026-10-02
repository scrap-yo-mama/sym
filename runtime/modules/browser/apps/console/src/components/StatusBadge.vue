<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file StatusBadge.vue
 * @description Pastille de statut (04d § 5.1 et § 5.4) : icône + libellé + couleur, jamais la couleur seule. Sessions :
 * `pending` (papier bordé), `running` (aqua), `ended` (anthracite), `timed_out` (jaune), `failed` (orange, texte
 * anthracite). Nœuds : `ready` (aqua), `draining` (jaune), `down` (orange). Couleurs : jetons de statut de packages/ui.
 * @component
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{ status: string; kind: 'session' | 'node' }>();
const { t } = useI18n();

type Tone = 'pending' | 'running' | 'ended' | 'timed_out' | 'failed';
const NODE_TONES: Record<string, Tone> = { ready: 'running', draining: 'timed_out', down: 'failed' };
const tone = computed<Tone>(() => (props.kind === 'node' ? (NODE_TONES[props.status] ?? 'pending') : (props.status as Tone)));
const CLASSES: Record<Tone, string> = {
  pending: 'bg-status-pending text-status-pending-foreground',
  running: 'bg-status-running text-status-running-foreground',
  ended: 'bg-status-ended text-status-ended-foreground',
  timed_out: 'bg-status-timed-out text-status-timed-out-foreground',
  failed: 'bg-status-failed text-status-failed-foreground',
};
const label = computed(() => t(`console.status.${props.kind}.${props.status}`));
</script>

<template>
  <span
    :data-status="status"
    :class="['inline-flex items-center gap-1.5 rounded-full border border-status-border px-2.5 py-0.5 text-xs font-bold whitespace-nowrap', CLASSES[tone]]"
  >
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle v-if="tone === 'pending'" cx="8" cy="8" r="5" />
      <path v-else-if="tone === 'running'" d="M5 3.5v9l7-4.5z" fill="currentColor" />
      <path v-else-if="tone === 'ended'" d="M3 8.5l3 3 7-7" />
      <path v-else-if="tone === 'timed_out'" d="M8 4v4l2.5 2M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z" />
      <path v-else d="M4 4l8 8M12 4l-8 8" />
    </svg>
    <span>{{ label }}</span>
  </span>
</template>
