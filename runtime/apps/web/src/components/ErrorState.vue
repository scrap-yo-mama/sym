<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ErrorState.vue
 * @description Erreur de chargement : message traduit à partir du code stable du serveur (`apiErrors.<code>`), bouton de
 * nouvel essai. Annoncée une fois (`role="alert"`) sans retirer le focus (06 § 3). Bordure anthracite pleine, comme le panneau Bloquée :
 * l'orange n'est qu'une surface à texte anthracite, jamais un trait (2:1 sur crème, 20 § 1.3).
 * @component
 * @example <ErrorState :error="error" @retry="refetch" />
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import type { ApiRequestError } from '@/lib/api-result';

const props = defineProps<{ error: ApiRequestError | null }>();
defineEmits<{ retry: [] }>();
const { t, te } = useI18n();
const message = computed(() => {
  const code = props.error?.code;
  if (code && te(`apiErrors.${code}`)) return t(`apiErrors.${code}`);
  if (props.error?.status === 404) return t('apiErrors.not_found');
  if (props.error?.status === 403) return t('apiErrors.forbidden');
  return props.error?.status === 0 ? t('apiErrors.network') : t('apiErrors.generic');
});
</script>

<template>
  <section role="alert" class="flex flex-col items-start gap-3 rounded-lg border-2 border-foreground bg-card p-4" data-testid="error-state">
    <p class="text-sm">{{ message }}</p>
    <Button variant="outline" size="sm" @click="$emit('retry')">{{ t('ui.retry') }}</Button>
  </section>
</template>
