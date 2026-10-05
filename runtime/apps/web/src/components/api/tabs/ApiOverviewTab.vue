<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ApiOverviewTab.vue
 * @description Vue d'ensemble d'une API (06 § 2) : description, stratégie courante (exécution × réseau, version),
 * dépendances (session sur tel domaine, tunnel), coût moyen, exemples d'appel MCP et REST à copier, et le formulaire
 * Lancer avec le coût estimé avant lancement. Aucun bouton Lancer pour une API bloquée (le panneau offre Ré-enquêter).
 * Section « Agent instruit » (tâche 2.13) pour une API non compilable qui a des étapes instruites, jamais sur une API
 * bloquée ; mode actif : rappel du coût par run dans le formulaire Lancer. « Coût max par run » (D-123) : propriétaire
 * seulement (`max_cost_usd` présent dans la fiche, même `null`), facultatif, vide par défaut.
 * @component
 * @example <ApiOverviewTab :detail="detail" slug="zz-books" />
 */
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import ExecutionBadge from '@/components/catalog/ExecutionBadge.vue';
import NetworkBadge from '@/components/catalog/NetworkBadge.vue';
import InstructedStepsPanel from '@/components/api/InstructedStepsPanel.vue';
import LaunchForm from '@/components/api/LaunchForm.vue';
import RunCostCapForm from '@/components/api/RunCostCapForm.vue';
import { Button } from '@/components/ui/button';
import { useApiActions } from '@/composables/useApiActions';
import type { ApiDetail } from '@/composables/useApiDetail';
import { useInstructedMode } from '@/composables/useInstructedMode';
import { copyText } from '@/lib/clipboard';
import { formatUsd } from '@/lib/display-format';
import { buildFormModel, exampleInput } from '@/lib/schema-form';
import { instructedOffered } from '@/lib/step-repairs';

const props = defineProps<{ detail: ApiDetail; slug: string }>();
const emit = defineEmits<{ updated: [detail: ApiDetail] }>();
const { t, locale } = useI18n();
const actions = useApiActions(() => props.slug);
const instructed = useInstructedMode(() => props.slug, () => props.detail);
const showInstructed = computed(() => instructedOffered(props.detail));
/** Coût par run rappelé avant chaque lancement quand le mode est actif ; undefined sinon. */
const instructedRunUsd = computed(() => (props.detail.instructed_mode === true ? (props.detail.instructed?.estimated_run_usd ?? null) : undefined));

async function confirmSteps(): Promise<void> {
  const updated = await instructed.confirm();
  if (updated) emit('updated', updated);
}

async function toggleInstructed(on: boolean): Promise<void> {
  const updated = await instructed.setEnabled(on);
  if (updated) emit('updated', updated);
}

const canLaunch = computed(() => props.detail.status !== 'bloquee' && !props.detail.metadata_only);
/** Champ « coût max par run » : la politique du propriétaire n'est servie qu'à lui (`max_cost_usd` absent pour un lecteur). */
const ownsPolicy = computed(() => !props.detail.metadata_only && 'max_cost_usd' in props.detail);
const launchedRun = ref<string | null>(null);

async function launch(input: Record<string, unknown>, version: number | undefined): Promise<void> {
  launchedRun.value = await actions.launch(input, version);
}

const origin = typeof window === 'undefined' ? 'https://<instance>' : window.location.origin;
const sample = computed(() => exampleInput(buildFormModel(props.detail.input_schema)));
const restExample = computed(
  () =>
    `curl -X POST "${origin}/api/apis/${props.slug}/runs?wait=25" \\\n  -H "Authorization: Bearer $RUNTIME_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify({ input: sample.value })}'`,
);
const mcpExample = computed(() => JSON.stringify({ name: 'run_api', arguments: { slug: props.slug, input: sample.value, wait_seconds: 25 } }, null, 2));

