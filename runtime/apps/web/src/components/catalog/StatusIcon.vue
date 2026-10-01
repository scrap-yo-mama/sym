<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file StatusIcon.vue
 * @description Icône d'un statut d'API : une forme distincte par statut (06 § 2), décorative (le libellé et la raison
 * portent le sens). Tracés fins, `currentColor`, aucune image externe ni style en ligne (CSP stricte).
 * @component
 * @example <StatusIcon name="hourglass" />
 */
import type { StatusIcon } from '@/lib/status';

defineProps<{ name: StatusIcon }>();
</script>

<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    :data-icon="name"
    class="size-4 shrink-0"
  >
    <template v-if="name === 'hourglass'">
      <path d="M6 2h12M6 22h12M7 2v4l5 6-5 6v4M17 2v4l-5 6 5 6v4" />
    </template>
    <template v-else-if="name === 'check-circle'">
      <circle cx="12" cy="12" r="10" />
      <path d="M8 12l3 3 5-6" />
    </template>
    <template v-else-if="name === 'triangle'">
      <path d="M12 3L2 21h20L12 3z" />
      <path d="M12 10v5M12 18h.01" />
    </template>
    <template v-else-if="name === 'wrench'">
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />
    </template>
    <template v-else-if="name === 'octagon-x'">
      <path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </template>
    <template v-else-if="name === 'diamond-exclamation'">
      <path d="M12 2l10 10-10 10L2 12z" />
      <path d="M12 8v5M12 16h.01" />
    </template>
    <template v-else>
      <circle cx="12" cy="12" r="10" />
      <path d="M5 5l14 14" />
    </template>
  </svg>
</template>
