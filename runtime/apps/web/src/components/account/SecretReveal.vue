<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file SecretReveal.vue
 * @description Valeur montrée une seule fois (clé d'API, lien d'invitation ou de réinitialisation, codes de secours) : titre,
 * texte, valeur en texte sélectionnable, bouton Copier, bouton de fermeture. La valeur vit dans la mémoire de l'écran le temps de
 * l'affichage ; la fermer l'efface. Annoncé en `role="status"` sans prendre le focus (06 § 3). Aucun secret n'est relu du serveur.
 * @component
 * @example <SecretReveal :title="t('keys.created.title')" :text="t('keys.created.text')" :value="key" :dismiss-label="t('keys.created.dismiss')" @dismiss="clear" />
 */
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/clipboard';

const props = defineProps<{ title: string; text: string; value: string; label?: string; copyLabel?: string; dismissLabel: string; multiline?: boolean }>();
defineEmits<{ dismiss: [] }>();
const { t } = useI18n();
const copied = ref<'idle' | 'ok' | 'failed'>('idle');

async function copy(): Promise<void> {
  copied.value = (await copyText(props.value)) ? 'ok' : 'failed';
}
</script>

<template>
  <section class="flex flex-col gap-2 rounded-lg border-2 p-3" role="status" data-testid="secret-reveal">
    <h3 class="font-semibold">{{ title }}</h3>
    <p class="text-sm text-muted-foreground">{{ text }}</p>
    <p v-if="label" class="text-sm font-medium">{{ label }}</p>
    <pre v-if="multiline" class="overflow-x-auto rounded-md border p-2 font-mono text-sm select-all" data-testid="secret-value">{{ value }}</pre>
    <code v-else class="rounded-md border p-2 font-mono text-sm break-all select-all" data-testid="secret-value">{{ value }}</code>
    <div class="flex flex-wrap items-center gap-3">
      <Button type="button" variant="outline" size="sm" @click="copy()">{{ copyLabel ?? t('ui.copy') }}</Button>
      <Button type="button" size="sm" @click="$emit('dismiss')">{{ dismissLabel }}</Button>
      <span v-if="copied === 'ok'" class="text-sm" data-testid="copy-result">{{ t('ui.copied') }}</span>
      <span v-else-if="copied === 'failed'" class="text-sm text-destructive" data-testid="copy-result">{{ t('ui.copyFailed') }}</span>
    </div>
  </section>
</template>
