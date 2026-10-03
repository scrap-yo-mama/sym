<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file RunQualityCard.vue
 * @description Fiche qualité d'un run et avis du juge (tâche 2.12, 19 § 3), sur l'OpenAPI spécifiée (`Run.quality`,
 * `Run.judge`). Le profil est calculé par le code, sans IA ; un champ personnel n'a que des formes (remplissage,
 * sentinelles, format, longueurs), jamais min, max ni exemple. L'avis du juge est marqué « consultatif » : la fiche ne
 * propose AUCUNE action (ni bouton, ni lien) et rappelle que l'avis ne change ni le statut ni la version.
 * @component
 * @example <RunQualityCard :quality="run.quality" :judge="run.judge" :degraded-reasons="run.degraded_reasons" />
 */
import type { components } from '@runtime/client';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useReason } from '@/composables/useReason';

type Schemas = components['schemas'];

interface Props {
  quality: Schemas['RunQuality'] | null;
  judge: Schemas['RunJudge'] | null;
  degradedReasons?: readonly string[];
}

const props = withDefaults(defineProps<Props>(), { degradedReasons: () => [] });
const { t, locale } = useI18n();
const { reasonShort } = useReason();

const percent = (value: number): string => new Intl.NumberFormat(locale.value, { style: 'percent', maximumFractionDigits: 0 }).format(value);
const number = (value: number): string => new Intl.NumberFormat(locale.value, { maximumFractionDigits: 2 }).format(value);

const fields = computed(() => Object.entries(props.quality?.fields ?? {}).map(([name, field]) => ({ name, ...field, shapesOnly: field.personal || field.suspected_personal })));
</script>

<template>
  <section class="flex flex-col gap-3 rounded-xl border p-4" data-testid="run-quality" aria-labelledby="run-quality-heading">
    <h3 id="run-quality-heading" class="text-base font-semibold">{{ t('quality.title') }}</h3>
    <p v-if="quality" class="text-sm text-muted-foreground">{{ t('quality.summary', { n: quality.items, d: quality.duplicates }) }}</p>
    <p v-else class="text-sm text-muted-foreground">{{ t('quality.empty') }}</p>

    <div v-if="degradedReasons.length > 0" class="text-sm" data-testid="quality-signals">
      <span class="font-medium">{{ t('quality.signals') }} :</span>
      {{ degradedReasons.map(reasonShort).join(', ') }}
    </div>

    <div v-if="quality && fields.length > 0" class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <caption class="sr-only">{{ t('quality.caption') }}</caption>
        <thead class="border-b bg-muted/50">
          <tr>
            <th scope="col" class="p-2 font-medium">{{ t('quality.columns.field') }}</th>
            <th scope="col" class="p-2 font-medium">{{ t('quality.columns.type') }}</th>
            <th scope="col" class="p-2 font-medium">{{ t('quality.columns.fill') }}</th>
            <th scope="col" class="p-2 font-medium">{{ t('quality.columns.sentinels') }}</th>
            <th scope="col" class="p-2 font-medium">{{ t('quality.columns.pattern') }}</th>
            <th scope="col" class="p-2 font-medium">{{ t('quality.columns.unique') }}</th>
            <th scope="col" class="p-2 font-medium">{{ t('quality.columns.range') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="field in fields" :key="field.name" class="border-b last:border-0" :data-field="field.name">
            <th scope="row" class="p-2 font-normal">
              <code>{{ field.name }}</code>
              <span v-if="field.personal" class="block text-xs text-muted-foreground">{{ t('quality.personal') }}</span>
              <span v-else-if="field.suspected_personal" class="block text-xs text-muted-foreground">{{ t('quality.suspected') }}</span>
            </th>
            <td class="p-2">{{ field.type }}</td>
            <td class="p-2">{{ percent(field.fill_rate) }}</td>
            <td class="p-2">{{ percent(field.sentinel_rate) }}</td>
            <td class="p-2"><code v-if="field.top_pattern">{{ field.top_pattern }}</code><span v-else>—</span></td>
            <td class="p-2">{{ percent(field.unique_rate) }}</td>
            <td v-if="!field.shapesOnly && field.min !== undefined && field.max !== undefined" class="p-2">
              <span data-testid="field-min">{{ number(field.min) }}</span> – <span data-testid="field-max">{{ number(field.max) }}</span>
            </td>
            <td v-else class="p-2">—</td>
          </tr>
        </tbody>
      </table>
    </div>

    <section v-if="judge" class="flex flex-col gap-2 rounded-lg border border-dashed p-3" data-testid="judge-advisory" aria-labelledby="judge-heading">
      <h4 id="judge-heading" class="text-sm font-semibold">{{ t('quality.judge.title') }} ({{ t(`quality.judge.trigger.${judge.trigger}`) }})</h4>
      <p class="text-sm">{{ t('quality.judge.advisory') }}</p>
      <p class="text-sm text-muted-foreground">{{ t('quality.judge.unchanged') }}</p>
      <ul class="flex flex-col gap-1 text-sm">
        <li v-for="verdict in judge.verdicts.filter((v) => v.verdict !== 'ok')" :key="verdict.field" :data-verdict="verdict.verdict">
          <code>{{ verdict.field }}</code> : {{ t(`quality.judge.verdict.${verdict.verdict}`) }}<span v-if="verdict.reason"> — {{ verdict.reason }}</span>
        </li>
      </ul>
    </section>
  </section>
</template>
