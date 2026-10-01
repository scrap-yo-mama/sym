<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ConfirmPanel.vue
 * @description Confirmation en ligne d'une action à conséquence (revenir à une version, modifier la sortie) : aperçu de
 * la conséquence (et, dans l'emplacement par défaut, l'aperçu de ce qui change), bouton de confirmation, bouton d'annulation. Le focus arrive sur Annuler (le choix prudent) et la
 * touche Échap annule. Pas de fenêtre modale : l'écran reste lisible et navigable au clavier.
 * @component
 * @example <ConfirmPanel id="revert" :title="title" :consequence="consequence" :confirm-label="label" @confirm="go" @cancel="close" />
 */
import { onMounted, useTemplateRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';

defineProps<{ title: string; consequence: string; confirmLabel: string; pending?: boolean; id: string }>();
defineEmits<{ confirm: []; cancel: [] }>();
const { t } = useI18n();
const cancelButton = useTemplateRef<{ $el: HTMLElement }>('cancelButton');
onMounted(() => cancelButton.value?.$el.focus());
</script>

<template>
  <section :aria-labelledby="`${id}-title`" class="flex flex-col gap-3 rounded-lg border-2 border-amber-700 p-4 dark:border-amber-400" data-testid="confirm-panel" @keydown.esc="$emit('cancel')">
    <h4 :id="`${id}-title`" class="font-semibold">{{ title }}</h4>
    <p class="text-sm">{{ consequence }}</p>
    <slot />
    <div class="flex flex-wrap gap-3">
      <Button :disabled="pending" data-testid="confirm-yes" @click="$emit('confirm')">{{ confirmLabel }}</Button>
      <Button ref="cancelButton" variant="outline" @click="$emit('cancel')">{{ t('ui.cancel') }}</Button>
    </div>
  </section>
</template>
