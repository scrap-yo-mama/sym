<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file StatusBadge.vue
 * @description Badge de statut : icône de forme distincte + libellé (jamais la couleur seule, WCAG 1.4.1). Le drapeau
 * `stale` ajoute la pastille « Données anciennes » à un statut `sain` ou `warning`, sans créer de statut.
 * @component
 * @example <StatusBadge status="sain" :stale="true" />
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import StatusIcon from '@/components/catalog/StatusIcon.vue';
import { showsStaleFlag, STATUS_ICON, STATUS_TONE, type ApiStatus } from '@/lib/status';

const props = withDefaults(defineProps<{ status: ApiStatus; stale?: boolean }>(), { stale: false });
const { t } = useI18n();
const stale = computed(() => showsStaleFlag(props.status, props.stale));
</script>

<template>
  <span class="inline-flex flex-wrap items-center gap-1.5">
    <span class="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-sm font-medium" :class="STATUS_TONE[status]" data-testid="status-badge" :data-status="status">
      <StatusIcon :name="STATUS_ICON[status]" />
      <span>{{ t(`status.${status}`) }}</span>
    </span>
    <span v-if="stale" class="inline-flex items-center rounded-md border border-dashed px-2 py-0.5 text-xs font-medium text-muted-foreground" data-testid="stale-flag">
      {{ t('status.staleFlag') }}
    </span>
  </span>
</template>
