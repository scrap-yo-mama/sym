<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file TestOutcome.vue
 * @description Résultat lisible d'un bouton **Tester** (06 § 2) : « non testé » tant qu'il ne l'a pas été, puis réussite
 * ou échec lisible (code stable traduit), avec l'IP et le pays de sortie d'un proxy. Région `role="status"`.
 * @component
 * @example <TestOutcome :outcome="outcomes[proxy.id]" :tested-at="proxy.tested_at" />
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TestOutcome } from '@/composables/useResource';
import { useReason } from '@/composables/useReason';
import { formatDateTime } from '@/lib/format';

interface Props {
  outcome?: TestOutcome;
  /** Dernier test connu du serveur (ISO 8601) ; null : jamais testé. */
  testedAt?: string | null;
}

const props = withDefaults(defineProps<Props>(), { outcome: undefined, testedAt: null });
const { t, locale } = useI18n();
const { reasonText } = useReason();

const text = computed(() => {
  const outcome = props.outcome;
  if (outcome?.state === 'running') return t('settings.testing');
  if (outcome?.state === 'failed') return t(outcome.messageKey);
  if (outcome?.state === 'done') {
    const date = formatDateTime(outcome.testedAt, locale.value);
    const parts = [outcome.ok ? t('settings.testOk') : t('settings.testFailed')];
    if (!outcome.ok && outcome.reason) parts.push(reasonText(outcome.reason));
    if (outcome.ok && outcome.detail.exit_ip) parts.push(t('settings.proxies.exit', { ip: outcome.detail.exit_ip, country: outcome.detail.exit_country ?? t('common.unknown') }));
    if (date) parts.push(t('settings.testedAt', { date }));
    return parts.join(' · ');
  }
  const date = formatDateTime(props.testedAt, locale.value);
  return date ? t('settings.testedAt', { date }) : t('settings.notTested');
});
const failed = computed(() => props.outcome?.state === 'failed' || (props.outcome?.state === 'done' && !props.outcome.ok));
</script>

<template>
  <p role="status" class="text-sm" :class="failed ? 'text-destructive' : 'text-muted-foreground'" data-testid="test-outcome">{{ text }}</p>
</template>
