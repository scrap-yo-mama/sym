<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file SchemaPanel.vue
 * @description Ce que l'agent a produit (06 § 2, 20 § 5.3). Au jalon 3 (schéma proposé, en attente d'accord), la planche
 * NouvelleApi.dc.html : trois cartes côte à côte. (1) « Voici ce que tu vas récupérer » : un champ par ligne, nom en mono, type en
 * pastille et un exemple réel tiré de l'échantillon (valeur jamais traduite ni mise en forme selon la langue), puis le champ « Une
 * remarque pour SYM ? » de la planche. Aucun contrat ne porte encore la remarque (InvestigateRequest et ValidateSchemaRequest n’ont
 * pas de `note`) : elle n’est envoyée nulle part, et son aide, VISIBLE sous le champ, le dit (`assert_schema_remark_not_sent`). (2) Le plan
 * d'essais chiffré (TrialPlan). (3) La PORTE : bulle anthracite « SYM : J'ai trouvé … On valide ce schéma ? Aucun essai ne démarre avant ton accord. Déjà dépensé pour la reconnaissance : … », budget max de l'enquête et coût du
 * rejeu ensuite (« sans IA » seulement si la méthode la moins chère n'appelle pas de modèle), « Valider et lancer les essais · ~max »
 * et « Modifier le schéma ». Rien ne part avant le clic (INV1) : le composant n'émet `validate` que sur l'action de l'utilisateur.
 * Hors du jalon 3 (troisième colonne de 06 § 2) : le schéma, le bandeau « Schéma validé automatiquement, à ta demande » sous
 * `auto_validate`, le plan, l'échantillon et la stratégie retenue. Le schéma et les exemples sont du texte (jamais du HTML) ; le
 * schéma modifié est validé par le serveur (INV1).
 * @component
 * @example <SchemaPanel :output-schema="schema" :sample="sample" :phase="phase" :cards="cards" :budget="budget" @validate="onValidate" />
 */
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { SymSignature } from '@runtime/ui';
import TrialPlan from '@/components/investigation/TrialPlan.vue';
import { Button } from '@/components/ui/button';
import { formatUsd } from '@/lib/format';
import { maskedSample, requestedItems, schemaFields, type BudgetView, type Execution, type InvestigationPhase, type SchemaField, type StrategyView, type TrialCard } from '@/lib/investigation';

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
  /** Domaine enquêté : « J'ai trouvé les données de {domain}. » */
  domain?: string | null;
  /** Ce que l'utilisateur a demandé, sous le titre du schéma. */
  description?: string | null;
  /** Une validation est en cours de demande. */
  busy?: boolean;
}

const props = withDefaults(defineProps<Props>(), { busy: false, domain: null, description: null });

interface Emits {
  /** Valider le schéma proposé, ou le schéma modifié, avec le plan d'essais restreint : seulement sur l'action de l'utilisateur. */
  (e: 'validate', payload: { outputSchema?: Record<string, unknown>; excludeExecutions: Execution[] }): void;
}
const emit = defineEmits<Emits>();

const { t, te, locale } = useI18n();
const editing = ref(false);
const draft = ref('');
const draftError = ref(false);
const excluded = ref<Execution[]>([]);
const remark = ref('');

const awaiting = computed(() => props.phase === 'awaiting_schema_validation' && props.validatedBy === null);
const fields = computed(() => schemaFields(props.outputSchema, props.sample));
const pretty = (value: unknown): string => JSON.stringify(value, null, 2);
const signatureLocale = computed(() => (locale.value === 'fr' ? 'fr' : 'en'));

/** Type d'un champ, en mots : « texte », « nombre », « oui / non », ou les bornes déclarées (« 1 à 5 »). */
function typeText(field: SchemaField): string {
  if (field.range) return t('investigation.schema.range', { min: field.range.min, max: field.range.max });
  if (field.types.length === 0) return '—';
  return field.types.map((type) => (te(`investigation.schema.types.${type}`) ? t(`investigation.schema.types.${type}`) : type)).join(' · ');
}

/** Pastille de type, sur les surfaces de la planche (texte anthracite) : texte lilas, nombre jaune, oui / non aqua, bornes orange. */
function typeTone(field: SchemaField): string {
  if (field.range) return 'bg-sym-orange text-sym-ink';
  const type = field.types[0];
  if (type === 'number' || type === 'integer') return 'bg-sym-yellow text-sym-ink';
  if (type === 'boolean') return 'bg-status-sain text-status-sain-foreground';
  return 'bg-sym-lilac text-sym-ink';
}

/** Une chaîne d'exemple est citée (« … ») ; les guillemets entourent la valeur, jamais à l'intérieur. */
const quoted = (field: SchemaField): boolean => field.example !== null && !field.personal && (field.types.length === 0 || field.types.includes('string'));

