<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ProfilesView.vue
 * @description Écran Profils (04d § 5.2, 04c § 2.2 et § 4, tâche 3.6) : profils persistants (nom, taille, version, verrou et
 * session porteuse, export `storageState` en fichier JSON), import d'un `storageState` dans un profil (409 `profile_locked`
 * si une session l'écrit), profils de proxy (utilisateur masqué, mot de passe jamais affiché) et leur test de connectivité
 * (IP de sortie et latence, ou `proxy_unreachable` annoncé dans la ligne).
 * @page
 */
import type { StorageState } from '@sym/contracts/browser';
import { reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import type { Profile } from '../api/types.js';
import ConsoleButton from '../components/ConsoleButton.vue';
import ErrorAlert from '../components/ErrorAlert.vue';
import SymMessage from '../components/SymMessage.vue';
import { useConsoleApi } from '../composables/console-api.js';
import { useLoad } from '../composables/load.js';
import { formatBytes, formatDate } from '../lib/format.js';

const { t, locale } = useI18n();
const api = useConsoleApi();
const profiles = useLoad(() => api.listProfiles());
const proxies = useLoad(() => api.listProxyProfiles());

const notice = ref('');
const exportError = ref<string | null>(null);

async function exportProfile(profile: Profile): Promise<void> {
  const result = await api.exportProfile(profile.id);
  if (!result.ok) {
    exportError.value = result.code;
    return;
  }
  exportError.value = null;
  // Fichier produit dans le navigateur : rien ne repart vers le serveur, rien n'est gardé après le téléchargement.
  const url = URL.createObjectURL(new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${profile.id}.storage-state.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

const importForm = reactive({ profileId: '', state: '' });
const importError = ref<string | null>(null);
const importBusy = ref(false);

function parseState(raw: string): StorageState | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return undefined;
    const candidate = value as Partial<StorageState>;
    return Array.isArray(candidate.cookies) && Array.isArray(candidate.origins) ? (candidate as StorageState) : undefined;
  } catch {
    return undefined;
  }
}

async function importState(): Promise<void> {
  if (importBusy.value) return;
  const state = parseState(importForm.state);
  if (!state) {
    importError.value = 'invalid_json';
    return;
  }
  const profileId = importForm.profileId || profiles.data.value?.data[0]?.id || '';
  importBusy.value = true;
  const result = await api.importProfile(profileId, state);
  importBusy.value = false;
  if (!result.ok) {
    importError.value = result.code;
    return;
  }
  importError.value = null;
  profiles.data.value = { data: (profiles.data.value?.data ?? []).map((p) => (p.id === result.data.id ? result.data : p)) };
  importForm.state = '';
  notice.value = t('console.profiles.import.done', { name: result.data.name, version: result.data.version });
}

/** Résultat du test de connectivité par profil de proxy. */
const tests = ref<Record<string, { ok: true; exitIp: string; latencyMs: number } | { ok: false; code: string }>>({});
const testing = ref<string | null>(null);
async function testProxy(id: string): Promise<void> {
  if (testing.value) return;
  testing.value = id;
  const result = await api.testProxyProfile(id);
  testing.value = null;
  tests.value = { ...tests.value, [id]: result.ok ? result.data : { ok: false, code: result.code } };
}
</script>

<template>
  <section class="mx-auto flex w-full max-w-6xl flex-col gap-6" aria-labelledby="profiles-title">
    <h1 id="profiles-title" data-route-heading tabindex="-1" class="text-4xl">{{ t('console.profiles.title') }}</h1>
    <p v-if="(profiles.loading.value && !profiles.data.value) || (proxies.loading.value && !proxies.data.value)" role="status">{{ t('console.common.loading') }}</p>
    <div v-else data-loaded class="flex flex-col gap-6">
      <p role="status" class="font-bold">{{ notice }}</p>
      <ErrorAlert v-if="profiles.error.value" :code="profiles.error.value" :retry="profiles.reload" />
      <div v-else-if="(profiles.data.value?.data.length ?? 0) === 0" class="rounded-xl border border-border bg-card p-6 text-card-foreground">
        <SymMessage :text="t('console.profiles.empty')" />
      </div>
      <template v-else>
        <div class="overflow-x-auto rounded-xl border border-border bg-card text-card-foreground">
          <table class="w-full text-left text-sm">
            <caption class="p-4 text-left font-bold">{{ t('console.profiles.table.caption') }}</caption>
            <thead class="border-b border-border">
              <tr>
                <th scope="col" class="px-4 py-2">{{ t('console.profiles.table.name') }}</th>
                <th scope="col" class="px-4 py-2">{{ t('console.profiles.table.size') }}</th>
                <th scope="col" class="px-4 py-2">{{ t('console.profiles.table.version') }}</th>
                <th scope="col" class="px-4 py-2">{{ t('console.profiles.table.lock') }}</th>
                <th scope="col" class="px-4 py-2">{{ t('console.profiles.table.updated') }}</th>
                <th scope="col" class="px-4 py-2">{{ t('console.profiles.table.actions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="profile in profiles.data.value?.data" :key="profile.id" :data-profile="profile.id" class="border-b border-border last:border-0">
                <th scope="row" class="px-4 py-2 font-bold">{{ profile.name }}</th>
                <td class="px-4 py-2 whitespace-nowrap">{{ formatBytes(profile.sizeBytes, locale) }}</td>
                <td class="px-4 py-2 font-mono">v{{ profile.version }}</td>
                <td class="px-4 py-2">
                  <template v-if="profile.lockedBySession">
                    {{ t('console.profiles.lockedBy') }}
                    <RouterLink :to="`/sessions/${encodeURIComponent(profile.lockedBySession)}`" class="inline-flex min-h-6 items-center font-mono font-bold text-primary underline underline-offset-4">{{ profile.lockedBySession }}</RouterLink>
                  </template>
                  <template v-else>{{ t('console.profiles.free') }}</template>
                </td>
                <td class="px-4 py-2 whitespace-nowrap">{{ formatDate(profile.updatedAt, locale) }}</td>
                <td class="px-4 py-2">
                  <ConsoleButton type="button" variant="outline" size="sm" :data-export="profile.id" @click="exportProfile(profile)">
                    {{ t('console.profiles.export') }}<span class="sr-only"> {{ profile.name }}</span>
                  </ConsoleButton>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <ErrorAlert v-if="exportError" :code="exportError" />

        <section class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground" aria-labelledby="import-title">
          <h2 id="import-title" class="text-2xl">{{ t('console.profiles.import.heading') }}</h2>
          <form class="flex flex-col gap-4" @submit.prevent="importState">
            <div class="flex flex-col gap-1">
              <label for="import-profile" class="text-sm font-bold">{{ t('console.profiles.import.profile') }}</label>
              <select id="import-profile" v-model="importForm.profileId" class="min-h-11 max-w-md rounded-md border border-input bg-background px-3">
                <option v-for="profile in profiles.data.value?.data ?? []" :key="profile.id" :value="profile.id">{{ profile.name }} ({{ profile.id }})</option>
              </select>
            </div>
            <div class="flex flex-col gap-1">
              <label for="import-state" class="text-sm font-bold">{{ t('console.profiles.import.state') }}</label>
              <textarea
                id="import-state"
                v-model="importForm.state"
                rows="5"
                spellcheck="false"
                aria-describedby="import-state-hint"
                class="rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
              ></textarea>
              <p id="import-state-hint" class="text-sm text-muted-foreground">{{ t('console.profiles.import.hint') }}</p>
            </div>
            <p v-if="importError === 'invalid_json'" role="alert" class="sym-error">{{ t('console.profiles.import.invalidJson') }}</p>
            <ErrorAlert v-else-if="importError" :code="importError" />
            <div>
              <ConsoleButton id="import-submit" type="submit" :busy="importBusy">{{ t('console.profiles.import.submit') }}</ConsoleButton>
            </div>
          </form>
        </section>
      </template>

      <section class="flex flex-col gap-3" aria-labelledby="proxies-title">
        <h2 id="proxies-title" class="text-2xl">{{ t('console.profiles.proxies.heading') }}</h2>
        <ErrorAlert v-if="proxies.error.value" :code="proxies.error.value" :retry="proxies.reload" />
        <div v-else-if="(proxies.data.value?.data.length ?? 0) === 0" class="rounded-xl border border-border bg-card p-6 text-card-foreground">
          <SymMessage :text="t('console.profiles.emptyProxies')" />
        </div>
        <div v-else class="overflow-x-auto rounded-xl border border-border bg-card text-card-foreground">
          <table class="w-full text-left text-sm">
            <caption class="p-4 text-left font-bold">{{ t('console.profiles.proxies.caption') }}</caption>
            <thead class="border-b border-border">
              <tr>
                <th scope="col" class="px-4 py-2">{{ t('console.profiles.proxies.name') }}</th>
                <th scope="col" class="px-4 py-2">{{ t('console.profiles.proxies.type') }}</th>
                <th scope="col" class="px-4 py-2">{{ t('console.profiles.proxies.address') }}</th>
                <th scope="col" class="px-4 py-2">{{ t('console.profiles.proxies.user') }}</th>
                <th scope="col" class="px-4 py-2">{{ t('console.profiles.proxies.test') }}</th>
                <th scope="col" class="px-4 py-2">{{ t('console.profiles.proxies.result') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="proxy in proxies.data.value?.data" :key="proxy.id" :data-proxy="proxy.id" class="border-b border-border last:border-0">
                <th scope="row" class="px-4 py-2 font-bold">{{ proxy.name }}</th>
                <td class="px-4 py-2 font-mono">{{ proxy.type }}</td>
                <td class="px-4 py-2 font-mono">{{ proxy.host }}:{{ proxy.port }}</td>
                <td class="px-4 py-2 font-mono">{{ proxy.username }}</td>
                <td class="px-4 py-2">
                  <ConsoleButton type="button" variant="outline" size="sm" :data-test-proxy="proxy.id" :busy="testing === proxy.id" @click="testProxy(proxy.id)">
                    {{ t('console.profiles.proxies.test') }}<span class="sr-only"> {{ proxy.name }}</span>
                  </ConsoleButton>
                </td>
                <td class="px-4 py-2" aria-live="polite">
                  <template v-if="tests[proxy.id]?.ok === true">
                    {{ t('console.profiles.proxies.exitIp', { ip: (tests[proxy.id] as { exitIp: string }).exitIp, latency: (tests[proxy.id] as { latencyMs: number }).latencyMs }) }}
                  </template>
                  <ErrorAlert v-else-if="tests[proxy.id]" :code="(tests[proxy.id] as { code: string }).code" />
                  <span v-else class="text-muted-foreground">{{ t('console.profiles.proxies.untested') }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </section>
</template>
