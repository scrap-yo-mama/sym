<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file BlockedPanel.vue
 * @description Panneau « Bloquée » (06 § 2) : un arrêt volontaire (INV6), pas une panne. Trois parties (ce qui s'est
 * passé, pourquoi on s'arrête, ce que tu peux faire), l'essai déclencheur et le coût déjà dépensé. AUCUN bouton ni lien
 * vers le tunnel, aucun bouton de relance, aucun réglage réseau (A7) : le seul bouton de reprise est « Ré-enquêter »
 * (manuel, transition 18). Ton factuel, ni nom d'outil de protection ni description de ce que le site a détecté.
 * @component
 * @example <BlockedPanel :detail="detail" :pending="false" @reinvestigate="onReinvestigate" />
 */
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, useRouter } from 'vue-router';
import { Button } from '@/components/ui/button';
import type { ApiDetail } from '@/composables/useApiDetail';
import { copyText } from '@/lib/clipboard';
import { formatDateTime, formatUsd } from '@/lib/display-format';
import { safeHref } from '@/lib/links';

const props = defineProps<{ detail: ApiDetail; pending?: boolean }>();
defineEmits<{ reinvestigate: [] }>();
const { t, te, locale } = useI18n();

type Variant = 'blocked_by_protection' | 'robots_disallowed' | 'forbidden';
const variant = computed<Variant>(() => {
  const code = props.detail.status_reason?.code;
  return code === 'robots_disallowed' || code === 'forbidden' ? code : 'blocked_by_protection';
});

const params = computed(() => props.detail.status_reason?.params ?? {});
const domain = computed(() => {
  const named = params.value.domain;
  return typeof named === 'string' && named !== '' ? named : (props.detail.requires.session_domain ?? t('blockedPanel.thisSite'));
});

function labelled(prefix: 'execution' | 'network', value: unknown): string | null {
  return typeof value === 'string' && te(`${prefix}.${value}`) ? t(`${prefix}.${value}`) : null;
}

/** Phrase « ce qui s'est passé » : l'essai déclencheur quand le serveur le décrit, sinon la réponse seule. */
const what = computed(() => {
  if (variant.value === 'robots_disallowed') return t('blockedPanel.what.robots');
  if (variant.value === 'forbidden') return t('blockedPanel.what.forbidden');
  const answer = t(params.value.kind === 'challenge' ? 'blockedPanel.answer.challenge' : 'blockedPanel.answer.refusal');
  const date = typeof params.value.at === 'string' ? formatDateTime(params.value.at, locale.value) : null;
  const attempt = params.value.attempt;
  const execution = labelled('execution', params.value.execution);
  const network = labelled('network', params.value.network);
  if (date && typeof attempt === 'number' && execution && network) {
    return t('blockedPanel.what.attempt', { date, n: String(attempt), execution, network, domain: domain.value, answer });
  }
  return t('blockedPanel.what.generic', { domain: domain.value, answer });
});

const why = computed(() => t(variant.value === 'robots_disallowed' ? 'blockedPanel.why.robots' : variant.value === 'forbidden' ? 'blockedPanel.why.forbidden' : 'blockedPanel.why.protection'));

const cost = computed(() => (typeof params.value.cost_usd === 'number' ? formatUsd(params.value.cost_usd, locale.value, true) : null));
const officialApi = computed(() => safeHref(props.detail.access_report?.official_api_url));
const runId = computed(() => (typeof params.value.run_id === 'string' ? params.value.run_id : (props.detail.recent_runs?.[0]?.id ?? null)));

/**
 * « Pourquoi cet arrêt ? » mène à la page « Usage responsable » (17 § 9, tâche 4.8). Tant que la console n'a pas cette
 * route, le lien n'est pas affiché : il ouvrirait la page 404 dans un nouvel onglet.
 */
const RESPONSIBLE_USE = '/responsible-use';
const router = useRouter();
const responsibleUse = computed(() => {
  const resolved = router.resolve(RESPONSIBLE_USE);
  return resolved.matched.length === 0 || resolved.name === 'not-found' ? null : RESPONSIBLE_USE;
});

const copied = ref<'idle' | 'done' | 'failed'>('idle');
async function copyTemplate(): Promise<void> {
  copied.value = (await copyText(t('blockedPanel.request.template', { domain: domain.value }))) ? 'done' : 'failed';
}
</script>

<template>
  <section class="flex flex-col gap-4 rounded-lg border-2 border-zinc-700 bg-card p-4 dark:border-zinc-400" aria-labelledby="blocked-title" data-testid="blocked-panel" :data-variant="variant">
    <h2 id="blocked-title" class="text-lg font-semibold">{{ t('blockedPanel.title', { domain }) }}</h2>

    <div data-testid="blocked-what">
      <h3 class="font-medium">{{ t('blockedPanel.what.title') }}</h3>
      <p>{{ what }}</p>
      <p v-if="variant === 'blocked_by_protection'" class="text-muted-foreground">{{ t('blockedPanel.noOtherAttempt') }}</p>
      <p v-if="cost" class="text-muted-foreground" data-testid="blocked-cost">{{ t('blockedPanel.cost', { cost }) }}</p>
    </div>

    <div data-testid="blocked-why">
      <h3 class="font-medium">{{ t('blockedPanel.why.title') }}</h3>
      <p>{{ why }}</p>
    </div>

    <div data-testid="blocked-todo">
      <h3 class="font-medium">{{ t('blockedPanel.todo.title') }}</h3>
      <ol class="list-decimal pl-5">
        <li>
          {{ t('blockedPanel.todo.official') }}
          <a v-if="officialApi" :href="officialApi" rel="noopener noreferrer" target="_blank" class="underline underline-offset-4" data-testid="official-api-link">{{ t('blockedPanel.todo.officialLink') }}</a>
        </li>
        <li>{{ t('blockedPanel.todo.otherSource') }}</li>
        <li>{{ t('blockedPanel.todo.contact') }}</li>
        <li>{{ t('blockedPanel.todo.later') }}</li>
      </ol>
    </div>

    <div class="flex flex-wrap items-center gap-3">
      <Button :disabled="pending" data-testid="reinvestigate" @click="$emit('reinvestigate')">{{ t('actions.reinvestigate') }}</Button>
      <Button v-if="runId" variant="outline" as-child>
        <RouterLink :to="`/runs/${runId}`">{{ t('blockedPanel.seeAttempts') }}</RouterLink>
      </Button>
      <Button variant="outline" data-testid="copy-request" @click="copyTemplate">{{ t('blockedPanel.request.copy') }}</Button>
      <a v-if="responsibleUse" :href="responsibleUse" target="_blank" rel="noopener" class="text-sm underline underline-offset-4">{{ t('blockedPanel.whyStop') }}</a>
    </div>
    <p role="status" class="text-sm text-muted-foreground">
      <template v-if="copied === 'done'">{{ t('ui.copied') }}</template>
      <template v-else-if="copied === 'failed'">{{ t('ui.copyFailed') }}</template>
    </p>
  </section>
</template>
