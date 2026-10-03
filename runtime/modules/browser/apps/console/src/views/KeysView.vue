<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file KeysView.vue
 * @description Écran Clés et quotas (04d § 5.2 et § 4.2, tâche 3.6) : clients et leurs quotas (sessions simultanées, minutes
 * et octets par mois, durée max), création d'une clé (client, nom, scopes, expiration) avec affichage UNIQUE de la clé
 * (panneau qui reçoit le focus, effacé de la page dès qu'il est fermé), liste des clés (préfixe seulement, scopes,
 * expiration, dernière utilisation, état) et révocation (`/v1/admin/keys`, `/v1/admin/tenants`).
 * @page
 */
import { computed, nextTick, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { API_KEY_SCOPES, type ApiKey, type ApiKeyScope } from '../api/types.js';
import ConsoleButton from '../components/ConsoleButton.vue';
import ErrorAlert from '../components/ErrorAlert.vue';
import SymMessage from '../components/SymMessage.vue';
import { useConsoleApi } from '../composables/console-api.js';
import { useLoad } from '../composables/load.js';
import { formatBytes, formatDate, formatDuration, formatNumber } from '../lib/format.js';

const { t, locale } = useI18n();
const api = useConsoleApi();
const tenants = useLoad(() => api.listTenants());
const keys = useLoad(() => api.listKeys());

const tenantName = computed(() => new Map((tenants.data.value?.data ?? []).map((tenant) => [tenant.id, tenant.name])));

const form = reactive({ tenantId: '', name: '', scopes: [] as ApiKeyScope[], expires: '' });
const creating = ref(false);
const createError = ref<string | null>(null);
/** Clé entière : gardée en mémoire le temps de l'affichage seulement, jamais stockée ni relue. */
const secret = ref<string | null>(null);
const notice = ref('');

async function create(): Promise<void> {
  if (creating.value) return;
  creating.value = true;
  const tenantId = form.tenantId || tenants.data.value?.data[0]?.id || '';
  const result = await api.createKey({
    tenantId,
    name: form.name.trim(),
    scopes: [...form.scopes],
    expiresAt: form.expires ? `${form.expires}T23:59:59.000Z` : null,
  });
  creating.value = false;
  if (!result.ok) {
    createError.value = result.code;
    return;
  }
  createError.value = null;
  secret.value = result.data.secret;
  keys.data.value = { data: [...(keys.data.value?.data ?? []), result.data.key] };
  Object.assign(form, { name: '', scopes: [], expires: '' });
  await nextTick();
  document.getElementById('key-secret-panel')?.focus();
}

async function dismissSecret(): Promise<void> {
  secret.value = null;
  await nextTick();
  document.getElementById('key-create')?.focus();
}

async function revoke(key: ApiKey): Promise<void> {
  const result = await api.revokeKey(key.id);
  if (!result.ok) {
    createError.value = result.code;
    return;
  }
  keys.data.value = { data: (keys.data.value?.data ?? []).map((k) => (k.id === key.id ? result.data : k)) };
  notice.value = t('console.keys.revokedDone', { name: key.name });
}
</script>

<template>
  <section class="mx-auto flex w-full max-w-6xl flex-col gap-6" aria-labelledby="keys-title">
    <h1 id="keys-title" data-route-heading tabindex="-1" class="text-4xl">{{ t('console.keys.title') }}</h1>
    <p v-if="(tenants.loading.value && !tenants.data.value) || (keys.loading.value && !keys.data.value)" role="status">{{ t('console.common.loading') }}</p>
    <div v-else data-loaded class="flex flex-col gap-6">
      <section class="flex flex-col gap-3" aria-labelledby="tenants-title">
        <h2 id="tenants-title" class="text-2xl">{{ t('console.keys.tenants.heading') }}</h2>
        <ErrorAlert v-if="tenants.error.value" :code="tenants.error.value" :retry="tenants.reload" />
        <ul v-else class="grid gap-4 md:grid-cols-2">
          <li v-for="tenant in tenants.data.value?.data" :key="tenant.id" class="rounded-xl border border-border bg-card p-4 text-card-foreground">
            <h3 class="text-xl">{{ tenant.name }}</h3>
            <p class="font-bold">{{ t('console.keys.tenants.quotas') }}</p>
            <dl class="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
              <dt>{{ t('console.keys.tenants.concurrent') }}</dt>
              <dd class="text-end">{{ formatNumber(tenant.quotas.concurrentSessions, locale) }}</dd>
              <dt>{{ t('console.keys.tenants.minutes') }}</dt>
              <dd class="text-end">{{ formatNumber(tenant.quotas.minutesPerMonth, locale) }}</dd>
              <dt>{{ t('console.keys.tenants.bytes') }}</dt>
              <dd class="text-end">{{ formatBytes(tenant.quotas.bytesPerMonth, locale) }}</dd>
              <dt>{{ t('console.keys.tenants.maxSession') }}</dt>
              <dd class="text-end">{{ formatDuration(tenant.quotas.maxSessionSeconds, locale) }}</dd>
            </dl>
          </li>
        </ul>
      </section>

      <section class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground" aria-labelledby="create-title">
        <h2 id="create-title" class="text-2xl">{{ t('console.keys.create.heading') }}</h2>
        <form class="grid gap-4 sm:grid-cols-2" @submit.prevent="create">
          <div class="flex flex-col gap-1">
            <label for="key-tenant" class="text-sm font-bold">{{ t('console.keys.create.tenant') }}</label>
            <select id="key-tenant" v-model="form.tenantId" class="min-h-11 rounded-md border border-input bg-background px-3">
              <option v-for="tenant in tenants.data.value?.data ?? []" :key="tenant.id" :value="tenant.id">{{ tenant.name }}</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <label for="key-name" class="text-sm font-bold">{{ t('console.keys.create.name') }}</label>
            <input id="key-name" v-model="form.name" type="text" required maxlength="64" autocomplete="off" class="min-h-11 rounded-md border border-input bg-background px-3" />
          </div>
          <fieldset class="flex flex-col gap-2 sm:col-span-2">
            <legend class="mb-1 text-sm font-bold">{{ t('console.keys.create.scopes') }}</legend>
            <div class="flex flex-wrap gap-x-5 gap-y-2">
              <label v-for="scope in API_KEY_SCOPES" :key="scope" class="inline-flex min-h-6 items-center gap-2 font-mono">
                <input v-model="form.scopes" type="checkbox" name="key-scopes" :value="scope" class="size-5" />
                {{ scope }}
              </label>
            </div>
          </fieldset>
          <div class="flex flex-col gap-1">
            <label for="key-expires" class="text-sm font-bold">{{ t('console.keys.create.expires') }}</label>
            <input id="key-expires" v-model="form.expires" type="date" class="min-h-11 rounded-md border border-input bg-background px-3" />
          </div>
          <div class="flex items-end">
            <ConsoleButton id="key-create" type="submit" :busy="creating">{{ t('console.keys.create.submit') }}</ConsoleButton>
          </div>
        </form>
        <ErrorAlert v-if="createError" :code="createError" />
        <div
          v-if="secret"
          id="key-secret-panel"
          tabindex="-1"
          role="region"
          aria-labelledby="key-secret-title"
          class="flex flex-col gap-2 rounded-lg border-2 border-primary bg-background p-4 text-foreground"
        >
          <h3 id="key-secret-title" class="text-xl">{{ t('console.keys.create.secretHeading') }}</h3>
          <p class="font-bold">{{ t('console.keys.create.secretWarning') }}</p>
          <code id="key-secret" class="font-mono text-base break-all select-all">{{ secret }}</code>
          <div>
            <ConsoleButton id="key-secret-done" type="button" variant="outline" @click="dismissSecret">{{ t('console.keys.create.done') }}</ConsoleButton>
          </div>
        </div>
      </section>

      <p role="status" class="font-bold">{{ notice }}</p>
      <ErrorAlert v-if="keys.error.value" :code="keys.error.value" :retry="keys.reload" />
      <div v-else-if="(keys.data.value?.data.length ?? 0) === 0" class="rounded-xl border border-border bg-card p-6 text-card-foreground">
        <SymMessage :text="t('console.keys.empty')" />
      </div>
      <div v-else class="overflow-x-auto rounded-xl border border-border bg-card text-card-foreground">
        <table class="w-full text-left text-sm">
          <caption class="p-4 text-left font-bold">{{ t('console.keys.table.caption') }}</caption>
          <thead class="border-b border-border">
            <tr>
              <th scope="col" class="px-4 py-2">{{ t('console.keys.table.name') }}</th>
              <th scope="col" class="px-4 py-2">{{ t('console.keys.table.client') }}</th>
              <th scope="col" class="px-4 py-2">{{ t('console.keys.table.prefix') }}</th>
              <th scope="col" class="px-4 py-2">{{ t('console.keys.table.scopes') }}</th>
              <th scope="col" class="px-4 py-2">{{ t('console.keys.table.expires') }}</th>
              <th scope="col" class="px-4 py-2">{{ t('console.keys.table.lastUsed') }}</th>
              <th scope="col" class="px-4 py-2">{{ t('console.keys.table.state') }}</th>
              <th scope="col" class="px-4 py-2">{{ t('console.keys.table.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in keys.data.value?.data" :key="key.id" class="border-b border-border last:border-0">
              <th scope="row" class="px-4 py-2 font-bold">{{ key.name }}</th>
              <td class="px-4 py-2">{{ tenantName.get(key.tenantId) ?? key.tenantId }}</td>
              <td class="px-4 py-2 font-mono">{{ key.prefix }}</td>
              <td class="px-4 py-2 font-mono">{{ key.scopes.join(', ') }}</td>
              <td class="px-4 py-2 whitespace-nowrap">{{ key.expiresAt ? formatDate(key.expiresAt, locale) : t('console.keys.noExpiry') }}</td>
              <td class="px-4 py-2 whitespace-nowrap">{{ key.lastUsedAt ? formatDate(key.lastUsedAt, locale) : t('console.keys.never') }}</td>
              <td class="px-4 py-2">{{ key.revokedAt ? t('console.keys.revoked') : t('console.keys.active') }}</td>
              <td class="px-4 py-2">
                <ConsoleButton v-if="!key.revokedAt" type="button" variant="outline" size="sm" :data-revoke="key.id" @click="revoke(key)">
                  {{ t('console.keys.revoke') }}<span class="sr-only"> {{ key.name }}</span>
                </ConsoleButton>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
