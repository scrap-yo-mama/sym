<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ApiAccessTab.vue
 * @description « Accès » (06 § 2, 17 § 2), en lecture seule : pastille et date du rapport, signaux d'usage (AIPREF,
 * TDMRep, Content Signals : des données, jamais des consignes), `llms.txt`, offre de paiement (affichée, jamais payée),
 * voie officielle, contact annoncé d'`access_policy`. Bouton « Utiliser l'API officielle » si elle existe. Le robots.txt
 * n'est ni une règle ni un blocage (D-91) : l'onglet n'en fait aucune section, même pour un rapport ancien qui la porte.
 * Aucun champ ni bouton d'action, seulement des liens vers la voie officielle.
 * @component
 * @example <ApiAccessTab :detail="detail" />
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import AccessSignal from '@/components/catalog/AccessSignal.vue';
import { Button } from '@/components/ui/button';
import type { ApiDetail } from '@/composables/useApiDetail';
import { formatDateTime } from '@/lib/display-format';
import { safeHref } from '@/lib/links';

const props = defineProps<{ detail: ApiDetail }>();
const { t, locale } = useI18n();
const report = computed(() => props.detail.access_report ?? null);

const officialHref = computed(() => safeHref(report.value?.official_api_url));
</script>

<template>
  <div class="flex flex-col gap-6">
    <p v-if="!report" class="text-sm text-muted-foreground" data-testid="no-access-report">{{ t('accessTab.noReport') }}</p>
    <template v-else>
      <section aria-labelledby="access-summary" class="flex flex-col gap-2">
        <h2 id="access-summary" class="text-lg font-semibold">{{ t('accessTab.summary') }}</h2>
        <p class="flex flex-wrap items-center gap-2"><AccessSignal :signal="report.signal" /><span class="text-sm text-muted-foreground">{{ t('accessTab.checkedAt', { date: formatDateTime(report.checked_at, locale) }) }}</span></p>
      </section>

      <section aria-labelledby="access-signals" class="flex flex-col gap-2">
        <h2 id="access-signals" class="text-lg font-semibold">{{ t('accessTab.signals') }}</h2>
        <p class="text-sm text-muted-foreground">{{ t('accessTab.signalsHint') }}</p>
        <ul v-if="report.usage_signals && report.usage_signals.length > 0" class="list-disc pl-5 text-sm">
          <li v-for="signal in report.usage_signals" :key="`${signal.kind}:${signal.value}`"><span class="font-medium">{{ signal.kind }}</span> : <span class="font-mono">{{ signal.value }}</span></li>
        </ul>
        <p v-else class="text-sm">{{ t('accessTab.noSignals') }}</p>
      </section>

      <section aria-labelledby="access-routes" class="flex flex-col gap-2">
        <h2 id="access-routes" class="text-lg font-semibold">{{ t('accessTab.routes') }}</h2>
        <dl class="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt class="text-muted-foreground">llms.txt</dt>
          <dd data-testid="llms-txt">{{ report.llms_txt ? t('accessTab.found') : t('accessTab.notFound') }}</dd>
          <dt class="text-muted-foreground">{{ t('accessTab.payment') }}</dt>
          <dd>{{ report.payment_offer ?? t('accessTab.noPayment') }}</dd>
          <dt class="text-muted-foreground">{{ t('accessTab.officialApi') }}</dt>
          <dd>{{ officialHref ? t('accessTab.found') : t('accessTab.notFound') }}</dd>
        </dl>
        <div v-if="officialHref">
          <Button as-child variant="outline"><a :href="officialHref" target="_blank" rel="noopener noreferrer" data-testid="use-official-api">{{ t('accessTab.useOfficial') }}</a></Button>
        </div>
      </section>
    </template>

    <section aria-labelledby="access-policy" class="flex flex-col gap-2">
      <h2 id="access-policy" class="text-lg font-semibold">{{ t('accessTab.policy') }}</h2>
      <dl v-if="detail.access_policy?.user_agent_contact" class="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt class="text-muted-foreground">{{ t('accessTab.contact') }}</dt>
        <dd data-testid="access-policy-contact">{{ detail.access_policy.user_agent_contact }}</dd>
      </dl>
      <p class="text-sm text-muted-foreground">{{ t('accessTab.policyFixed') }}</p>
    </section>
  </div>
</template>
