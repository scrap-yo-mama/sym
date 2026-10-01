<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file StrategyDiffView.vue
 * @description Diff à trois niveaux entre deux versions de stratégie (06 § 2) : (1) une phrase générée par le serveur
 * (« le sélecteur du prix a changé »), traduite à partir de son code ; (2) le tableau des champs modifiés ; (3) le diff
 * brut côte à côte. Un changement n'est jamais porté par la couleur seule : glyphe et texte pour ajout, retrait, modification.
 * @component
 * @example <StrategyDiffView :diff="diff" />
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { StrategyDiff } from '@/composables/useStrategyVersions';
import { sideBySide, type DiffKind } from '@/lib/line-diff';
import { describeDiffSummary } from '@/lib/reasons';

/** `level` : niveau du titre du diff (3 dans l'onglet, 5 dans l'aperçu d'un retour de version) ; les parties sont au niveau suivant. */
const props = withDefaults(defineProps<{ diff: StrategyDiff; level?: 3 | 5 }>(), { level: 3 });
const titleTag = computed(() => `h${props.level}`);
const partTag = computed(() => `h${props.level + 1}`);
const { t, te, locale } = useI18n();

const sentence = computed(() => describeDiffSummary((key, named) => t(key, named ?? {}), te, locale.value, props.diff.summary, props.diff.fields.length));
const rows = computed(() => sideBySide(props.diff.raw.before, props.diff.raw.after));

function show(value: unknown): string {
  if (value === undefined) return '—';
  const text = JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

const GLYPH: Record<DiffKind, string> = { same: ' ', changed: '~', removed: '−', added: '+' };
const ROW_TONE: Record<DiffKind, string> = { same: '', changed: 'bg-amber-100 dark:bg-amber-950', removed: 'bg-red-100 dark:bg-red-950', added: 'bg-emerald-100 dark:bg-emerald-950' };
</script>

<template>
  <section class="flex flex-col gap-4" data-testid="strategy-diff" :aria-label="t('diff.title', { from: String(diff.from), to: String(diff.to) })">
    <component :is="titleTag" class="text-base font-semibold">{{ t('diff.title', { from: String(diff.from), to: String(diff.to) }) }}</component>

    <div data-testid="diff-summary">
      <component :is="partTag" class="text-sm font-medium">{{ t('diff.summary') }}</component>
      <p>{{ sentence }}</p>
    </div>

    <div data-testid="diff-fields">
      <component :is="partTag" class="text-sm font-medium">{{ t('diff.fields') }}</component>
      <p v-if="diff.fields.length === 0" class="text-sm text-muted-foreground">{{ t('diff.noFields') }}</p>
      <div v-else class="overflow-x-auto rounded-lg border">
        <table class="w-full text-left text-sm">
          <caption class="sr-only">{{ t('diff.fields') }}</caption>
          <thead class="bg-muted text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('diff.columns.path') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('diff.columns.change') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('diff.columns.before') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ t('diff.columns.after') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="field in diff.fields" :key="field.path" class="border-t align-top">
              <th scope="row" class="px-3 py-2 font-mono font-normal">{{ field.path }}</th>
              <td class="px-3 py-2">{{ t(`diff.change.${field.change}`) }}</td>
              <td class="px-3 py-2 font-mono">{{ show(field.before) }}</td>
              <td class="px-3 py-2 font-mono">{{ show(field.after) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div data-testid="diff-raw">
      <component :is="partTag" class="text-sm font-medium">{{ t('diff.raw') }}</component>
      <div class="overflow-x-auto rounded-lg border">
        <table class="w-full table-fixed border-collapse font-mono text-xs">
          <caption class="sr-only">{{ t('diff.rawCaption', { from: String(diff.from), to: String(diff.to) }) }}</caption>
          <thead class="bg-muted text-muted-foreground">
            <tr>
              <th scope="col" class="w-1/2 px-2 py-1 text-left font-medium">{{ t('diff.version', { v: String(diff.from) }) }}</th>
              <th scope="col" class="w-1/2 px-2 py-1 text-left font-medium">{{ t('diff.version', { v: String(diff.to) }) }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in rows" :key="index" :class="ROW_TONE[row.kind]" :data-kind="row.kind">
              <td class="px-2 py-0.5 break-all whitespace-pre-wrap">
                <span aria-hidden="true">{{ row.left === null ? ' ' : row.kind === 'same' ? ' ' : GLYPH.removed }}</span>
                <span v-if="row.kind !== 'same' && row.left !== null" class="sr-only">{{ t('diff.change.removed') }} : </span>{{ row.left ?? '' }}
              </td>
              <td class="px-2 py-0.5 break-all whitespace-pre-wrap">
                <span aria-hidden="true">{{ row.right === null ? ' ' : row.kind === 'same' ? ' ' : GLYPH.added }}</span>
                <span v-if="row.kind !== 'same' && row.right !== null" class="sr-only">{{ t('diff.change.added') }} : </span>{{ row.right ?? '' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
