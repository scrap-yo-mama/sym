<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file InvestigationBoard.vue
 * @description Écran de suivi d'une enquête en direct, en trois colonnes (06 § 2) : ce que voit l'agent, ce que l'agent
 * fait, ce que l'agent a produit. La première colonne montre le dernier essai (méthode, réseau, résultat, coût, durée), puis
 * sa carte requête/réponse quand le flux la donne (`exchange` de `attempt.finished`). Compteur de budget en direct, boutons Pause et « Arrêter l'enquête » (essais conservés),
 * bandeaux « Action requise » et « Bloquée » (sans tunnel). Présentationnel : l'état vient de `useInvestigation`, chaque
 * bouton émet un événement et c'est le serveur qui décide (06 § 4.1).
 * @component
 * @example <InvestigationBoard :state="state" :elapsed-s="elapsedS" :paused="paused" :cancelled="cancelled" :busy="busy" :failure="failure" @pause="pause" />
 */
import { computed, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import BlockedPanel from '@/components/BlockedPanel.vue';
import ActionBanner from '@/components/investigation/ActionBanner.vue';
import AttemptLog from '@/components/investigation/AttemptLog.vue';
import BudgetCounter from '@/components/investigation/BudgetCounter.vue';
import PhaseTimeline from '@/components/investigation/PhaseTimeline.vue';
import SchemaPanel from '@/components/investigation/SchemaPanel.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { Busy } from '@/composables/useInvestigation';
import { useReason } from '@/composables/useReason';
import { formatDuration, formatUsd } from '@/lib/format';
import type { AttemptView, ExchangeView, Execution, InvestigationState } from '@/lib/investigation';

interface Props {
  state: Readonly<InvestigationState>;
  elapsedS: number | null;
  /** Pause demandée par l'utilisateur. */
  paused: boolean;
  /** L'utilisateur a arrêté l'enquête. */
  cancelled: boolean;
  busy: Busy;
  /** Clé i18n de la dernière erreur d'action. */
  failure: string | null;
}

const props = defineProps<Props>();

interface Emits {
  (e: 'pause'): void;
  (e: 'resume'): void;
  (e: 'cancel'): void;
  (e: 'validate', payload: { outputSchema?: Record<string, unknown>; excludeExecutions: Execution[] }): void;
  (e: 'reinvestigate'): void;
}
const emit = defineEmits<Emits>();

const { t, locale } = useI18n();
const { resultLabel } = useReason();

const title = computed(() => (props.state.domain ? t('investigation.title', { domain: props.state.domain }) : t('investigation.titleUnknown')));
const finished = computed(() => props.state.terminal || props.cancelled);
const controlsDisabled = (): boolean => finished.value || props.busy !== null;

// « Suspendre le suivi » (2.2.2) : fige l'affichage des essais et coupe les annonces ; le serveur continue.
const suspended = ref(false);
const frozen = shallowRef<AttemptView[]>([]);
function toggleFollow(): void {
  suspended.value = !suspended.value;
  if (suspended.value) frozen.value = [...props.state.attempts];
}
watch(
  () => props.state.runId,
  () => {
    suspended.value = false;
  },
);
const shownAttempts = computed(() => (suspended.value ? frozen.value : props.state.attempts));
const lastAttempt = computed(() => shownAttempts.value.at(-1) ?? null);

/** Ligne de réponse de la carte : « HTTP 200 · text/html · 18 432 octets » ; un champ absent est omis, jamais inventé. */
function responseLine(exchange: ExchangeView): string {
  const parts = [
    exchange.status === null ? null : t('investigation.seen.exchange.status', { status: exchange.status }),
    exchange.contentType,
    exchange.bytes === null ? null : t('investigation.seen.exchange.bytes', { n: new Intl.NumberFormat(locale.value).format(exchange.bytes) }),
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

const statusLine = computed(() => {
  if (props.cancelled) return t('investigation.controls.stopped', { cost: formatUsd(props.state.budget?.spentUsd, locale.value) ?? t('common.unknown') });
  if (props.paused) return t('investigation.controls.paused');
  const status = props.state.status;
  if (props.state.terminal && (status === 'sain' || status === 'warning' || status === 'erreur' || status === 'bloquee')) return t(`investigation.result.${status}`);
  if (suspended.value) return t('investigation.controls.followSuspended');
  // Changement d'étape (06 § 3, plan des live regions) : la région status annonce l'étape en cours.
  const phase = props.state.phase;
  if (phase && phase !== 'done' && !props.state.terminal) return t('investigation.phase.announce', { phase: t(`investigation.phase.${phase}`) });
  return '';
});

function viewTrials(): void {
  document.getElementById('investigation-log')?.focus();
}
</script>

<template>
  <section class="mx-auto flex max-w-7xl flex-col gap-4 py-8" aria-labelledby="investigation-heading" data-testid="investigation-board">
    <h1 id="investigation-heading" data-route-heading tabindex="-1" class="sym-title">{{ title }}</h1>

    <!-- Étape et état de l'enquête : `role="status"`, un changement d'étape est annoncé sans déplacer le focus -->
    <p role="status" class="min-h-6 text-sm" data-testid="investigation-status">{{ statusLine }}</p>

    <Alert v-if="failure" variant="destructive" data-testid="investigation-failure">
      <AlertDescription>{{ t(failure) }}</AlertDescription>
    </Alert>

    <BlockedPanel
      v-if="state.blocked"
      :cause="state.blocked.cause"
      :domain="state.blocked.domain"
      :at="state.blocked.at"
      :attempt="state.blocked.attempt"
      :cost-usd="state.blocked.costUsd"
      :official-api-url="state.access?.official_api_url ?? null"
      :busy="busy === 'reinvestigate'"
      @reinvestigate="emit('reinvestigate')"
      @view-trials="viewTrials"
    />
    <ActionBanner v-if="state.action" :action="state.action" @reinvestigate="emit('reinvestigate')" />

    <PhaseTimeline :phase="state.phase" />

    <div class="flex flex-wrap items-center gap-3" data-testid="investigation-controls">
      <Button
        v-if="!paused"
        type="button"
        variant="outline"
        :aria-disabled="controlsDisabled()"
        class="aria-disabled:pointer-events-none aria-disabled:opacity-50"
        data-testid="investigation-pause"
        @click="!controlsDisabled() && emit('pause')"
      >
        {{ t('investigation.controls.pause') }}
      </Button>
      <Button
        v-else
        type="button"
        :aria-disabled="finished || busy !== null"
        class="aria-disabled:pointer-events-none aria-disabled:opacity-50"
        data-testid="investigation-resume"
        @click="!(finished || busy !== null) && emit('resume')"
      >
        {{ t('investigation.controls.resume') }}
      </Button>
      <Button
        type="button"
        variant="destructive"
        :aria-disabled="controlsDisabled()"
        aria-describedby="investigation-stop-hint"
        class="aria-disabled:pointer-events-none aria-disabled:opacity-50"
        data-testid="investigation-stop"
        @click="!controlsDisabled() && emit('cancel')"
      >
        {{ t('investigation.controls.stop') }}
      </Button>
      <span id="investigation-stop-hint" class="text-sm text-muted-foreground">{{ t('investigation.controls.stopHint') }}</span>
    </div>

    <BudgetCounter :budget="state.budget" :elapsed-s="elapsedS" />

    <div class="grid gap-4 lg:grid-cols-3">
      <section aria-labelledby="col-seen" class="flex flex-col gap-2" data-testid="column-seen">
        <h2 id="col-seen" class="text-lg font-semibold">{{ t('investigation.columns.seen') }}</h2>
        <p v-if="!lastAttempt" class="text-sm text-muted-foreground">{{ t('investigation.seen.empty') }}</p>
        <div v-else class="rounded-lg border p-3">
          <h3 class="mb-2 text-sm font-medium">{{ t('investigation.seen.lastTrial') }}</h3>
          <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt class="text-muted-foreground">{{ t('investigation.seen.execution') }}</dt>
            <dd>{{ t(`execution.${lastAttempt.execution}`) }}</dd>
            <dt class="text-muted-foreground">{{ t('investigation.seen.network') }}</dt>
            <dd>{{ t(`network.${lastAttempt.network}`) }}</dd>
            <dt class="text-muted-foreground">{{ t('investigation.seen.result') }}</dt>
            <dd>{{ lastAttempt.result ? resultLabel(lastAttempt.result) : '—' }}</dd>
            <dt class="text-muted-foreground">{{ t('investigation.seen.cost') }}</dt>
            <dd>{{ formatUsd(lastAttempt.costUsd ?? lastAttempt.estCostUsd, locale, lastAttempt.costUsd === null) ?? '—' }}</dd>
            <dt class="text-muted-foreground">{{ t('investigation.seen.duration') }}</dt>
            <dd>{{ formatDuration(lastAttempt.ms, locale) ?? '—' }}</dd>
          </dl>
        </div>
        <div v-if="lastAttempt?.exchange" class="rounded-lg border p-3" data-testid="exchange-card">
          <h3 class="mb-2 text-sm font-medium">{{ t('investigation.seen.exchange.title') }}</h3>
          <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt class="text-muted-foreground">{{ t('investigation.seen.exchange.request') }}</dt>
            <dd class="break-all font-mono">{{ lastAttempt.exchange.method }} {{ lastAttempt.exchange.url }}</dd>
            <dt class="text-muted-foreground">{{ t('investigation.seen.exchange.response') }}</dt>
            <dd>{{ responseLine(lastAttempt.exchange) }}</dd>
          </dl>
        </div>
      </section>

      <section aria-labelledby="col-doing" class="flex flex-col gap-2" data-testid="column-doing">
        <h2 id="col-doing" class="text-lg font-semibold">{{ t('investigation.columns.doing') }}</h2>
        <AttemptLog :attempts="shownAttempts" :access="state.access" :live="!suspended" />
        <div>
          <Button type="button" variant="outline" size="sm" data-testid="follow-toggle" @click="toggleFollow">
            {{ suspended ? t('investigation.controls.resumeFollow') : t('investigation.controls.suspendFollow') }}
          </Button>
        </div>
      </section>

      <section aria-labelledby="col-produced" class="flex flex-col gap-2" data-testid="column-produced">
        <h2 id="col-produced" class="text-lg font-semibold">{{ t('investigation.columns.produced') }}</h2>
        <SchemaPanel
          :output-schema="state.outputSchema"
          :sample="state.sample"
          :input-schema="state.inputSchema"
          :strategy="state.strategy"
          :phase="state.phase"
          :plan="state.plan"
          :busy="busy === 'validate'"
          @validate="(payload) => emit('validate', payload)"
        />
      </section>
    </div>
  </section>
</template>
