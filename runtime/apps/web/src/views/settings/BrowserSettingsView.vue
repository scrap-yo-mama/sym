<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file BrowserSettingsView.vue
 * @description Réglages > Navigateur (admin ou owner, tâche 4.7, 04g § 3) : le fournisseur de navigateur que le worker publie, l'état
 * d'activation du navigateur CDP générique et le tableau des capacités côté navigateur, présentes et absentes, avec le lien « Usage
 * responsable ». Lecture seule : l'activation est la variable `BROWSER_ALLOW_GENERIC_CDP` du worker, jamais un réglage de la console.
 * Une capacité absente est dite absente en toutes lettres (jamais la couleur seule). Aucune adresse, aucun secret.
 * @page
 */
import { SymSignature } from '@runtime/ui';
import { computed, onMounted, onServerPrefetch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useBrowserSettings, type BrowserSettings } from '@/composables/useBrowserSettings';

const { t, locale } = useI18n();
const settings = useBrowserSettings();

type Capability = NonNullable<BrowserSettings['capabilities']>;
/** Dix lignes de 04g § 3 ; `worker` : la capacité publiée dont la ligne dépend (une capacité du fournisseur couvre plusieurs lignes). */
const ROWS: readonly { id: string; worker: keyof Capability; cdpNote: boolean }[] = [
  { id: 'egress', worker: 'egressPolicy', cdpNote: false },
  { id: 'domainLock', worker: 'egressPolicy', cdpNote: true },
  { id: 'budget', worker: 'egressPolicy', cdpNote: false },
  { id: 'launchArgs', worker: 'launchArgs', cdpNote: true },
  { id: 'closedProxy', worker: 'launchArgs', cdpNote: false },
  { id: 'freshContext', worker: 'freshContextPerRun', cdpNote: true },
  { id: 'killBeforeDetach', worker: 'killBeforeDetach', cdpNote: false },
  { id: 'sandbox', worker: 'sandboxProbe', cdpNote: false },
  { id: 'userAgent', worker: 'engineUserAgent', cdpNote: false },
  { id: 'latency', worker: 'privateLatency', cdpNote: false },
];

const data = computed(() => settings.data.value);
const capabilities = computed(() => data.value?.capabilities ?? null);
const providerLabel = computed(() => {
  switch (data.value?.kind) {
    case 'local':
      return t('instance.browser.providerLocal');
    case 'sym-browser':
      return t('instance.browser.providerSymBrowser');
    case 'cdp':
      return t('instance.browser.providerCdp');
    default:
      return null;
  }
});
const presence = (present: boolean): string => (present ? t('instance.browser.present') : t('instance.browser.absent'));
const note = (id: string): string => t(`instance.browser.cdpNotes.${id}`);

onMounted(() => void settings.load());
onServerPrefetch(() => settings.load());
</script>

<template>
  <section class="flex flex-col gap-6" aria-labelledby="browser-heading">
    <header class="flex flex-col gap-1">
      <h1 id="browser-heading" data-route-heading tabindex="-1" class="sym-title">{{ t('instance.browser.title') }}</h1>
      <p class="text-sm text-muted-foreground">{{ t('instance.browser.intro') }}</p>
    </header>

    <p v-if="settings.loading.value && !data" role="status" class="text-sm text-muted-foreground">{{ t('ui.loading') }}</p>
    <Alert v-else-if="settings.failure.value" variant="destructive" data-testid="browser-load-error">
      <AlertDescription>{{ settings.forbidden.value ? t('settings.adminOnly') : t(settings.failure.value) }}</AlertDescription>
    </Alert>
    <template v-else-if="data">
      <div class="flex flex-col gap-3 rounded-xl border p-4" data-testid="browser-provider">
        <p class="text-sm font-medium">{{ t('instance.browser.provider') }}</p>
        <p v-if="providerLabel" class="text-sm" data-testid="browser-provider-kind">{{ providerLabel }}</p>
        <p v-else class="text-sm text-muted-foreground" data-testid="browser-provider-unknown">{{ t('instance.browser.providerUnknown') }}</p>
        <template v-if="data.generic_cdp_enabled !== null">
          <p class="text-sm font-medium">{{ t('instance.browser.activation') }}</p>
          <p class="text-sm text-muted-foreground" data-testid="browser-activation">{{ data.generic_cdp_enabled ? t('instance.browser.activationOn') : t('instance.browser.activationOff') }}</p>
        </template>
        <p v-if="data.kind === 'cdp'" class="text-sm" data-testid="browser-cdp-bubble"><SymSignature class="mr-1.5" variant="speaking" :locale="locale === 'fr' ? 'fr' : 'en'" />{{ t('instance.browser.bubble') }}</p>
      </div>

      <div class="flex flex-col gap-2">
        <table class="w-full text-left text-sm" data-testid="browser-capabilities">
          <caption class="mb-2 text-left text-base font-medium">{{ t('instance.browser.tableTitle') }}</caption>
          <thead>
            <tr>
              <th scope="col" class="py-2 pr-3">{{ t('instance.browser.colCapability') }}</th>
              <th scope="col" class="py-2 pr-3">{{ t('instance.browser.colSymBrowser') }}</th>
              <th scope="col" class="py-2 pr-3">{{ t('instance.browser.colCdp') }}</th>
              <th v-if="capabilities" scope="col" class="py-2">{{ t('instance.browser.colWorker') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in ROWS" :key="row.id" class="border-t" data-testid="browser-capability">
              <th scope="row" class="py-2 pr-3 font-normal">{{ t(`instance.browser.capabilities.${row.id}`) }}</th>
              <td class="py-2 pr-3">{{ presence(true) }}</td>
              <td class="py-2 pr-3">{{ presence(false) }}<template v-if="row.cdpNote"> : {{ note(row.id) }}</template></td>
              <td v-if="capabilities" class="py-2" data-testid="browser-capability-worker">{{ presence(capabilities[row.worker]) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="text-sm text-muted-foreground">
          {{ t('instance.browser.responsibleUse') }}
          <a href="/docs/responsible-use/" class="underline underline-offset-4" data-testid="browser-responsible-use">{{ t('instance.browser.responsibleUseLink') }}</a>
        </p>
      </div>
    </template>
  </section>
</template>
