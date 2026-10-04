<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file PairingCard.vue
 * @description « Connecter l'extension » en un collage (U3.1, 05 § 2) : étape 1 installer, étape 2 copier le code
 * `sym-pair:v1:…` (l'adresse de l'instance y est déjà), saisie à la main en secours, puis « Extension connectée » dès
 * que l'extension s'appaire (sans recharger la page). Le code n'apparaît qu'une fois.
 * @component
 * @example <PairingCard :pairing="pairing" @dismiss="dismiss" />
 */
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import type { PairingState } from '@/composables/useSettings';
import { formatDateTime } from '@/lib/format';

interface Props {
  pairing: PairingState;
  /** Adresse de l'instance montrée pour la saisie à la main (origine de la console). */
  instanceUrl?: string;
}
const props = withDefaults(defineProps<Props>(), { instanceUrl: '' });
defineEmits<{ dismiss: [] }>();

const { t, locale } = useI18n();
const copied = ref(false);
const date = (iso: string | null): string => formatDateTime(iso, locale.value) ?? t('settings.extension.never');
const shown = (): string => props.pairing.pairingCode ?? props.pairing.code;

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(shown());
    copied.value = true;
  } catch {
    copied.value = false; // presse-papiers refusé : le code reste sélectionnable à l'écran
  }
}
</script>

<template>
  <div class="flex flex-col gap-3 rounded-lg border-2 p-3" role="status" data-testid="pairing-code">
    <template v-if="pairing.connected">
      <p class="text-lg font-semibold" data-testid="pairing-connected">{{ t('settings.extension.connectedTitle') }}</p>
      <p class="text-sm text-muted-foreground">
        {{ t('settings.extension.connectedDetail', { device: pairing.connected.deviceLabel ?? t('settings.extension.deviceUnnamed'), date: date(pairing.connected.createdAt) }) }}
      </p>
    </template>
    <template v-else>
      <ol class="flex list-none flex-col gap-3 p-0">
        <li class="flex flex-col gap-1" data-testid="pairing-step-1">
          <span class="font-semibold">{{ t('settings.extension.step1Title') }}</span>
          <span class="text-sm text-muted-foreground">{{ t('settings.extension.step1Help') }}</span>
        </li>
        <li class="flex flex-col gap-2" data-testid="pairing-step-2">
          <span class="font-semibold">{{ t('settings.extension.step2Title') }}</span>
          <code class="break-all rounded-md border bg-muted/50 p-2 font-mono text-sm" data-testid="pairing-text">{{ shown() }}</code>
          <div class="flex items-center gap-2">
            <Button type="button" size="sm" data-testid="pairing-copy" @click="copy">{{ t('settings.extension.copyCode') }}</Button>
            <span v-if="copied" class="text-sm text-muted-foreground" role="status">{{ t('settings.extension.copied') }}</span>
          </div>
        </li>
      </ol>
      <p class="text-sm text-muted-foreground">{{ t('settings.extension.codeExpires', { date: date(pairing.expiresAt) }) }}</p>
      <p v-if="pairing.pairingCode" class="text-sm text-muted-foreground" data-testid="pairing-by-hand">{{ t('settings.extension.byHand', { url: instanceUrl, code: pairing.code }) }}</p>
      <p class="text-sm" data-testid="pairing-waiting">{{ t('settings.extension.waiting') }}</p>
    </template>
    <div><Button type="button" variant="outline" size="sm" @click="$emit('dismiss')">{{ t('settings.extension.dismissCode') }}</Button></div>
  </div>
</template>
