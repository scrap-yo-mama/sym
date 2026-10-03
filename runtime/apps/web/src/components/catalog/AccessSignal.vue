<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file AccessSignal.vue
 * @description Pastille « Accès » (17 § 2) : vert, rien à signaler (coche) ; orange, à examiner (triangle). La valeur
 * `disallowed` est historique (rapports anciens, D-91) : elle reste lisible (cercle barré, « refus signalé »), sans
 * rien promettre sur le robots.txt, qui ne conditionne pas la collecte. Forme et libellé en plus de la teinte : jamais la
 * couleur seule.
 * @component
 * @example <AccessSignal signal="allowed" />
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import StatusIcon from '@/components/catalog/StatusIcon.vue';
import type { StatusIcon as IconName } from '@/lib/status';

type AccessSignalValue = 'allowed' | 'review' | 'disallowed' | null | undefined;

const props = defineProps<{ signal: AccessSignalValue }>();
const { t } = useI18n();

const ICON: Record<'allowed' | 'review' | 'disallowed', IconName> = { allowed: 'check-circle', review: 'triangle', disallowed: 'circle-slash' };
const TONE: Record<'allowed' | 'review' | 'disallowed', string> = {
  allowed: 'bg-status-sain text-status-sain-foreground',
  review: 'bg-status-warning text-status-warning-foreground',
  disallowed: 'bg-status-bloquee text-status-bloquee-foreground',
};
const known = computed(() => (props.signal === 'allowed' || props.signal === 'review' || props.signal === 'disallowed' ? props.signal : null));
</script>

<template>
  <span v-if="known" class="inline-flex items-center gap-1.5 rounded-full border border-status-border px-2.5 py-0.5 text-sm font-medium" :class="TONE[known]" data-testid="access-signal" :data-signal="known">
    <StatusIcon :name="ICON[known]" />
    <span>{{ t(`access.signal.${known}`) }}</span>
  </span>
  <span v-else class="text-sm text-muted-foreground" data-testid="access-signal" data-signal="unknown">{{ t('access.signal.unknown') }}</span>
</template>
