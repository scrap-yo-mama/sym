<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ProxiesSettingsView.vue
 * @description Réglages > Proxys (06 § 2, 08 § 2), admin seul : type, adresse, identifiants (écriture seule), prix, bouton
 * **Tester** (IP et pays de sortie). Le résidentiel est en opt-in par API et n'est jamais utilisé après un refus.
 * @page
 */
import { computed, onMounted, onServerPrefetch, reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import TestOutcome from '@/components/settings/TestOutcome.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useProxies, type ProxyWrite } from '@/composables/useSettings';
import { selectClass } from '@/lib/classes';

const { t } = useI18n();
const proxies = useProxies();
const { data, loading, failure, forbidden, failureAction, busy, outcomes } = proxies;

onMounted(() => void proxies.reload());
onServerPrefetch(() => proxies.reload());

const draft = reactive({ label: '', type: 'dc' as 'dc' | 'res', url: '', username: '', password: '' });
const list = computed(() => data.value?.proxies ?? []);

async function add(): Promise<void> {
  const body: ProxyWrite = { label: draft.label.trim(), type: draft.type, url: draft.url.trim() };
  if (draft.username !== '') body.username = draft.username;
  if (draft.password !== '') body.password = draft.password;
  const username = draft.username;
  draft.username = '';
  draft.password = ''; // les identifiants quittent l'écran dès l'envoi (écriture seule)
  if (await proxies.create(body)) {
    draft.label = '';
    draft.url = '';
  } else {
    draft.username = username;
  }
}
</script>

<template>
  <section class="flex flex-col gap-5" aria-labelledby="proxies-heading">
    <header class="flex flex-col gap-1">
      <h1 id="proxies-heading" data-route-heading tabindex="-1" class="text-2xl font-semibold tracking-tight">{{ t('settings.proxies.title') }}</h1>
      <p class="text-sm text-muted-foreground">{{ t('settings.proxies.intro') }}</p>
      <p class="text-sm text-muted-foreground">{{ t('settings.proxies.residential') }}</p>
    </header>

    <p v-if="loading && !data" role="status" class="text-sm text-muted-foreground">{{ t('common.loading') }}</p>
    <Alert v-else-if="forbidden" data-testid="settings-forbidden"><AlertDescription>{{ t('settings.adminOnly') }}</AlertDescription></Alert>
    <Alert v-else-if="failure" variant="destructive">
      <AlertDescription class="flex flex-wrap items-center gap-3">
        {{ t(failure) }}
        <Button type="button" variant="outline" size="sm" @click="proxies.reload()">{{ t('common.retry') }}</Button>
      </AlertDescription>
    </Alert>

    <template v-else>
      <Alert v-if="failureAction" variant="destructive"><AlertDescription>{{ t(failureAction) }}</AlertDescription></Alert>
      <p v-if="list.length === 0" class="text-sm text-muted-foreground" data-testid="proxies-empty">{{ t('settings.proxies.empty') }}</p>
      <div v-else class="overflow-x-auto rounded-xl border">
        <table class="w-full text-left text-sm">
          <caption class="sr-only">{{ t('settings.proxies.title') }}</caption>
          <thead class="border-b bg-muted/50">
            <tr>
              <th scope="col" class="p-3 font-medium">{{ t('settings.proxies.label') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('settings.proxies.type') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('settings.proxies.url') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('settings.proxies.credentials') }}</th>
              <th scope="col" class="p-3 font-medium"><span class="sr-only">{{ t('settings.test') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="proxy in list" :key="proxy.id" class="border-b align-top last:border-0" data-testid="proxy-row">
              <th scope="row" class="p-3 font-medium">{{ proxy.label }}</th>
              <td class="p-3">{{ proxy.type === 'res' ? t('settings.proxies.typeRes') : t('settings.proxies.typeDc') }}</td>
              <td class="p-3 break-all">{{ proxy.url }}</td>
              <td class="p-3">{{ proxy.username_set || proxy.password_set ? t('settings.proxies.credentialsSet') : t('settings.proxies.credentialsNone') }}</td>
              <td class="flex flex-col gap-1 p-3">
                <div class="flex gap-2">
                  <Button type="button" variant="outline" size="sm" :disabled="outcomes[proxy.id]?.state === 'running'" @click="proxies.test(proxy.id)">{{ t('settings.test') }}</Button>
                  <Button type="button" variant="outline" size="sm" @click="proxies.remove(proxy.id)">{{ t('settings.proxies.remove') }}</Button>
                </div>
                <TestOutcome :outcome="outcomes[proxy.id]" :tested-at="proxy.tested_at" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <form class="flex flex-col gap-3 rounded-xl border p-4" novalidate data-testid="proxy-form" @submit.prevent="add">
        <h2 class="text-lg font-semibold">{{ t('settings.proxies.add') }}</h2>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="flex flex-col gap-1">
            <Label for="proxy-label">{{ t('settings.proxies.label') }}</Label>
            <Input id="proxy-label" autocomplete="off" :model-value="draft.label" @update:model-value="(value: string | number) => (draft.label = String(value))" />
          </div>
          <div class="flex flex-col gap-1">
            <Label for="proxy-type">{{ t('settings.proxies.type') }}</Label>
            <select id="proxy-type" v-model="draft.type" :class="selectClass">
              <option value="dc">{{ t('settings.proxies.typeDc') }}</option>
              <option value="res">{{ t('settings.proxies.typeRes') }}</option>
            </select>
          </div>
          <div class="flex flex-col gap-1 sm:col-span-2">
            <Label for="proxy-url">{{ t('settings.proxies.url') }}</Label>
            <Input id="proxy-url" type="url" autocomplete="off" :model-value="draft.url" @update:model-value="(value: string | number) => (draft.url = String(value))" />
          </div>
          <div class="flex flex-col gap-1">
            <Label for="proxy-username">{{ t('settings.proxies.username') }}</Label>
            <Input id="proxy-username" autocomplete="off" :model-value="draft.username" @update:model-value="(value: string | number) => (draft.username = String(value))" />
          </div>
          <div class="flex flex-col gap-1">
            <Label for="proxy-password">{{ t('settings.proxies.password') }}</Label>
            <Input id="proxy-password" type="password" autocomplete="new-password" :model-value="draft.password" @update:model-value="(value: string | number) => (draft.password = String(value))" />
          </div>
        </div>
        <div>
          <Button type="submit" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="busy">{{ t('settings.proxies.add') }}</Button>
        </div>
      </form>
    </template>
  </section>
</template>
