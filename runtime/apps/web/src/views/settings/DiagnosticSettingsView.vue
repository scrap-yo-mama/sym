<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file DiagnosticSettingsView.vue
 * @description Réglages > Diagnostic (06 § 2, INV9) : bouton d'export JSON local masqué ; aucun envoi. Le fichier ne
 * contient que la version de l'instance, la version du schéma, l'état de disponibilité et la langue de la console.
 * @page
 */
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { getApi } from '@/lib/api';
import { collectDiagnostic, downloadDiagnostic } from '@/lib/diagnostic';

const { t, locale } = useI18n();
const exported = ref(false);
const busy = ref(false);

async function exportDiagnostic(): Promise<void> {
  busy.value = true;
  exported.value = false;
  downloadDiagnostic(await collectDiagnostic(getApi(), locale.value));
  busy.value = false;
  exported.value = true;
}
</script>

<template>
  <section class="flex flex-col gap-4" aria-labelledby="diagnostic-heading">
    <header class="flex flex-col gap-1">
      <h1 id="diagnostic-heading" data-route-heading tabindex="-1" class="text-2xl font-semibold tracking-tight">{{ t('settings.diagnostic.title') }}</h1>
      <p class="text-sm text-muted-foreground">{{ t('settings.diagnostic.intro') }}</p>
      <p class="text-sm text-muted-foreground">{{ t('settings.diagnostic.includes') }}</p>
    </header>
    <div class="flex flex-wrap items-center gap-3">
      <Button type="button" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="busy" data-testid="diagnostic-export" @click="exportDiagnostic">
        {{ t('settings.diagnostic.export') }}
      </Button>
      <p role="status" class="text-sm text-muted-foreground">{{ exported ? t('settings.diagnostic.exported') : '' }}</p>
    </div>
  </section>
</template>
