<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file LoadingState.vue
 * @description Chargement : texte annoncé poliment (`role="status"`), sans animation requise.
 * @component
 * @example <LoadingState />
 */
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
</script>

<template>
  <p role="status" class="text-sm text-muted-foreground" data-testid="loading-state">{{ t('ui.loading') }}</p>
</template>
