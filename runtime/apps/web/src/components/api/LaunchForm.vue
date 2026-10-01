<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file LaunchForm.vue
 * @description Formulaire « Lancer » généré depuis `input_schema` (string, number, integer, boolean, enum, array de
 * scalaires ; les autres types passent par la saisie JSON). Le coût estimé précède le bouton (« coût habituel : ~0,002 $,
 * médiane de 10 runs » ou « non estimé »). Mode Relancer : champs pré-remplis, choix de la version (courante ou d'origine)
 * et avertissement sur les effets de bord. La validation est celle du serveur (400 `invalid_input`).
 * @component
 * @example <LaunchForm :schema="detail.input_schema" :estimate="detail.cost_estimate" @submit="launch" />
 */
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ApiRequestError } from '@/lib/api-result';
import { formatUsd } from '@/lib/display-format';
import { buildFormModel, initialValues, toInput, type FormValues } from '@/lib/schema-form';

type Estimate = { median_usd: number | null; sample_size: number } | undefined;

const props = defineProps<{
  schema: unknown;
  estimate: Estimate;
  pending?: boolean;
  error?: ApiRequestError | null;
  /** Entrée d'un run précédent (mode Relancer). */
  initialInput?: Record<string, unknown>;
  /** Versions proposées en mode Relancer (courante en premier) ; absent : le formulaire lance la version courante. */
  versions?: { version: number; current: boolean }[];
}>();
const emit = defineEmits<{ submit: [input: Record<string, unknown>, strategyVersion: number | undefined] }>();
const { t, te, locale } = useI18n();

const model = computed(() => buildFormModel(props.schema));
const values = reactive<FormValues>({});
const json = ref('{}');
const jsonError = ref(false);
const version = ref<string>('');

function prefill(): void {
  const base = initialValues(model.value);
  for (const field of model.value.fields) {
    const previous = props.initialInput?.[field.name];
    if (previous === undefined) continue;
    base[field.name] = field.kind === 'boolean' ? previous === true : Array.isArray(previous) ? previous.map(String).join(', ') : String(previous);
  }
  for (const key of Object.keys(values)) delete values[key];
  Object.assign(values, base);
  json.value = props.initialInput ? JSON.stringify(props.initialInput, null, 2) : '{}';
}
watch([model, () => props.initialInput], prefill, { immediate: true });

const estimateText = computed(() => {
  const value = props.estimate;
  if (!value || value.median_usd === null || value.sample_size < 1) return t('launch.estimate.unknown');
  return t('launch.estimate.known', { cost: formatUsd(value.median_usd, locale.value, true), n: String(value.sample_size) }, value.sample_size);
});

const errorText = computed(() => {
  const code = props.error?.code;
  if (!props.error) return null;
  if (code && te(`apiErrors.${code}`)) return t(`apiErrors.${code}`);
  return t(props.error.status === 0 ? 'apiErrors.network' : 'apiErrors.generic');
});

function textValue(name: string): string {
  const value = values[name];
  return typeof value === 'string' ? value : '';
}

function setText(name: string, text: string | number): void {
  values[name] = String(text);
}

function checked(name: string): boolean {
  return values[name] === true;
}

function submit(): void {
  jsonError.value = false;
  let input: Record<string, unknown>;
  if (model.value.needsJsonEditor) {
    try {
      const parsed: unknown = JSON.parse(json.value);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('object');
      input = parsed as Record<string, unknown>;
    } catch {
      jsonError.value = true;
      return;
    }
  } else {
    input = toInput(model.value, values);
  }
  emit('submit', input, version.value === '' ? undefined : Number(version.value));
}

const selectClass = 'h-9 rounded-md border border-input bg-background px-2 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none';
</script>

