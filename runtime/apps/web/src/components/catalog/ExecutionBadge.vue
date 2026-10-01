<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ExecutionBadge.vue
 * @description Badge d'exécution (E1 à E6, 04 § 3.1) : fetch seul, fetch dans le navigateur, Playwright seul, agentique +
 * fetch, script + agent, full agentique. Texte seul : le libellé suffit.
 * @component
 * @example <ExecutionBadge execution="fetch" />
 */
import { useI18n } from 'vue-i18n';
import type { Execution } from '@/composables/useApiCatalog';

defineProps<{ execution: Execution | null }>();
const { t } = useI18n();
</script>

<template>
  <span v-if="execution" class="inline-flex items-center rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground" data-testid="execution-badge">
    {{ t(`execution.${execution}`) }}
  </span>
  <span v-else class="text-sm text-muted-foreground">{{ t('ui.none') }}</span>
</template>
