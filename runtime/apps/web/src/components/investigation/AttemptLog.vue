<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file AttemptLog.vue
 * @description Journal d'enquête (06 § 2, § 3) : première ligne « robots.txt lu : chemin autorisé », signaux d'usage et
 * voie officielle trouvée, puis les essais qui défilent avec leur « pourquoi » et leur raison d'échec en clair. Région
 * `role="log"` : une phrase par essai terminé, sans déplacer le focus. Le défilement n'est jamais forcé.
 * Dernière ligne : « Stratégie compilée : rejeu sans IA » quand l'essai E4 retenu a été compilé (constat UX-20).
 * @component
 * @example <AttemptLog :attempts="state.attempts" :access="state.access" :live="true" />
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useReason } from '@/composables/useReason';
import { formatDuration, formatUsd } from '@/lib/format';
import type { AccessReport, AttemptView, CompiledView } from '@/lib/investigation';

interface Props {
  attempts: readonly AttemptView[];
  access: AccessReport | null;
  /** Compilation de l'essai E4 retenu en stratégie rejouée sans IA (`strategy.compiled`) ; nulle sinon. */
  compiled?: CompiledView | null;
  /** Faux quand le suivi est suspendu : plus d'annonce (2.2.2). */
  live?: boolean;
}

const props = withDefaults(defineProps<Props>(), { live: true, compiled: null });
const { t, locale } = useI18n();
const { reasonText, resultLabel } = useReason();

const ROBOTS_KEYS = { allowed: 'robotsAllowed', disallowed: 'robotsDisallowed', absent: 'robotsAbsent', unreachable: 'robotsUnreachable' } as const;

/** Lignes d'accès, avant le premier essai (rapport d'accès, étape 0 de l'enquête). */
const accessLines = computed<string[]>(() => {
  const report = props.access;
  if (!report) return [];
  const lines = [t(`investigation.log.${ROBOTS_KEYS[report.robots.status]}`)];
  for (const signal of report.usage_signals ?? []) lines.push(t('investigation.log.signal', { kind: signal.kind, value: signal.value }));
  if (report.llms_txt) lines.push(t('investigation.log.llmsTxt'));
  if (report.official_api_url) lines.push(t('investigation.log.officialApi', { url: report.official_api_url }));
  return lines;
});

function statusOf(attempt: AttemptView): string {
  if (attempt.state === 'running') return t('investigation.log.running');
  if (attempt.state === 'pruned') {
    return attempt.prunedReason ? t('investigation.log.pruned', { reason: reasonText({ code: attempt.prunedReason, params: {} }) }) : t('investigation.log.prunedNoReason');
  }
  if (attempt.result === null || attempt.result === 'ok') return t('investigation.log.ok');
  return t('investigation.log.failed', { reason: resultLabel(attempt.result) });
}

function figures(attempt: AttemptView): string {
  const parts = [formatUsd(attempt.costUsd ?? attempt.estCostUsd, locale.value, attempt.costUsd === null), formatDuration(attempt.ms, locale.value)];
  return parts.filter((part): part is string => part !== null).join(' · ');
}
</script>

<template>
  <div>
    <h3 id="attempt-log-title" class="mb-2 text-sm font-medium">{{ t('investigation.log.title') }}</h3>
    <!-- Défilement non forcé : aucune action de défilement automatique, l'utilisateur garde sa position -->
    <!-- Le rôle log va sur un conteneur : sur le <ol>, il remplacerait le rôle de liste et les <li> n'auraient plus de parent de liste. -->
    <div
      id="investigation-log"
      role="log"
      tabindex="0"
      class="max-h-96 overflow-y-auto rounded-lg border p-3 text-sm"
      aria-labelledby="attempt-log-title"
      :aria-live="live ? 'polite' : 'off'"
      data-testid="attempt-log"
    >
      <ol class="flex flex-col gap-2">
        <li v-for="(line, at) in accessLines" :key="`access-${at}`" class="text-muted-foreground" data-testid="access-line">{{ line }}</li>
        <li v-if="attempts.length === 0 && accessLines.length === 0" class="text-muted-foreground">{{ t('investigation.log.empty') }}</li>
        <li v-for="attempt in attempts" :key="attempt.index" :class="attempt.state === 'pruned' ? 'text-muted-foreground' : ''" data-testid="attempt">
          <p>
            <strong>{{ t('investigation.log.trial', { n: attempt.index + 1, execution: t(`execution.${attempt.execution}`), network: t(`network.${attempt.network}`) }) }}</strong>
            — {{ statusOf(attempt) }}<template v-if="figures(attempt)"> · {{ figures(attempt) }}</template>
          </p>
          <p v-if="attempt.why" class="pl-3 text-muted-foreground">{{ t('investigation.log.why', { reason: reasonText(attempt.why) }) }}</p>
          <p v-if="attempt.error" class="pl-3 text-muted-foreground">{{ reasonText(attempt.error) }}</p>
        </li>
        <li v-if="compiled" :class="compiled.ok ? '' : 'text-muted-foreground'" data-testid="compiled-line">
          {{ compiled.ok ? t('investigation.log.compiled') : t('investigation.log.compileKept') }}
        </li>
      </ol>
    </div>
  </div>
</template>