<template>
  <form id="launch" class="flex flex-col gap-4" :aria-label="versions ? t('launch.relaunchTitle') : t('launch.title')" data-testid="launch-form" @submit.prevent="submit">
    <h3 class="text-base font-semibold">{{ versions ? t('launch.relaunchTitle') : t('launch.title') }}</h3>

    <p v-if="versions" class="rounded-md border border-amber-700 p-3 text-sm dark:border-amber-400" data-testid="side-effects-warning">{{ t('launch.sideEffects') }}</p>

    <template v-if="!model.needsJsonEditor">
      <p v-if="model.fields.length === 0" class="text-sm text-muted-foreground">{{ t('launch.noInput') }}</p>
      <div v-for="field in model.fields" :key="field.name" class="flex flex-col gap-1">
        <label :for="`launch-${field.name}`" class="text-sm font-medium">
          {{ field.name }}<span v-if="field.required" class="text-destructive"> *</span>
        </label>
        <p v-if="field.description" :id="`launch-${field.name}-help`" class="text-sm text-muted-foreground">{{ field.description }}</p>
        <input
          v-if="field.kind === 'boolean'"
          :id="`launch-${field.name}`"
          :checked="checked(field.name)"
          type="checkbox"
          class="size-5 self-start"
          :aria-describedby="field.description ? `launch-${field.name}-help` : undefined"
          @change="values[field.name] = ($event.target as HTMLInputElement).checked"
        />
        <select v-else-if="field.kind === 'enum'" :id="`launch-${field.name}`" :value="textValue(field.name)" :class="selectClass" :required="field.required" @change="setText(field.name, ($event.target as HTMLSelectElement).value)">
          <option v-if="!field.required" value="">{{ t('ui.none') }}</option>
          <option v-for="option in field.options" :key="option" :value="option">{{ option }}</option>
        </select>
        <template v-else-if="field.kind === 'array'">
          <Input
            :id="`launch-${field.name}`"
            :model-value="textValue(field.name)"
            :aria-describedby="`launch-${field.name}-hint`"
            @update:model-value="setText(field.name, $event)"
          />
          <p :id="`launch-${field.name}-hint`" class="text-xs text-muted-foreground">{{ t('launch.arrayHint') }}</p>
        </template>
        <Input
          v-else
          :id="`launch-${field.name}`"
          :model-value="textValue(field.name)"
          :type="field.kind === 'string' ? 'text' : 'number'"
          :step="field.kind === 'integer' ? '1' : 'any'"
          :required="field.required"
          :aria-describedby="field.description ? `launch-${field.name}-help` : undefined"
          @update:model-value="setText(field.name, $event)"
        />
      </div>
    </template>
    <div v-else class="flex flex-col gap-1">
      <label for="launch-json" class="text-sm font-medium">{{ t('launch.jsonLabel') }}</label>
      <p class="text-sm text-muted-foreground">{{ t('launch.jsonHint') }}</p>
      <textarea id="launch-json" v-model="json" rows="8" spellcheck="false" class="rounded-md border border-input bg-transparent p-2 font-mono text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none" :aria-invalid="jsonError ? 'true' : 'false'" />
      <p v-if="jsonError" role="alert" class="text-sm text-destructive">{{ t('launch.jsonInvalid') }}</p>
    </div>

    <div v-if="versions && versions.length > 1" class="flex flex-col gap-1">
      <label for="launch-version" class="text-sm font-medium">{{ t('launch.version') }}</label>
      <select id="launch-version" v-model="version" :class="selectClass">
        <option v-for="entry in versions" :key="entry.version" :value="entry.current ? '' : String(entry.version)">
          {{ entry.current ? t('launch.versionCurrent', { v: String(entry.version) }) : t('launch.versionOther', { v: String(entry.version) }) }}
        </option>
      </select>
    </div>

    <!-- Le coût estimé précède le bouton (06 § 4.3, assert_cost_estimate_before_run). -->
    <p class="text-sm" data-testid="cost-estimate">{{ estimateText }}</p>

    <p v-if="errorText" role="alert" class="text-sm text-destructive" data-testid="launch-error">{{ errorText }}</p>
    <div>
      <Button type="submit" :disabled="pending" data-testid="launch-submit">{{ versions ? t('actions.relaunch') : t('actions.launch') }}</Button>
    </div>
  </form>
</template>
