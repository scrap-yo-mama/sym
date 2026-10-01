<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file TextField.vue
 * @description Champ de formulaire des écrans de comptes : libellé lié, aide et erreur reliées par `aria-describedby`, champ
 * marqué invalide (WCAG 1.3.1, 3.3.1). Les attributs (`type`, `name`, `autocomplete`, `required`…) passent au champ ; la valeur est
 * relue dans le DOM à l'envoi par les écrans (l'autoremplissage ne déclenche pas toujours `input`, F-20261001-UX01).
 * @component
 * @example <TextField id="login-email" v-model="email" :label="t('auth.login.email')" type="email" name="email" />
 */
import { computed } from 'vue';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

defineOptions({ inheritAttrs: false });
const props = defineProps<{ id: string; label: string; modelValue: string | number; hint?: string; error?: string | null }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const describedBy = computed(() => [props.hint ? `${props.id}-hint` : '', props.error ? `${props.id}-error` : ''].filter(Boolean).join(' ') || undefined);
</script>

<template>
  <div class="flex flex-col gap-1">
    <Label :for="id">{{ label }}</Label>
    <Input
      :id="id"
      v-bind="$attrs"
      :model-value="modelValue"
      :aria-invalid="error ? true : undefined"
      :aria-describedby="describedBy"
      @update:model-value="(value: string | number) => emit('update:modelValue', String(value))"
    />
    <p v-if="hint" :id="`${id}-hint`" class="text-xs text-muted-foreground">{{ hint }}</p>
    <p v-if="error" :id="`${id}-error`" class="sym-error">{{ error }}</p>
  </div>
</template>
