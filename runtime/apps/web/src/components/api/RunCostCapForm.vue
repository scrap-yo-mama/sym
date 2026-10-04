<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file RunCostCapForm.vue
 * @description « Coût max par run » d'une API (D-123), propriétaire seulement : champ facultatif, vide par défaut (aucun
 * plafond par run ; le budget du jour du compte reste la limite), un montant fixe un plafond, « Retirer le plafond »
 * l'efface. Le serveur reste juge (400 `cost_cap_exceeded` au-delà du plafond d'instance), message en code stable.
 * @component
 * @example <RunCostCapForm :detail="detail" slug="zz-books" @updated="onUpdated" />
 */
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ApiDetail } from '@/composables/useApiDetail';
import { useRunCostCap } from '@/composables/useRunCostCap';
import { formatUsd } from '@/lib/display-format';

const props = defineProps<{ detail: ApiDetail; slug: string }>();
const emit = defineEmits<{ updated: [detail: ApiDetail] }>();
const { t, te, locale } = useI18n();
const cap = useRunCostCap(() => props.slug);

const current = computed(() => props.detail.max_cost_usd ?? null);
const text = ref(current.value === null ? '' : String(current.value));
watch(current, (value) => {
  text.value = value === null ? '' : String(value);
});
const saved = ref(false);

const errorText = computed(() => {
  if (cap.invalid.value) return t('costCap.invalid');
  const failure = cap.error.value;
  if (!failure) return null;
  if (failure.code && te(`apiErrors.${failure.code}`)) return t(`apiErrors.${failure.code}`);
  return t(failure.status === 0 ? 'apiErrors.network' : 'apiErrors.generic');
});

async function submit(value: string): Promise<void> {
  saved.value = false;
  const updated = await cap.save(value);
  if (updated) {
    saved.value = true;
    emit('updated', updated);
  }
}
</script>

<template>
  <section aria-labelledby="cost-cap-heading" class="flex flex-col gap-3" data-testid="cost-cap-form">
    <h2 id="cost-cap-heading" class="text-lg font-semibold">{{ t('costCap.title') }}</h2>
    <p class="text-sm" data-testid="cost-cap-current">
      <template v-if="current === null">{{ t('costCap.none') }}</template>
      <template v-else>{{ t('costCap.current', { cost: formatUsd(current, locale, false) }) }}</template>
    </p>
    <form class="flex max-w-xl flex-col gap-2" @submit.prevent="submit(text)">
      <label for="cost-cap-input" class="text-sm font-medium">{{ t('costCap.label') }}</label>
      <Input id="cost-cap-input" v-model="text" inputmode="decimal" autocomplete="off" aria-describedby="cost-cap-help" :aria-invalid="cap.invalid.value ? 'true' : 'false'" data-testid="cost-cap-input" />
      <p id="cost-cap-help" class="text-sm text-muted-foreground">{{ t('costCap.hint') }}</p>
      <div class="flex flex-wrap gap-2">
        <Button type="submit" size="sm" :disabled="cap.pending.value">{{ t('costCap.save') }}</Button>
        <Button v-if="current !== null" type="button" variant="outline" size="sm" :disabled="cap.pending.value" data-testid="cost-cap-clear" @click="submit('')">{{ t('costCap.clear') }}</Button>
      </div>
    </form>
    <p v-if="errorText" role="alert" class="sym-error">{{ errorText }}</p>
    <p v-else role="status" class="text-sm text-muted-foreground">
      <template v-if="saved">{{ t('costCap.saved') }}</template>
    </p>
  </section>
</template>
