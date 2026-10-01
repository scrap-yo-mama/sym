<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ExtensionSettingsView.vue
 * @description Réglages > Extension et sessions (06 § 2, 07) : code d'appairage (mot de passe actuel exigé, usage unique,
 * 10 minutes), appareils appairés, domaines connectés, révocation. Le code n'apparaît qu'une fois ; aucun cookie n'est
 * jamais affiché.
 * @page
 */
import { onMounted, onServerPrefetch, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useExtensionSettings } from '@/composables/useSettings';
import { formatDateTime } from '@/lib/format';

const { t, locale } = useI18n();
const extension = useExtensionSettings();
const { devices, sites, failure, pairing, pairingBusy } = extension;

onMounted(() => {
  void extension.devices.reload();
  void extension.sites.reload();
});
onServerPrefetch(async () => {
  await Promise.all([extension.devices.reload(), extension.sites.reload()]);
});

const password = ref('');
const date = (iso: string | null): string => formatDateTime(iso, locale.value) ?? t('settings.extension.never');

async function createCode(): Promise<void> {
  const value = password.value;
  password.value = ''; // le mot de passe ne reste pas dans le champ après l'envoi
  await extension.createPairingCode(value);
}
</script>

<template>
  <section class="flex flex-col gap-6" aria-labelledby="extension-heading">
    <header class="flex flex-col gap-1">
      <h1 id="extension-heading" data-route-heading tabindex="-1" class="text-2xl font-semibold tracking-tight">{{ t('settings.extension.title') }}</h1>
      <p class="text-sm text-muted-foreground">{{ t('settings.extension.intro') }}</p>
    </header>

    <Alert v-if="failure" variant="destructive" data-testid="extension-failure"><AlertDescription>{{ t(failure) }}</AlertDescription></Alert>

    <form class="flex flex-col gap-3 rounded-xl border p-4" novalidate data-testid="pairing-form" @submit.prevent="createCode">
      <h2 class="text-lg font-semibold">{{ t('settings.extension.pairing') }}</h2>
      <p class="text-sm text-muted-foreground">{{ t('settings.extension.pairingHelp') }}</p>
      <div class="flex flex-col gap-1">
        <Label for="pairing-password">{{ t('settings.extension.currentPassword') }}</Label>
        <Input id="pairing-password" type="password" class="max-w-xs" autocomplete="current-password" :model-value="password" @update:model-value="(value: string | number) => (password = String(value))" />
      </div>
      <div>
        <Button type="submit" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="pairingBusy">{{ t('settings.extension.createCode') }}</Button>
      </div>
      <div v-if="pairing" class="flex flex-col gap-2 rounded-lg border-2 p-3" role="status" data-testid="pairing-code">
        <p class="font-mono text-lg">{{ t('settings.extension.code', { code: pairing.code }) }}</p>
        <p class="text-sm text-muted-foreground">{{ t('settings.extension.codeExpires', { date: date(pairing.expiresAt) }) }}</p>
        <div><Button type="button" variant="outline" size="sm" @click="extension.dismissPairing()">{{ t('settings.extension.dismissCode') }}</Button></div>
      </div>
    </form>

    <div class="flex flex-col gap-2">
      <h2 class="text-lg font-semibold">{{ t('settings.extension.devices') }}</h2>
      <p v-if="devices.loading.value && !devices.data.value" role="status" class="text-sm text-muted-foreground">{{ t('common.loading') }}</p>
      <p v-else-if="devices.failure.value" class="text-sm text-destructive">{{ t(devices.failure.value) }}</p>
      <p v-else-if="(devices.data.value?.items ?? []).length === 0" class="text-sm text-muted-foreground" data-testid="devices-empty">{{ t('settings.extension.devicesEmpty') }}</p>
      <div v-else class="relative overflow-x-auto rounded-xl border">
        <table class="w-full text-left text-sm">
          <caption class="sr-only">{{ t('settings.extension.devices') }}</caption>
          <thead class="border-b bg-muted/50">
            <tr>
              <th scope="col" class="p-3 font-medium">{{ t('settings.extension.device') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('settings.extension.lastSeen') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('settings.extension.expires') }}</th>
              <th scope="col" class="p-3 font-medium"><span class="sr-only">{{ t('settings.extension.revoke') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="device in devices.data.value?.items ?? []" :key="device.id" class="border-b last:border-0" data-testid="device-row">
              <th scope="row" class="p-3 font-medium">{{ device.deviceLabel ?? t('settings.extension.deviceUnnamed') }}</th>
              <td class="p-3">{{ date(device.lastSeenAt) }}</td>
              <td class="p-3">{{ date(device.expiresAt) }}</td>
              <td class="p-3">
                <span v-if="device.revokedAt" class="text-muted-foreground">{{ t('settings.extension.revoked') }}</span>
                <Button v-else type="button" variant="outline" size="sm" @click="extension.revokeDevice(device.id)">{{ t('settings.extension.revoke') }}</Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="flex flex-col gap-2">
      <h2 class="text-lg font-semibold">{{ t('settings.extension.sites') }}</h2>
      <p v-if="sites.loading.value && !sites.data.value" role="status" class="text-sm text-muted-foreground">{{ t('common.loading') }}</p>
      <p v-else-if="sites.failure.value" class="text-sm text-destructive">{{ t(sites.failure.value) }}</p>
      <p v-else-if="(sites.data.value?.items ?? []).length === 0" class="text-sm text-muted-foreground" data-testid="sites-empty">{{ t('settings.extension.sitesEmpty') }}</p>
      <div v-else class="relative overflow-x-auto rounded-xl border">
        <table class="w-full text-left text-sm">
          <caption class="sr-only">{{ t('settings.extension.sites') }}</caption>
          <thead class="border-b bg-muted/50">
            <tr>
              <th scope="col" class="p-3 font-medium">{{ t('settings.extension.domain') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('settings.extension.mode') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('settings.extension.captured') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('settings.extension.expires') }}</th>
              <th scope="col" class="p-3 font-medium"><span class="sr-only">{{ t('settings.extension.disconnect') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="site in sites.data.value?.items ?? []" :key="site.id" class="border-b last:border-0" data-testid="site-row">
              <th scope="row" class="p-3 font-medium">{{ site.domain }}</th>
              <td class="p-3">{{ site.serverUseAllowed ? t('settings.extension.modeServer') : t('settings.extension.modeBrowser') }}</td>
              <td class="p-3">{{ date(site.capturedAt) }}</td>
              <td class="p-3">{{ date(site.expiresAt) }}</td>
              <td class="p-3"><Button type="button" variant="outline" size="sm" @click="extension.disconnectSite(site.id)">{{ t('settings.extension.disconnect') }}</Button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
