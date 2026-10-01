<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file AccessSignal.vue
 * @description Pastille « Accès » (17 § 2) : robots.txt autorise (coche), signal à examiner (œil), interdit (cercle barré).
 * Forme et libellé en plus de la teinte : jamais la couleur seule.
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
  allowed: 'text-emerald-800 dark:text-emerald-300',
  review: 'text-amber-800 dark:text-amber-300',
  disallowed: 'text-red-800 dark:text-red-300',
};
const known = computed(() => (props.signal === 'allowed' || props.signal === 'review' || props.signal === 'disallowed' ? props.signal : null));
</script>

<template>
  <span v-if="known" class="inline-flex items-center gap-1.5 text-sm" :class="TONE[known]" data-testid="access-signal" :data-signal="known">
    <StatusIcon :name="ICON[known]" />
    <span>{{ t(`access.signal.${known}`) }}</span>
  </span>
  <span v-else class="text-sm text-muted-foreground" data-testid="access-signal" data-signal="unknown">{{ t('access.signal.unknown') }}</span>
</template>
