<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file InstructedStepsPanel.vue
 * @description Section « Agent instruit » d'une API non compilable (19 § 4, arbitrage n° 5, tâche 2.13) : étapes
 * instruites à confirmer (intention en texte brut, conditions de sortie), bouton « Confirmer ces étapes » et
 * interrupteur « Activer l'agent instruit », avec le coût estimé par run. Jamais activé par défaut ; l'état de
 * l'interrupteur est celui du serveur (un refus le laisse éteint, avec un message). Les intentions sont écrites par un
 * LLM qui a lu des pages : contenu non fiable, inséré comme texte, jamais comme balisage. Le parent ne rend cette section ni
 * sur une API bloquée ni ailleurs que sur la vue d'ensemble (`instructedOffered`).
 * @component
 * @example <InstructedStepsPanel :instructed="detail.instructed" :enabled="false" :pending="null" :error="null" @confirm="confirm" @toggle="setEnabled" />
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import type { ApiRequestError } from '@/lib/api-result';
import { formatDateTime, formatUsd } from '@/lib/display-format';
import { instructedConfirmed, postParts, type InstructedSteps } from '@/lib/step-repairs';

const props = defineProps<{
  instructed: InstructedSteps;
  enabled: boolean;
  pending: 'confirm' | 'toggle' | null;
  error: ApiRequestError | null;
}>();
const emit = defineEmits<{ confirm: []; toggle: [enabled: boolean] }>();
const { t, te, locale } = useI18n();

const confirmed = computed(() => instructedConfirmed(props.instructed));
const cost = computed(() => (props.instructed.estimated_run_usd === null ? t('instructed.costUnknown') : t('instructed.cost', { cost: formatUsd(props.instructed.estimated_run_usd, locale.value, true) })));

const errorText = computed(() => {
  const failure = props.error;
  if (!failure) return null;
  if (failure.code && te(`apiErrors.${failure.code}`)) return t(`apiErrors.${failure.code}`);
  if (failure.status === 409) return t('apiErrors.conflict');
  return t(failure.status === 0 ? 'apiErrors.network' : 'apiErrors.generic');
});

function toggle(): void {
  if (props.pending) return;
  emit('toggle', !props.enabled);
}
</script>

<template>
  <section id="instructed" aria-labelledby="instructed-heading" class="flex flex-col gap-3 rounded-lg border p-4" data-testid="instructed-panel">
    <h2 id="instructed-heading" class="text-lg font-semibold">{{ t('instructed.title') }}</h2>
    <p class="text-sm">{{ t('instructed.intro') }}</p>
    <p class="text-sm font-medium" data-testid="instructed-cost">{{ cost }}</p>

    <h3 class="text-base font-semibold">{{ t('instructed.stepsTitle') }}</h3>
    <p class="text-sm text-muted-foreground">{{ t('instructed.untrusted') }}</p>
    <ol class="flex list-decimal flex-col gap-2 pl-6 text-sm" data-testid="instructed-steps">
      <li v-for="step in instructed.steps" :key="step.id" data-testid="instructed-step" :data-step="step.id">
        <p><span class="font-mono text-xs text-muted-foreground">{{ step.id }}</span> <span data-testid="instructed-intent">{{ step.intent }}</span></p>
        <ul v-if="step.post.length > 0" class="list-disc pl-5 text-xs text-muted-foreground">
          <li v-for="(post, i) in step.post" :key="i">
            {{ t(`instructed.post.${postParts(post).kind}`) }}<template v-if="postParts(post).detail"> : <span class="font-mono">{{ postParts(post).detail }}</span></template>
          </li>
        </ul>
        <p v-else class="text-xs text-muted-foreground">{{ t('instructed.noPost') }}</p>
      </li>
    </ol>

    <p v-if="confirmed" class="text-sm" data-testid="instructed-confirmed">{{ t('instructed.confirmedAt', { date: formatDateTime(instructed.confirmed_at, locale) }) }}</p>
    <div v-else class="flex flex-col gap-2">
      <p class="text-sm text-muted-foreground">{{ t('instructed.confirmHint') }}</p>
      <div>
        <Button variant="outline" :aria-disabled="pending ? 'true' : undefined" data-testid="instructed-confirm" @click="!pending && emit('confirm')">{{ t('instructed.confirm') }}</Button>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-3">
      <button
        id="instructed-switch"
        type="button"
        role="switch"
        :aria-checked="enabled ? 'true' : 'false'"
        :aria-disabled="pending ? 'true' : undefined"
        class="inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="instructed-switch"
        @click="toggle"
      >
        <span aria-hidden="true" class="inline-block h-5 w-9 rounded-full border border-foreground p-0.5"><span class="block size-3.5 rounded-full bg-foreground" :class="enabled ? 'translate-x-4' : ''" /></span>
        {{ t('instructed.enable') }}
      </button>
      <span class="text-sm" data-testid="instructed-state">{{ enabled ? t('instructed.on') : t('instructed.off') }}</span>
    </div>
    <p v-if="errorText" role="alert" class="sym-error" data-testid="instructed-error">{{ errorText }}</p>
  </section>
</template>
