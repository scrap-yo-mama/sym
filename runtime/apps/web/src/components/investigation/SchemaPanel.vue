<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file SchemaPanel.vue
 * @description Troisième colonne de l'enquête (06 § 2, 20 § 5.3) : « Voici ce que tu vas récupérer », un champ par ligne
 * avec son type et un exemple réel tiré de l'échantillon (valeur jamais traduite ni mise en forme selon la langue), le
 * plan d'essais chiffré, puis la PORTE : « On valide ce schéma ? Aucun essai ne démarre avant ton accord. » avec le coût déjà
 * dépensé pour la reconnaissance, le budget maximal et le coût de rejeu estimé ; « Valider et lancer les essais · ~max » et
 * « Modifier le schéma ». Rien ne part avant le clic (INV1) : le composant n'émet `validate` que sur l'action de l'utilisateur.
 * Sous `auto_validate`, aucune porte : le bandeau « Schéma validé automatiquement, à ta demande » la remplace. Le schéma et les
 * exemples sont du texte (jamais du HTML) ; le schéma modifié est validé par le serveur (INV1).
 * @component
 * @example <SchemaPanel :output-schema="schema" :sample="sample" :phase="phase" :cards="cards" :budget="budget" @validate="onValidate" />
 */
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import TrialPlan from '@/components/investigation/TrialPlan.vue';
import { Button } from '@/components/ui/button';
import { formatUsd } from '@/lib/format';
import { schemaFields, type BudgetView, type Execution, type InvestigationPhase, type StrategyView, type TrialCard } from '@/lib/investigation';

interface Props {
  outputSchema: Record<string, unknown> | null;
  sample: readonly Record<string, unknown>[];
  inputSchema: Record<string, unknown> | null;
  strategy: StrategyView | null;
  phase: InvestigationPhase | null;
  /** Cartes du plan d'essais ; vide : le serveur n'a pas (encore) annoncé de plan. */
  cards: readonly TrialCard[];
  budget: BudgetView | null;
  /** `auto` : schéma validé sans porte (`auto_validate`). */
  validatedBy: 'auto' | 'user' | null;
  /** Une validation est en cours de demande. */
  busy?: boolean;
}

const props = withDefaults(defineProps<Props>(), { busy: false });

interface Emits {
  /** Valider le schéma proposé, ou le schéma modifié, avec le plan d'essais restreint : seulement sur l'action de l'utilisateur. */
  (e: 'validate', payload: { outputSchema?: Record<string, unknown>; excludeExecutions: Execution[] }): void;
  /** Ré-enquêter avec la remarque de l'utilisateur. */
  (e: 'reinvestigate', note: string): void;
}
const emit = defineEmits<Emits>();

const { t, te, locale } = useI18n();
const editing = ref(false);
const draft = ref('');
const draftError = ref(false);
const excluded = ref<Execution[]>([]);
const remark = ref('');

const awaiting = computed(() => props.phase === 'awaiting_schema_validation');
const fields = computed(() => schemaFields(props.outputSchema, props.sample));
const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

const typeText = (types: readonly string[]): string => types.map((type) => (te(`investigation.schema.types.${type}`) ? t(`investigation.schema.types.${type}`) : type)).join(' · ');

const spent = computed(() => formatUsd(props.budget?.spentUsd, locale.value));
const max = computed(() => formatUsd(props.budget?.maxUsd, locale.value));
const replay = computed(() => formatUsd(props.budget?.retainedEstUsd, locale.value, true));

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

function sendRemark(): void {
  const note = remark.value.trim();
  if (note !== '' && !props.busy) emit('reinvestigate', note.slice(0, 2000));
}
</script>

