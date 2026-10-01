<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file AccountSiteWarning.vue
 * @description Avertissement des sites à compte (A11, 17 § 7) à confirmer avant la création d'une API : conditions
 * d'utilisation de la plateforme (extraction souvent interdite), RGPD (données de tiers), responsabilité de l'utilisateur ;
 * rappelle que sa session est la seule utilisée (INV5). Texte de 06 § 2.
 * @component
 * @example <AccountSiteWarning v-model="form.accountConfirmed" :error="errors.account === true" />
 */
import { useI18n } from 'vue-i18n';

interface Props {
  /** L'avertissement est confirmé. */
  modelValue: boolean;
  /** La création a été refusée faute de confirmation. */
  error?: boolean;
}

withDefaults(defineProps<Props>(), { error: false });

interface Emits {
  (e: 'update:modelValue', value: boolean): void;
}
const emit = defineEmits<Emits>();

const { t } = useI18n();
</script>

<template>
  <div class="flex flex-col gap-2 rounded-lg border-2 p-3" data-testid="account-warning" aria-labelledby="account-warning-title">
    <p id="account-warning-title" class="font-medium">{{ t('newApi.account.title') }}</p>
    <p class="text-sm" data-testid="account-warning-text">{{ t('newApi.account.warning') }}</p>
    <p class="text-sm text-muted-foreground">{{ t('newApi.account.ownSession') }}</p>
    <label class="flex min-h-11 items-center gap-2 text-sm">
      <input
        type="checkbox"
        class="size-4"
        data-testid="account-confirm"
        :checked="modelValue"
        :aria-describedby="error ? 'account-confirm-error' : undefined"
        @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
      />
      {{ t('newApi.account.confirm') }}
    </label>
    <p v-if="error" id="account-confirm-error" class="sym-error" role="alert">{{ t('newApi.accountRequired') }}</p>
  </div>
</template>
