<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ErrorAlert.vue
 * @description Erreur d'un écran (tâche 3.6) : code stable du contrat traduit (jamais la phrase du serveur), surface orange à
 * texte anthracite (04d § 5.4), annoncée (`role="alert"`) ; bouton « Réessayer » si l'écran sait recharger.
 * @component
 */
import { useI18n } from 'vue-i18n';
import { screenErrorKey } from '../i18n.js';
import ConsoleButton from './ConsoleButton.vue';

defineProps<{ code: string; retry?: () => void }>();
const { t } = useI18n();
</script>

<template>
  <div class="flex flex-wrap items-center gap-3">
    <p role="alert" class="sym-error">{{ t(screenErrorKey(code)) }}</p>
    <ConsoleButton v-if="retry" type="button" variant="outline" size="sm" @click="retry">{{ t('console.errors.retry') }}</ConsoleButton>
  </div>
</template>
