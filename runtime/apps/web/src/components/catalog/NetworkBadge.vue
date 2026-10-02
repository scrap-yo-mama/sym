<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file NetworkBadge.vue
 * @description Badge réseau (direct, proxy serveur, résidentiel, tunnel). Pur affichage de la stratégie courante : aucun
 * réglage réseau ici (INV6, A7).
 * @component
 * @example <NetworkBadge network="direct" />
 */
import { useI18n } from 'vue-i18n';
import type { Network } from '@/composables/useApiCatalog';

withDefaults(defineProps<{ network: Network | null; /** Texte seul, sans pastille (colonne « MODE · RÉSEAU » de la planche du catalogue). */ plain?: boolean }>(), { plain: false });
const { t } = useI18n();
</script>

<template>
  <span v-if="network && plain" data-testid="network-badge">{{ t(`network.${network}`) }}</span>
  <span v-else-if="network" class="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium" data-testid="network-badge">
    {{ t(`network.${network}`) }}
  </span>
  <span v-else class="text-sm text-muted-foreground">{{ t('ui.none') }}</span>
</template>
