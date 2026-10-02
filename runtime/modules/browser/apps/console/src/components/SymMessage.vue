<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file SymMessage.vue
 * @description Quand SYM parle (04d § 5.1) : signature « SYM : » de packages/ui (icône SVG, espace insécable avant le
 * deux-points en français) suivie du message. Jamais pour une erreur (20 § 2.3) : les erreurs sont des alertes sans signature.
 * @component
 */
import { SymSignature } from '@runtime/ui';
import { useI18n } from 'vue-i18n';

defineProps<{ text: string }>();
const { locale } = useI18n();
</script>

<template>
  <p class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
    <SymSignature variant="speaking" :locale="locale === 'fr' ? 'fr' : 'en'" />
    <span>{{ text }}</span>
  </p>
</template>
