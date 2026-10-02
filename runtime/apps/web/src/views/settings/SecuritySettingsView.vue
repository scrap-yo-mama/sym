<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file SecuritySettingsView.vue
 * @description Réglages > Sécurité de l'instance (owner, 13 § 5, § 13.1) : durée d'inactivité et durée maximale d'une session, domaines
 * d'e-mail autorisés, durée de vie maximale d'une clé d'API, conservation de l'audit. Réservé à l'owner : la route redirige sinon
 * (`can('settings:security:write')`), et le serveur refuse (403) de toute façon.
 * @page
 */
import { onMounted, onServerPrefetch } from 'vue';
import { useI18n } from 'vue-i18n';
import TextField from '@/components/account/TextField.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useSecuritySettings } from '@/composables/useInstanceSettings';

const { t } = useI18n();
const settings = useSecuritySettings();
const { form, saving, saved, failure } = settings;

onMounted(() => void settings.load());
onServerPrefetch(() => settings.load());
</script>

<template>
  <section class="flex flex-col gap-6" aria-labelledby="security-heading">
    <header class="flex flex-col gap-1">
      <h1 id="security-heading" data-route-heading tabindex="-1" class="sym-title">{{ t('instance.security.title') }}</h1>
      <p class="text-sm text-muted-foreground">{{ t('instance.security.intro') }}</p>
    </header>

    <p v-if="settings.loading.value && !settings.data.value" role="status" class="text-sm text-muted-foreground">{{ t('ui.loading') }}</p>
    <Alert v-else-if="settings.failure.value" variant="destructive" data-testid="security-load-error"><AlertDescription>{{ t(settings.failure.value) }}</AlertDescription></Alert>
    <form v-else class="flex flex-col gap-4 rounded-xl border bg-card p-4" novalidate data-testid="security-form" @submit.prevent="settings.save()">
      <Alert v-if="failure" variant="destructive" data-testid="security-error"><AlertDescription>{{ t(failure) }}</AlertDescription></Alert>
      <p v-if="saved" role="status" class="text-sm">{{ t('common.saved') }}</p>
      <TextField id="security-idle" v-model="form.idle" :label="t('instance.security.idle')" type="number" min="5" max="720" name="idle" class="max-w-40" inputmode="numeric" required />
      <TextField id="security-absolute" v-model="form.absolute" :label="t('instance.security.absolute')" type="number" min="1" max="720" name="absolute" class="max-w-40" inputmode="numeric" required />
      <TextField id="security-key-max" v-model="form.keyMax" :label="t('instance.security.keyMax')" type="number" min="1" max="365" name="keyMax" class="max-w-40" inputmode="numeric" required />
      <TextField id="security-retention" v-model="form.retention" :label="t('instance.security.retention')" type="number" min="1" max="120" name="retention" class="max-w-40" inputmode="numeric" />
      <div class="flex flex-col gap-1">
        <Label for="security-domains">{{ t('instance.security.domains') }}</Label>
        <textarea
          id="security-domains"
          v-model="form.domains"
          name="domains"
          rows="4"
          class="border-input bg-background text-foreground max-w-md rounded-md border px-3 py-2 text-sm outline-none focus-visible:border-ring"
          aria-describedby="security-domains-hint"
        ></textarea>
        <p id="security-domains-hint" class="text-xs text-muted-foreground">{{ t('instance.security.domainsHint') }}</p>
      </div>
      <div><Button type="submit" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="saving">{{ saving ? t('common.saving') : t('instance.security.save') }}</Button></div>
    </form>
  </section>
</template>
