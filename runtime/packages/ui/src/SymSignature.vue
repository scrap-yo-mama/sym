<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file SymSignature.vue
 * @description Signature SYM (20 § 2.3) : icône SVG décorative (`aria-hidden`) à côté du texte « SYM », jamais l'emoji.
 * `speaking` (SYM parle) ajoute le deux-points, précédé d'une espace insécable en français ; `badge` (marque, statut)
 * n'en met pas. Le nom accessible est le texte « SYM » : le deux-points est masqué aux lecteurs d'écran. Jamais sur un
 * badge de statut d'API, le panneau « Bloquée », une erreur, un consentement ni un coût (20 § 2.3).
 * @component
 * @example <SymSignature variant="speaking" locale="fr" />
 */
import { computed } from 'vue';
import { SYM_GHOST_PATH, SYM_GHOST_VIEWBOX } from './sym-ghost.ts';

const props = withDefaults(defineProps<{ variant?: 'speaking' | 'badge'; locale?: string }>(), { variant: 'badge', locale: 'en' });
const colon = computed(() => (props.locale === 'fr' ? ' :' : ':'));
</script>

<template>
  <span class="sym-signature" data-sym-signature :data-variant="variant">
    <svg class="sym-signature__icon" xmlns="http://www.w3.org/2000/svg" :viewBox="SYM_GHOST_VIEWBOX" fill="currentColor" aria-hidden="true" focusable="false">
      <path fill-rule="evenodd" :d="SYM_GHOST_PATH" />
    </svg>
    <span class="sym-signature__text">SYM</span>
    <span v-if="variant === 'speaking'" aria-hidden="true">{{ colon }}</span>
  </span>
</template>
