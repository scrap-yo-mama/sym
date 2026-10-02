<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file TrialPlan.vue
 * @description Plan d'essais chiffré (06 § 2, 20 § 5.3, planche NouvelleApi.dc.html) : carte bleue « Le plan d'essais », « Du moins
 * cher au plus cher. SYM s'arrête au premier qui marche. », puis un canevas vertical lisible, une liste ordonnée `<ol>` de cartes
 * papier numérotées et reliées par un trait, du moins cher au plus cher (INV2). Chaque carte porte le nom de la méthode, ce
 * qu'elle fait et son coût estimé (`~`) ; le pied dit « Estimations · règle appliquée : … » (la règle Markdown qui a ordonné le
 * plan, `escalade-par-defaut.md` sinon, 04 § 3). Pastilles numérotées sur les surfaces de la planche, jaune, lilas puis orange,
 * toujours à texte anthracite (20 § 1.3 : jamais de blanc sur l'orange). L'état d'une carte est écrit dès qu'elle n'est plus « à
 * essayer » (en cours, réussi, échoué, non lancé, exclu) ; les cartes élaguées sont grisées avec leur raison. La branche « Arrêt
 * volontaire » ferme la liste : il n'y a AUCUNE carte « changer d'adresse » (X4), le refus mène à l'arrêt. Avant le lancement, on
 * peut retirer des méthodes (jamais en ajouter, 06 § 2) et au moins une reste cochée ; l'ordre est décidé par le serveur.
 * @component
 * @example <TrialPlan :cards="cards" v-model="excluded" selectable />
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useReason } from '@/composables/useReason';
import { formatUsd } from '@/lib/format';
import { DEFAULT_RULE, toggleExcluded, type Execution, type TrialCard } from '@/lib/investigation';

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

/** Règles appliquées, une fois chacune (celle par défaut quand aucune règle de domaine n'a ordonné le plan). */
const rules = computed(() => {
  const named = [...new Set(props.cards.map((card) => card.rule).filter((rule): rule is string => rule !== null))];
  return named.length > 0 ? named.join(', ') : DEFAULT_RULE;
});

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

/** État écrit d'une carte ; nul pour une carte « à essayer » (la planche n'écrit rien de plus). */
function stateText(card: TrialCard): string | null {
  if (excluded(card)) return t('investigation.plan.state.excluded');
  if (card.state === 'planned') return null;
  const state = t(`investigation.plan.state.${card.state}`);
  if (!card.reason) return state;
  if (card.state === 'pruned') return `${state} · ${t('investigation.plan.prunedReason', { reason: reasonLabel(card.reason) })}`;
  if (card.state === 'failed') return `${state} · ${t('investigation.plan.failedReason', { reason: reasonLabel(card.reason) })}`;
  return state;
}

/** Ce que fait la méthode, avec le réseau quand il n'est pas direct. */
function cardText(card: TrialCard): string {
  const text = t(`investigation.plan.card.${card.execution}.text`);
  return card.network && card.network !== 'direct' ? `${text} · ${t(`network.${card.network}`)}` : text;
}

const grey = (card: TrialCard): boolean => card.state === 'pruned' || excluded(card);

/** Surfaces des pastilles numérotées, dans l'ordre de la planche ; texte anthracite sur chacune. */
const NUMBER_TONES = ['bg-sym-yellow', 'bg-sym-lilac', 'bg-sym-orange'] as const;
const numberTone = (at: number): string => NUMBER_TONES[at % NUMBER_TONES.length] ?? NUMBER_TONES[0];
</script>

<template>
  <section aria-labelledby="trial-plan-title" class="flex flex-col gap-3 rounded-xl p-[22px] bg-primary text-primary-foreground" data-testid="trial-plan">
    <h2 id="trial-plan-title" class="font-display text-[22px] leading-tight font-extrabold">{{ t('investigation.plan.title') }}</h2>
    <p class="text-sm">{{ t('investigation.plan.hint') }}</p>
    <p v-if="cards.length === 0" class="text-sm" data-testid="trial-plan-empty">{{ t('investigation.plan.empty') }}</p>
    <ol v-else class="flex flex-col">
      <li v-for="(card, at) in cards" :key="card.key" class="flex flex-col">
        <div
          class="flex items-center gap-3 rounded-[14px] p-3.5"
          :class="grey(card) ? 'border-[1.5px] border-dashed border-sym-todo bg-muted text-muted-foreground' : 'bg-card text-card-foreground'"
          data-testid="trial-card"
          :data-state="excluded(card) ? 'excluded' : card.state"
          :data-execution="card.execution"
        >
          <span :class="`inline-flex size-8 shrink-0 items-center justify-center rounded-[10px] font-extrabold text-sym-ink ${numberTone(at)}`" aria-hidden="true" data-testid="trial-number">{{ at + 1 }}</span>
          <div class="flex min-w-0 flex-1 flex-col">
            <span class="text-[15px] font-bold">{{ t(`investigation.plan.card.${card.execution}.title`) }}</span>
            <span class="text-xs" :class="grey(card) ? '' : 'text-muted-foreground'">{{ cardText(card) }}</span>
            <span v-if="stateText(card)" class="text-xs font-bold" data-testid="trial-state">{{ stateText(card) }}</span>
            <label v-if="selectable && card.state === 'planned'" class="mt-1 flex min-h-11 items-center gap-2 text-xs">
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
          <span class="shrink-0 text-sm font-bold" data-testid="trial-cost">{{ formatUsd(card.estCostUsd, locale, true) ?? '—' }}</span>
        </div>
        <span class="ml-[30px] h-3.5 w-0.5 bg-card" aria-hidden="true"></span>
      </li>
      <!-- Branche « refus » : elle mène à l'arrêt, jamais à une carte « changer d'adresse » (X4). Pas numérotée : ce n'est pas un essai. -->
      <li class="flex items-center gap-3 rounded-[14px] border-[1.5px] border-dashed border-card p-3.5" data-testid="trial-stop-branch">
        <span class="inline-flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-status-bloquee font-extrabold text-status-bloquee-foreground" aria-hidden="true">■</span>
        <div class="flex min-w-0 flex-1 flex-col">
          <span class="text-[15px] font-bold">{{ t('investigation.plan.stop.title') }}</span>
          <span class="text-xs">{{ t('investigation.plan.stop.text') }}</span>
        </div>
      </li>
    </ol>
    <p v-if="selectable && cards.length !== 0 && remaining < 2" id="plan-at-least-one" class="text-xs">{{ t('investigation.plan.atLeastOne') }}</p>
    <p class="text-xs" data-testid="trial-rule">{{ t('investigation.plan.footer', { rule: rules }) }}</p>
  </section>
</template>
