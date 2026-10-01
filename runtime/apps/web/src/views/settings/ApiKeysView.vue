<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ApiKeysView.vue
 * @description Réglages > Clés d'API (06 § 2, 13 § 8) : créer une clé à scopes et à expiration (mot de passe actuel exigé), la voir UNE
 * fois, lister les siennes sans aucun secret, révoquer. Une clé porte l'identité de son propriétaire : l'admin ne crée pas de clé
 * pour quelqu'un d'autre et ne lit pas celles d'autrui. Les scopes limitent les actions, le propriétaire limite les données.
 * @page
 */
import { onMounted, onServerPrefetch, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import TextField from '@/components/account/TextField.vue';
import SecretReveal from '@/components/account/SecretReveal.vue';
import ConfirmPanel from '@/components/api/ConfirmPanel.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { API_KEY_SCOPES, DEFAULT_KEY_DAYS, keyState, useApiKeys, type ApiKey, type ApiKeyScope } from '@/composables/useApiKeys';
import { readFieldValue, takeFieldValue } from '@/lib/form-field';
import { formatDateTime } from '@/lib/format';

const { t, locale } = useI18n();
const keys = useApiKeys();
const { busy, failure, created } = keys;

onMounted(() => void keys.reload());
onServerPrefetch(() => keys.reload().then(() => undefined));

const label = ref('');
const days = ref(String(DEFAULT_KEY_DAYS));
const password = ref('');
const scopes = reactive<Record<ApiKeyScope, boolean>>(Object.fromEntries(API_KEY_SCOPES.map((scope) => [scope, false])) as Record<ApiKeyScope, boolean>);
/** Erreur de saisie locale (libellé ou portée manquants) : aucun appel, le serveur répondrait 400. */
const localError = ref<string | null>(null);
const toRevoke = ref<ApiKey | null>(null);

const date = (iso: string | null | undefined): string => formatDateTime(iso, locale.value) ?? t('keys.neverUsed');

async function submit(event: Event): Promise<void> {
  const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : null;
  localError.value = null;
  const chosen = API_KEY_SCOPES.filter((scope) => scopes[scope]);
  const name = readFieldValue(form, 'label', label.value).trim();
  if (name === '') {
    localError.value = t('keys.labelRequired');
    return;
  }
  if (chosen.length === 0) {
    localError.value = t('keys.scopesRequired');
    return;
  }
  const lifetime = Number.parseInt(readFieldValue(form, 'days', days.value), 10);
  const ok = await keys.create({
    label: name,
    scopes: chosen,
    expiresInDays: Number.isFinite(lifetime) ? lifetime : null,
    currentPassword: takeFieldValue(form, 'currentPassword', password),
  });
  if (ok) {
    label.value = '';
    for (const scope of API_KEY_SCOPES) scopes[scope] = false;
  }
}

async function confirmRevoke(): Promise<void> {
  const key = toRevoke.value;
  toRevoke.value = null;
  if (key) await keys.revoke(key.id);
}
</script>

<template>
  <section class="flex flex-col gap-6" aria-labelledby="keys-heading">
    <header class="flex flex-col gap-1">
      <h1 id="keys-heading" data-route-heading tabindex="-1" class="text-2xl font-semibold tracking-tight">{{ t('keys.title') }}</h1>
      <p class="text-sm text-muted-foreground">{{ t('keys.intro') }}</p>
    </header>

    <SecretReveal
      v-if="created"
      :title="t('keys.created.title')"
      :text="t('keys.created.text')"
      :label="`${t('keys.created.key')} · ${created.label}`"
      :value="created.key"
      :dismiss-label="t('keys.created.dismiss')"
      @dismiss="keys.dismissCreated()"
    />

    <form class="flex flex-col gap-3 rounded-xl border p-4" novalidate data-testid="key-form" @submit.prevent="submit">
      <h2 class="text-lg font-semibold">{{ t('keys.createTitle') }}</h2>
      <Alert v-if="localError || failure" variant="destructive" data-testid="key-error"><AlertDescription>{{ localError ?? t(failure ?? 'errors.generic') }}</AlertDescription></Alert>
      <TextField id="key-label" v-model="label" :label="t('keys.label')" :hint="t('keys.labelHint')" name="label" class="max-w-md" autocomplete="off" maxlength="100" required />
      <fieldset class="flex flex-col gap-2">
        <legend class="text-sm font-medium">{{ t('keys.scopes') }}</legend>
        <p class="text-xs text-muted-foreground">{{ t('keys.scopesHint') }}</p>
        <label v-for="scope in API_KEY_SCOPES" :key="scope" class="flex min-h-8 items-center gap-3 text-sm">
          <input v-model="scopes[scope]" type="checkbox" class="size-5" :data-testid="`scope-${scope}`" />
          <span>{{ t(`keys.scope.${scope}`) }} <code class="text-xs text-muted-foreground">{{ scope }}</code></span>
        </label>
      </fieldset>
      <TextField id="key-days" v-model="days" :label="t('keys.expiresIn')" :hint="t('keys.expiresHint')" name="days" class="max-w-40" type="number" min="1" inputmode="numeric" />
      <TextField id="key-password" v-model="password" :label="t('keys.password')" :hint="t('keys.passwordHint')" type="password" name="currentPassword" class="max-w-xs" autocomplete="current-password" />
      <div><Button type="submit" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="busy">{{ busy ? t('keys.submitting') : t('keys.submit') }}</Button></div>
    </form>

    <div class="flex flex-col gap-2">
      <h2 class="text-lg font-semibold">{{ t('keys.list') }}</h2>
      <ConfirmPanel
        v-if="toRevoke"
        id="revoke-key"
        :title="t('keys.revokeTitle')"
        :consequence="t('keys.revokeConsequence', { label: toRevoke.label })"
        :confirm-label="t('keys.revoke')"
        @confirm="confirmRevoke()"
        @cancel="toRevoke = null"
      />
      <p v-if="keys.loading.value && !keys.data.value" role="status" class="text-sm text-muted-foreground">{{ t('ui.loading') }}</p>
      <p v-else-if="keys.failure.value" class="text-sm text-destructive">{{ t(keys.failure.value) }}</p>
      <p v-else-if="keys.keys.value.length === 0" class="text-sm text-muted-foreground" data-testid="keys-empty">{{ t('keys.empty') }}</p>
      <div v-else class="relative overflow-x-auto rounded-xl border">
        <table class="w-full text-left text-sm" data-testid="keys-table">
          <caption class="sr-only">{{ t('keys.caption') }}</caption>
          <thead class="border-b bg-muted/50">
            <tr>
              <th scope="col" class="p-3 font-medium">{{ t('keys.columns.label') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('keys.columns.prefix') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('keys.columns.scopes') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('keys.columns.expires') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('keys.columns.lastUsed') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('keys.columns.status') }}</th>
              <th scope="col" class="p-3 font-medium"><span class="sr-only">{{ t('keys.revoke') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in keys.keys.value" :key="key.id" class="border-b last:border-0" data-testid="key-row">
              <th scope="row" class="p-3 font-medium">{{ key.label }}</th>
              <td class="p-3 font-mono text-xs">{{ key.prefix }}…</td>
              <td class="p-3 text-xs">{{ key.scopes.join(', ') }}</td>
              <td class="p-3">{{ date(key.expiresAt) }}</td>
              <td class="p-3">{{ key.lastUsedAt ? date(key.lastUsedAt) : t('keys.neverUsed') }}</td>
              <td class="p-3">{{ t(`keys.status.${keyState(key)}`) }}</td>
              <td class="p-3"><Button v-if="!key.revokedAt" type="button" variant="outline" size="sm" @click="toRevoke = key">{{ t('keys.revoke') }}</Button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
