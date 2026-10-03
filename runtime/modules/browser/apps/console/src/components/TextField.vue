<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file TextField.vue
 * @description Champ libellé de la console : <label> lié (Reka UI), aide et erreur reliées par aria-describedby, état
 * invalide porté par aria-invalid ET par une bordure plus épaisse (jamais la couleur seule, WCAG 1.4.1), champ de 44 px.
 * @component
 */
import { Label } from 'reka-ui';
import { computed, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    id: string;
    label: string;
    name: string;
    type?: 'text' | 'email' | 'password';
    autocomplete?: string;
    inputmode?: 'text' | 'email' | 'numeric';
    hint?: string;
    invalid?: boolean;
    /** Identifiant d'un message d'erreur affiché ailleurs (alerte du formulaire), ajouté à aria-describedby. */
    errorId?: string;
    minlength?: number;
    maxlength?: number;
    spellcheck?: boolean;
  }>(),
  { type: 'text', invalid: false, spellcheck: true },
);
const model = defineModel<string>({ required: true });

const input = ref<HTMLInputElement | null>(null);
const hintId = computed(() => (props.hint ? `${props.id}-hint` : undefined));
const describedBy = computed(() => [hintId.value, props.invalid ? props.errorId : undefined].filter(Boolean).join(' ') || undefined);

defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <Label :for="id" class="text-sm font-medium">{{ label }}</Label>
    <input
      :id="id"
      ref="input"
      v-model="model"
      :name="name"
      :type="type"
      :autocomplete="autocomplete"
      :inputmode="inputmode"
      :minlength="minlength"
      :maxlength="maxlength"
      :spellcheck="spellcheck ? undefined : 'false'"
      autocapitalize="off"
      required
      :aria-invalid="invalid ? 'true' : undefined"
      :aria-describedby="describedBy"
      class="h-11 w-full min-w-0 rounded-md border border-input bg-card px-3 text-base text-card-foreground outline-none focus-visible:border-ring aria-invalid:border-2 aria-invalid:border-foreground md:text-sm"
    />
    <p v-if="hint" :id="hintId" class="text-sm text-muted-foreground">{{ hint }}</p>
  </div>
</template>
