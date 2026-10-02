<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file TrialPlan.vue
 * @description Plan d'essais chiffré (06 § 2, 20 § 5.3) en canevas vertical lisible : une liste ordonnée `<ol>` de cartes
 * numérotées, du moins cher au plus cher (INV2) ; chaque carte porte son mode d'exécution, son réseau, son coût estimé (`~`),
 * la règle appliquée et son état en texte (à essayer, en cours, réussi, échoué, non lancé). Les cartes élaguées sont grisées
 * avec leur raison. La branche « Arrêt volontaire » ferme la liste : il n'y a AUCUNE carte « changer d'adresse » (X4), le refus
 * mène à l'arrêt. Avant le lancement, on peut retirer des méthodes (jamais en ajouter) et au moins une reste cochée ; l'ordre
 * est décidé par le serveur, en lecture seule.
 * @component
 * @example <TrialPlan :cards="cards" v-model="excluded" selectable />
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useReason } from '@/composables/useReason';
import { formatUsd } from '@/lib/format';
import { toggleExcluded, type Execution, type TrialCard } from '@/lib/investigation';

interface Props {
  cards: readonly TrialCard[];
  /** Méthodes exclues du plan (avant le lancement). */
  modelValue?: readonly Execution[];
  /** Les cartes sont des cases à cocher (avant le lancement, à la porte du schéma). */
  selectable?: boolean;
  disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), { modelValue: () => [], selectable: false, disabled: false });

interface Emits {
  (e: 'update:modelValue', value: Execution[]): void;
}
const emit = defineEmits<Emits>();

const { t, te, locale } = useI18n();
const { reasonShort, resultLabel } = useReason();

const remaining = computed(() => props.cards.filter((card) => card.state !== 'pruned' && !props.modelValue.includes(card.execution)).length);

function toggle(execution: Execution, box: HTMLInputElement): void {
  const next = toggleExcluded(props.cards, props.modelValue, execution, box.checked);
  emit('update:modelValue', next);
  // Si la liste n'a pas changé (dernière méthode), la case revient à son état : le DOM ne se re-rend pas de lui-même.
  box.checked = !next.includes(execution);
}

const excluded = (card: TrialCard): boolean => props.selectable && props.modelValue.includes(card.execution);

/** Libellé d'une classe de résultat (classe d'échec connue, sinon raison courte, sinon « Raison : code »). */
function reasonLabel(code: string): string {
  return te(`failure.${code}`) ? resultLabel(code) : reasonShort(code);
}

function stateText(card: TrialCard): string {
  if (excluded(card)) return t('investigation.plan.state.excluded');
  return t(`investigation.plan.state.${card.state}`);
}

function detail(card: TrialCard): string | null {
  if (!card.reason) return null;
  if (card.state === 'pruned') return t('investigation.plan.prunedReason', { reason: reasonLabel(card.reason) });
  if (card.state === 'failed') return t('investigation.plan.failedReason', { reason: reasonLabel(card.reason) });
  return null;
}

const grey = (card: TrialCard): boolean => card.state === 'pruned' || excluded(card);
</script>

<template>
  <section class="flex flex-col gap-2" aria-labelledby="trial-plan-title" data-testid="trial-plan">
    <h3 id="trial-plan-title" class="text-sm font-medium">{{ t('investigation.plan.title') }}</h3>
    <p class="text-sm text-muted-foreground">{{ t('investigation.plan.hint') }}</p>
    <p v-if="cards.length === 0" class="text-sm text-muted-foreground" data-testid="trial-plan-empty">{{ t('investigation.plan.empty') }}</p>
    <ol v-else class="flex flex-col gap-2">
      <li
        v-for="(card, at) in cards"
        :key="card.key"
        class="flex items-start gap-3 rounded-lg border p-3 text-sm"
        :class="grey(card) ? 'border-dashed bg-muted text-muted-foreground' : 'bg-card'"
        data-testid="trial-card"
        :data-state="excluded(card) ? 'excluded' : card.state"
        :data-execution="card.execution"
      >
        <span class="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-destructive text-sm font-bold text-destructive-foreground" aria-hidden="true">{{ at + 1 }}</span>
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <p class="font-medium" :class="grey(card) ? '' : 'text-card-foreground'">
            {{ t(`execution.${card.execution}`) }}<template v-if="card.network">, {{ t(`network.${card.network}`) }}</template>
            <span v-if="formatUsd(card.estCostUsd, locale, true)" class="font-normal"> ({{ t('investigation.plan.estimate', { cost: formatUsd(card.estCostUsd, locale, true) }) }})</span>
          </p>
          <p data-testid="trial-rule">{{ card.rule ? t('investigation.plan.rule.named', { rule: card.rule }) : t('investigation.plan.rule.default') }}</p>
          <p data-testid="trial-state">
            {{ stateText(card) }}<template v-if="detail(card)"> · {{ detail(card) }}</template>
          </p>
          <label v-if="selectable && card.state === 'planned'" class="mt-1 flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              class="size-4"
              :checked="!modelValue.includes(card.execution)"
              :disabled="disabled"
              :aria-describedby="remaining < 2 ? 'plan-at-least-one' : undefined"
              @change="toggle(card.execution, $event.target as HTMLInputElement)"
            />
            {{ t('investigation.plan.include') }}
          </label>
        </div>
      </li>
      <!-- Branche « refus » : elle mène à l'arrêt, jamais à une carte « changer d'adresse » (X4). Pas numérotée : ce n'est pas un essai. -->
      <li class="flex items-start gap-3 rounded-lg border-2 border-dashed p-3 text-sm" data-testid="trial-stop-branch">
        <span class="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-status-bloquee text-sm font-bold text-status-bloquee-foreground" aria-hidden="true">■</span>
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <p class="font-medium">{{ t('investigation.plan.stop.title') }}</p>
          <p class="text-muted-foreground">{{ t('investigation.plan.stop.text') }}</p>
        </div>
      </li>
    </ol>
    <p v-if="selectable && cards.length !== 0 && remaining < 2" id="plan-at-least-one" class="text-sm text-muted-foreground">{{ t('investigation.plan.atLeastOne') }}</p>
  </section>
</template>
