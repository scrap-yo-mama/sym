<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file SchemaPanel.vue
 * @description Troisième colonne de l'enquête (06 § 2) : schéma de sortie proposé et échantillon, Valider ou Modifier,
 * plan d'essais restreignable, schéma d'entrée, stratégie retenue. Le schéma est du texte (jamais du HTML). La validation
 * du schéma modifié est faite par le serveur (INV1) ; ici on vérifie seulement que le texte est un objet JSON.
 * @component
 * @example <SchemaPanel :output-schema="schema" :sample="sample" :phase="phase" :plan="plan" @validate="onValidate" />
 */
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import PlanPicker from '@/components/investigation/PlanPicker.vue';
import { Button } from '@/components/ui/button';
import type { Execution, InvestigationPhase, PlanStep, StrategyView } from '@/lib/investigation';

interface Props {
  outputSchema: Record<string, unknown> | null;
  sample: readonly Record<string, unknown>[];
  inputSchema: Record<string, unknown> | null;
  strategy: StrategyView | null;
  phase: InvestigationPhase | null;
  plan: readonly PlanStep[] | null;
  /** Une validation est en cours de demande. */
  busy?: boolean;
}

const props = withDefaults(defineProps<Props>(), { busy: false });

interface Emits {
  /** Valider le schéma proposé, ou le schéma modifié, avec le plan d'essais restreint. */
  (e: 'validate', payload: { outputSchema?: Record<string, unknown>; excludeExecutions: Execution[] }): void;
}
const emit = defineEmits<Emits>();

const { t } = useI18n();
const editing = ref(false);
const draft = ref('');
const draftError = ref(false);
const excluded = ref<Execution[]>([]);

const SAMPLE_ROWS = 5;
const awaiting = computed(() => props.phase === 'awaiting_schema_validation');
const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

function startEdit(): void {
  draft.value = pretty(props.outputSchema ?? {});
  draftError.value = false;
  editing.value = true;
}

function validateProposed(): void {
  emit('validate', { excludeExecutions: excluded.value });
}

function validateEdited(): void {
  try {
    const parsed: unknown = JSON.parse(draft.value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    draftError.value = false;
    editing.value = false;
    emit('validate', { outputSchema: parsed as Record<string, unknown>, excludeExecutions: excluded.value });
  } catch {
    draftError.value = true;
  }
}
</script>

<template>
  <div class="flex flex-col gap-3" data-testid="schema-panel">
    <p v-if="!outputSchema" class="text-sm text-muted-foreground">{{ t('investigation.schema.empty') }}</p>
    <template v-else>
      <div>
        <h3 class="mb-1 text-sm font-medium">{{ t('investigation.schema.title') }}</h3>
        <pre v-if="!editing" class="max-h-64 overflow-auto rounded-lg border bg-muted p-3 text-xs" tabindex="0">{{ pretty(outputSchema) }}</pre>
        <div v-else class="flex flex-col gap-1">
          <label for="schema-edit" class="text-sm">{{ t('investigation.schema.editLabel') }}</label>
          <textarea
            id="schema-edit"
            v-model="draft"
            rows="12"
            spellcheck="false"
            class="w-full rounded-lg border border-input bg-background p-2 font-mono text-xs"
            :aria-invalid="draftError"
            :aria-describedby="draftError ? 'schema-edit-error' : undefined"
          />
          <p v-if="draftError" id="schema-edit-error" class="sym-error" role="alert">{{ t('investigation.schema.editInvalid') }}</p>
        </div>
      </div>

      <div>
        <h3 class="mb-1 text-sm font-medium">{{ t('investigation.schema.sample') }}</h3>
        <pre v-if="sample.length > 0" class="max-h-48 overflow-auto rounded-lg border bg-muted p-3 text-xs" tabindex="0">{{ pretty(sample.slice(0, SAMPLE_ROWS)) }}</pre>
        <p v-else class="text-sm text-muted-foreground">{{ t('investigation.schema.sampleEmpty') }}</p>
      </div>

      <template v-if="awaiting">
        <p class="text-sm" data-testid="schema-waiting">{{ t('investigation.schema.waiting') }}</p>
        <PlanPicker v-if="plan && plan.length > 0" v-model="excluded" :plan="plan" :disabled="busy" />
        <div class="flex flex-wrap gap-2">
          <template v-if="!editing">
            <Button type="button" :aria-disabled="busy" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" data-testid="schema-validate" @click="!busy && validateProposed()">
              {{ busy ? t('investigation.schema.validating') : t('investigation.schema.validate') }}
            </Button>
            <Button type="button" variant="outline" data-testid="schema-edit" @click="startEdit">{{ t('investigation.schema.edit') }}</Button>
          </template>
          <template v-else>
            <Button type="button" :aria-disabled="busy" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" data-testid="schema-validate-edit" @click="!busy && validateEdited()">
              {{ t('investigation.schema.applyEdit') }}
            </Button>
            <Button type="button" variant="outline" @click="editing = false">{{ t('investigation.schema.cancelEdit') }}</Button>
          </template>
        </div>
      </template>
    </template>

    <div v-if="inputSchema">
      <h3 class="mb-1 text-sm font-medium">{{ t('investigation.schema.input') }}</h3>
      <pre class="max-h-48 overflow-auto rounded-lg border bg-muted p-3 text-xs" tabindex="0">{{ pretty(inputSchema) }}</pre>
    </div>

    <div v-if="strategy && strategy.execution && strategy.network" data-testid="strategy">
      <p class="text-sm">
        {{
          t('investigation.schema.strategy', {
            execution: t(`execution.${strategy.execution}`),
            network: t(`network.${strategy.network}`),
            version: strategy.version ?? 1,
          })
        }}
      </p>
      <p v-if="strategy.network === 'tunnel'" class="text-sm text-muted-foreground">{{ t('investigation.schema.tunnelNote') }}</p>
    </div>
  </div>
</template>