<template>
  <div class="flex flex-col gap-3" data-testid="schema-panel">
    <p v-if="!outputSchema" class="text-sm text-muted-foreground">{{ t('investigation.schema.empty') }}</p>
    <template v-else>
      <div>
        <h3 class="mb-1 text-base font-semibold" data-testid="schema-gate-title">{{ t('investigation.schema.gateTitle') }}</h3>
        <template v-if="!editing">
          <div v-if="fields.length > 0" class="overflow-x-auto rounded-lg border" tabindex="0" role="region" :aria-label="t('investigation.schema.fieldsCaption')">
            <table class="w-full table-fixed border-collapse text-left text-sm" data-testid="schema-fields">
              <caption class="sr-only">{{ t('investigation.schema.fieldsCaption') }}</caption>
              <thead class="bg-muted text-xs text-muted-foreground">
                <tr>
                  <th scope="col" class="w-[30%] px-2 py-1.5 font-medium">{{ t('investigation.schema.columns.field') }}</th>
                  <th scope="col" class="w-[22%] px-2 py-1.5 font-medium">{{ t('investigation.schema.columns.type') }}</th>
                  <th scope="col" class="px-2 py-1.5 font-medium">{{ t('investigation.schema.columns.example') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="field in fields" :key="field.name" class="border-t align-top" data-testid="schema-field" :data-field="field.name">
                  <th scope="row" class="px-2 py-1.5 font-mono text-xs font-medium break-words">{{ field.name }}</th>
                  <td class="px-2 py-1.5 break-words">{{ field.types.length > 0 ? typeText(field.types) : '—' }}</td>
                  <td class="px-2 py-1.5 break-words">
                    <!-- Valeur de l'échantillon telle quelle : ni traduite ni mise en forme selon la langue (`translate="no"`). -->
                    <code v-if="field.example !== null" class="font-mono text-xs break-all" translate="no" data-testid="schema-example">{{ field.example }}</code>
                    <span v-else class="text-muted-foreground">{{ t('investigation.schema.noExample') }}</span>
                    <span v-if="field.personal" class="sr-only"> ({{ t('investigation.schema.personal') }})</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="text-sm text-muted-foreground">{{ t('investigation.schema.noFields') }}</p>
        </template>
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

      <TrialPlan v-if="cards.length > 0 || awaiting" v-model="excluded" :cards="cards" :selectable="awaiting && !editing" :disabled="busy" />

      <p v-if="validatedBy === 'auto'" class="rounded-lg border-2 border-dashed p-3 text-sm font-medium" role="status" data-testid="gate-auto">{{ t('investigation.gate.auto') }}</p>

      <!-- La porte : aucun essai ne démarre avant ton accord. Le coût déjà engagé est dit ; jamais « rien n'est enregistré ». -->
      <section v-if="awaiting" class="flex flex-col gap-2 rounded-xl border-2 p-3" aria-labelledby="gate-title" data-testid="schema-gate">
        <h3 id="gate-title" class="text-base font-semibold">{{ t('investigation.gate.title') }}</h3>
        <p class="text-sm" data-testid="schema-waiting">{{ t('investigation.gate.noTrial') }}</p>
        <p class="text-sm" data-testid="gate-spent">{{ spent ? t('investigation.gate.spent', { cost: spent }) : t('investigation.gate.spentUnknown') }}</p>
        <p v-if="max" class="text-sm" data-testid="gate-budget">{{ t('investigation.gate.budget', { max }) }}</p>
        <p v-if="replay" class="text-sm" data-testid="gate-replay">{{ t('investigation.gate.replay', { cost: replay }) }}</p>
        <div class="flex flex-col gap-1">
          <label for="schema-remark" class="text-sm font-medium">{{ t('investigation.schema.remark') }}</label>
          <textarea id="schema-remark" v-model="remark" rows="2" maxlength="2000" class="rounded-md border border-input bg-background p-2 text-sm" aria-describedby="schema-remark-hint" />
          <p id="schema-remark-hint" class="text-sm text-muted-foreground">{{ t('investigation.schema.remarkHint') }}</p>
          <div v-if="remark.trim() !== ''">
            <Button type="button" variant="outline" size="sm" :aria-disabled="busy" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" data-testid="schema-remark-send" @click="sendRemark">
              {{ t('investigation.schema.reinvestigateWithNote') }}
            </Button>
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <template v-if="!editing">
            <Button type="button" :aria-disabled="busy" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" data-testid="schema-validate" @click="!busy && validateProposed()">
              {{ busy ? t('investigation.schema.validating') : max ? t('investigation.gate.validate', { max: max }) : t('investigation.gate.validateNoMax') }}
            </Button>
            <Button type="button" variant="outline" data-testid="schema-edit" @click="startEdit">{{ t('investigation.gate.edit') }}</Button>
          </template>
          <template v-else>
            <Button type="button" :aria-disabled="busy" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" data-testid="schema-validate-edit" @click="!busy && validateEdited()">
              {{ t('investigation.schema.applyEdit') }}
            </Button>
            <Button type="button" variant="outline" @click="editing = false">{{ t('investigation.schema.cancelEdit') }}</Button>
          </template>
        </div>
      </section>

      <div>
        <h3 class="mb-1 text-sm font-medium">{{ t('investigation.schema.sample') }}</h3>
        <pre v-if="sample.length > 0" class="max-h-48 overflow-auto rounded-lg border bg-muted p-3 text-xs" tabindex="0" translate="no">{{ pretty(sample.slice(0, 5)) }}</pre>
        <p v-else class="text-sm text-muted-foreground">{{ t('investigation.schema.sampleEmpty') }}</p>
      </div>
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