const copied = ref<'rest' | 'mcp' | 'failed' | null>(null);
async function copy(kind: 'rest' | 'mcp'): Promise<void> {
  copied.value = (await copyText(kind === 'rest' ? restExample.value : mcpExample.value)) ? kind : 'failed';
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <section aria-labelledby="overview-about" class="flex flex-col gap-2">
      <h2 id="overview-about" class="text-lg font-semibold">{{ t('overview.about') }}</h2>
      <p>{{ detail.description }}</p>
      <dl class="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt class="text-muted-foreground">{{ t('overview.strategy') }}</dt>
        <dd class="flex flex-wrap items-center gap-2" data-testid="overview-strategy">
          <ExecutionBadge :execution="detail.execution" />
          <span aria-hidden="true">×</span>
          <NetworkBadge :network="detail.network" />
          <span v-if="detail.current_strategy_version">{{ t('overview.version', { v: String(detail.current_strategy_version) }) }}</span>
        </dd>
        <dt class="text-muted-foreground">{{ t('overview.dependencies') }}</dt>
        <dd data-testid="overview-dependencies">
          <ul v-if="detail.requires.session_domain || detail.requires.tunnel" class="list-disc pl-5">
            <li v-if="detail.requires.session_domain">{{ t('overview.requiresSession', { domain: detail.requires.session_domain }) }}</li>
            <li v-if="detail.requires.tunnel">{{ t('overview.requiresTunnel') }}</li>
          </ul>
          <span v-else>{{ t('overview.noDependency') }}</span>
        </dd>
        <dt class="text-muted-foreground">{{ t('overview.avgCost') }}</dt>
        <dd>{{ formatUsd(detail.avg_cost_usd, locale, detail.avg_cost_estimated ?? false) }}</dd>
      </dl>
      <p v-if="detail.session_owner" class="rounded-md border p-3 text-sm" data-testid="session-owner">
        {{ t('reasons.session_owner_required') }} ({{ detail.session_owner.display_name }})
      </p>
    </section>

    <section v-if="canLaunch" aria-labelledby="overview-launch" class="flex flex-col gap-3">
      <h2 id="overview-launch" class="text-lg font-semibold">{{ t('overview.launch') }}</h2>
      <LaunchForm :schema="detail.input_schema" :estimate="detail.cost_estimate" :instructed-run-usd="instructedRunUsd" :pending="actions.pending.value === 'launch'" :error="actions.error.value" @submit="launch" />
      <p v-if="launchedRun" role="status" class="text-sm" data-testid="launch-started">
        {{ t('launch.started') }}
        <RouterLink :to="`/runs/${launchedRun}`" class="underline underline-offset-4">{{ t('launch.followRun') }}</RouterLink>
      </p>
    </section>

    <RunCostCapForm v-if="ownsPolicy" :detail="detail" :slug="slug" @updated="emit('updated', $event)" />

    <InstructedStepsPanel
      v-if="showInstructed && detail.instructed"
      :instructed="detail.instructed"
      :enabled="instructed.enabled.value"
      :pending="instructed.pending.value"
      :error="instructed.error.value"
      @confirm="confirmSteps"
      @toggle="toggleInstructed"
    />

    <section aria-labelledby="overview-examples" class="flex flex-col gap-3">
      <h2 id="overview-examples" class="text-lg font-semibold">{{ t('overview.examples') }}</h2>
      <div class="flex flex-col gap-2">
        <h3 class="font-medium">{{ t('overview.rest') }}</h3>
        <pre class="overflow-x-auto rounded-md bg-muted p-3 text-xs" data-testid="example-rest"><code>{{ restExample }}</code></pre>
        <div><Button variant="outline" size="sm" @click="copy('rest')">{{ t('ui.copy') }}</Button></div>
      </div>
      <div class="flex flex-col gap-2">
        <h3 class="font-medium">{{ t('overview.mcp') }}</h3>
        <pre class="overflow-x-auto rounded-md bg-muted p-3 text-xs" data-testid="example-mcp"><code>{{ mcpExample }}</code></pre>
        <div><Button variant="outline" size="sm" @click="copy('mcp')">{{ t('ui.copy') }}</Button></div>
      </div>
      <p role="status" class="text-sm text-muted-foreground">
        <template v-if="copied === 'rest' || copied === 'mcp'">{{ t('ui.copied') }}</template>
        <template v-else-if="copied === 'failed'">{{ t('ui.copyFailed') }}</template>
      </p>
    </section>
  </div>
</template>