const spent = computed(() => formatUsd(props.budget?.spentUsd, locale.value));
const max = computed(() => formatUsd(props.budget?.maxUsd, locale.value));
// « environ » dit déjà que c'est une estimation : pas de « ~ » en plus.
const replay = computed(() => formatUsd(props.budget?.retainedEstUsd, locale.value));
/** Méthodes qui appellent un modèle à chaque run : leur rejeu n'est pas « sans IA ». */
const LLM_EXECUTIONS: readonly Execution[] = ['agent_fetch', 'agent'];
const replayWithoutAi = computed(() => {
  const cheapest = props.cards.find((card) => card.state !== 'pruned' && !excluded.value.includes(card.execution));
  return cheapest !== undefined && !LLM_EXECUTIONS.includes(cheapest.execution);
});
/** « J'ai trouvé les livres. » : les items nommés dans la description, sinon les données du domaine enquêté. */
const found = computed(() => requestedItems(props.description, locale.value) ?? (props.domain ? t('investigation.gate.what', { domain: props.domain }) : t('investigation.gate.whatUnknown')));

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
  <!-- Jalon 3 : la planche, trois cartes. -->
  <div v-if="outputSchema && awaiting" class="grid items-start gap-5 lg:grid-cols-[1.15fr_1fr_0.85fr]" data-testid="schema-gate-layout">
    <section aria-labelledby="schema-title" class="flex flex-col gap-3.5 rounded-xl bg-card p-[22px] text-card-foreground" data-testid="schema-panel">
      <h2 id="schema-title" class="font-display text-[22px] leading-tight font-extrabold" data-testid="schema-gate-title">{{ t('investigation.schema.gateTitle') }}</h2>
      <p v-if="description" class="text-sm text-muted-foreground" data-testid="schema-description">{{ description }}</p>
      <template v-if="!editing">
        <ul v-if="fields.length > 0" class="flex flex-col gap-2" :aria-label="t('investigation.schema.fieldsCaption')" data-testid="schema-fields">
          <li v-for="field in fields" :key="field.name" class="flex flex-wrap items-center gap-2.5 rounded-md border px-3 py-2.5" data-testid="schema-field" :data-field="field.name">
            <span class="min-w-0 flex-1 font-mono text-sm font-semibold break-all">{{ field.name }}</span>
            <span class="rounded-sm px-2 py-0.5 text-xs font-bold" :class="typeTone(field)">{{ typeText(field) }}</span>
            <span class="min-w-0 text-[13px] break-words text-muted-foreground">
              <!-- Valeur de l'échantillon telle quelle : ni traduite ni mise en forme selon la langue (`translate="no"`). -->
              <template v-if="field.example !== null"
                ><span v-if="quoted(field)" aria-hidden="true">{{ t('investigation.schema.quoteOpen') }}</span
                ><code class="font-sans" translate="no" data-testid="schema-example">{{ field.example }}</code
                ><span v-if="quoted(field)" aria-hidden="true">{{ t('investigation.schema.quoteClose') }}</span></template
              >
              <template v-else>{{ t('investigation.schema.noExample') }}</template>
              <span v-if="field.personal" class="sr-only"> ({{ t('investigation.schema.personal') }})</span>
            </span>
          </li>
        </ul>
        <p v-else class="text-sm text-muted-foreground">{{ t('investigation.schema.noFields') }}</p>
      </template>
      <div v-else class="flex flex-col gap-1">
        <label for="schema-edit" class="text-sm">{{ t('investigation.schema.editLabel') }}</label>
        <textarea
          id="schema-edit"
          v-model="draft"
          rows="12"
          spellcheck="false"
          class="w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
          :aria-invalid="draftError"
          :aria-describedby="draftError ? 'schema-edit-error' : undefined"
        />
        <p v-if="draftError" id="schema-edit-error" class="sym-error" role="alert">{{ t('investigation.schema.editInvalid') }}</p>
      </div>
      <div class="flex flex-col gap-1.5">
        <label for="schema-remark" class="text-[13px] font-bold">{{ t('investigation.schema.remark') }}</label>
        <input
          id="schema-remark"
          v-model="remark"
          type="text"
          maxlength="2000"
          :placeholder="t('investigation.schema.remarkPlaceholder')"
          class="h-11 rounded-md border-[1.5px] border-foreground bg-background px-3 text-sm"
          aria-describedby="schema-remark-hint"
        />
        <!-- Aide VISIBLE (écart de texte à D-60, 20 § 5.3) : aucun contrat ne porte encore la remarque ; voyants et lecteurs d’écran lisent la même chose. -->
        <p id="schema-remark-hint" class="text-[13px] text-muted-foreground" data-testid="schema-remark-hint">{{ t('investigation.schema.remarkHint') }}</p>
      </div>
    </section>

    <TrialPlan v-model="excluded" :cards="cards" :selectable="!editing" :disabled="busy" />

    <!-- La porte : aucun essai ne démarre avant ton accord. Le coût déjà engagé est dit ; jamais « rien n'est enregistré ». -->
    <section aria-labelledby="gate-title" class="flex flex-col gap-3.5" data-testid="schema-gate">
      <div class="sym-on-ink flex flex-col gap-2 rounded-[20px_20px_6px_20px] bg-nav p-5 text-nav-foreground" data-testid="gate-bubble">
        <span class="text-xs text-signature"><SymSignature variant="speaking" :locale="signatureLocale" /></span>
        <h2 id="gate-title" class="font-display text-[22px] leading-[1.15] font-extrabold">{{ t('investigation.gate.title', { what: found }) }}</h2>
        <p class="text-sm text-nav-muted-foreground" data-testid="schema-waiting">
          {{ t('investigation.gate.noTrial') }} <span data-testid="gate-spent">{{ spent ? t('investigation.gate.spent', { cost: spent }) : t('investigation.gate.spentUnknown') }}</span>
        </p>
      </div>
      <div class="flex flex-col gap-2 rounded-lg bg-card p-4 text-card-foreground" data-testid="gate-budget">
        <span class="text-[13px] font-bold">{{ t('investigation.gate.budget') }}</span>
        <span class="font-display text-[30px] leading-none font-extrabold text-primary" data-testid="gate-budget-value">{{ max ?? '—' }}</span>
        <span v-if="replay" class="text-[13px] text-muted-foreground" data-testid="gate-replay">{{ t(replayWithoutAi ? 'investigation.gate.replay' : 'investigation.gate.replayWithAi', { cost: replay }) }}</span>
      </div>
      <template v-if="!editing">
        <Button type="button" variant="signature" :aria-disabled="busy" class="min-h-[52px] rounded-lg text-base aria-disabled:pointer-events-none aria-disabled:opacity-50" data-testid="schema-validate" @click="!busy && validateProposed()">
          {{ busy ? t('investigation.schema.validating') : max ? t('investigation.gate.validate', { max: max }) : t('investigation.gate.validateNoMax') }}
        </Button>
        <Button type="button" variant="outline" class="min-h-12 rounded-lg border-[1.5px] border-foreground bg-transparent text-[15px]" data-testid="schema-edit" @click="startEdit">{{ t('investigation.gate.edit') }}</Button>
      </template>
      <template v-else>
        <Button type="button" variant="signature" :aria-disabled="busy" class="min-h-[52px] rounded-lg text-base aria-disabled:pointer-events-none aria-disabled:opacity-50" data-testid="schema-validate-edit" @click="!busy && validateEdited()">
          {{ t('investigation.schema.applyEdit') }}
        </Button>
        <Button type="button" variant="outline" class="min-h-12 rounded-lg border-[1.5px] border-foreground bg-transparent text-[15px]" @click="editing = false">{{ t('investigation.schema.cancelEdit') }}</Button>
      </template>
    </section>
  </div>

  <!-- Jalons 2 et 4 : troisième colonne de 06 § 2. -->
  <div v-else class="flex flex-col gap-3" data-testid="schema-panel">
    <p v-if="!outputSchema" class="text-sm text-muted-foreground">{{ t('investigation.schema.empty') }}</p>
    <template v-else>
      <div>
        <h3 class="mb-1 text-base font-semibold" data-testid="schema-gate-title">{{ t('investigation.schema.gateTitle') }}</h3>
        <ul v-if="fields.length > 0" class="flex flex-col gap-1.5" :aria-label="t('investigation.schema.fieldsCaption')" data-testid="schema-fields">
          <li v-for="field in fields" :key="field.name" class="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-2 text-sm" data-testid="schema-field" :data-field="field.name">
            <span class="min-w-0 flex-1 font-mono text-xs font-semibold break-all">{{ field.name }}</span>
            <span class="rounded-sm px-2 py-0.5 text-xs font-bold" :class="typeTone(field)">{{ typeText(field) }}</span>
            <span class="min-w-0 text-xs break-words text-muted-foreground">
              <code v-if="field.example !== null" class="font-sans" translate="no" data-testid="schema-example">{{ field.example }}</code>
              <template v-else>{{ t('investigation.schema.noExample') }}</template>
              <span v-if="field.personal" class="sr-only"> ({{ t('investigation.schema.personal') }})</span>
            </span>
          </li>
        </ul>
        <p v-else class="text-sm text-muted-foreground">{{ t('investigation.schema.noFields') }}</p>
      </div>

      <p v-if="validatedBy === 'auto'" class="rounded-lg border-2 border-dashed p-3 text-sm font-medium" role="status" data-testid="gate-auto">{{ t('investigation.gate.auto') }}</p>

      <TrialPlan v-if="cards.length > 0" :cards="cards" />

      <div>
        <h3 class="mb-1 text-sm font-medium">{{ t('investigation.schema.sample') }}</h3>
        <pre v-if="sample.length > 0" class="max-h-48 overflow-auto rounded-lg border bg-muted p-3 text-xs" tabindex="0" translate="no">{{ pretty(maskedSample(outputSchema, sample.slice(0, 5))) }}</pre>
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
