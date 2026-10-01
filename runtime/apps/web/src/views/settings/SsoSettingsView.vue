<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file SsoSettingsView.vue
 * @description Réglages > SSO OIDC (owner, 13 § 7) : un fournisseur d'identité, comptes reconnus par (émetteur, sujet) et jamais par
 * e-mail, création à la volée désactivée par défaut, rôle selon les groupes (jamais `owner`), SSO exigé avec la connexion locale de
 * secours de l'owner. Le secret du client est en écriture seule : il n'est jamais relu ni affiché (INV8) ; le champ est vidé dès l'envoi.
 * @page
 */
import { onMounted, onServerPrefetch } from 'vue';
import { useI18n } from 'vue-i18n';
import TextField from '@/components/account/TextField.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useSsoSettings } from '@/composables/useInstanceSettings';
import { selectClass } from '@/lib/classes';

const { t } = useI18n();
const settings = useSsoSettings();
const { form, secretSet, configured, saving, saved, failure } = settings;

onMounted(() => void settings.load());
onServerPrefetch(() => settings.load());
</script>

<template>
  <section class="flex flex-col gap-6" aria-labelledby="sso-heading">
    <header class="flex flex-col gap-1">
      <h1 id="sso-heading" data-route-heading tabindex="-1" class="text-2xl font-semibold tracking-tight">{{ t('instance.sso.title') }}</h1>
      <p class="text-sm text-muted-foreground">{{ t('instance.sso.intro') }}</p>
    </header>

    <p v-if="settings.loading.value && !settings.data.value" role="status" class="text-sm text-muted-foreground">{{ t('ui.loading') }}</p>
    <Alert v-else-if="settings.failure.value" variant="destructive" data-testid="sso-load-error"><AlertDescription>{{ t(settings.failure.value) }}</AlertDescription></Alert>
    <form v-else class="flex flex-col gap-4 rounded-xl border p-4" novalidate data-testid="sso-form" @submit.prevent="settings.save()">
      <p v-if="!configured" class="text-sm text-muted-foreground">{{ t('instance.sso.notConfigured') }}</p>
      <Alert v-if="failure" variant="destructive" data-testid="sso-error"><AlertDescription>{{ t(failure) }}</AlertDescription></Alert>
      <p v-if="saved" role="status" class="text-sm">{{ t('common.saved') }}</p>

      <label class="flex min-h-8 items-center gap-3 text-sm">
        <input v-model="form.enabled" type="checkbox" class="size-5" name="enabled" />
        <span>{{ t('instance.sso.enabled') }}</span>
      </label>
      <TextField id="sso-label" v-model="form.label" :label="t('instance.sso.label')" name="label" class="max-w-md" autocomplete="off" maxlength="100" />
      <TextField id="sso-slug" v-model="form.slug" :label="t('instance.sso.slug')" :hint="t('instance.sso.slugHint')" name="slug" class="max-w-xs" autocomplete="off" required />
      <TextField id="sso-issuer" v-model="form.issuer" :label="t('instance.sso.issuer')" type="url" name="issuer" class="max-w-xl" autocomplete="off" required />
      <TextField id="sso-client-id" v-model="form.clientId" :label="t('instance.sso.clientId')" name="clientId" class="max-w-md" autocomplete="off" required />
      <TextField
        id="sso-client-secret"
        v-model="form.clientSecret"
        :label="t('instance.sso.clientSecret')"
        :hint="secretSet ? t('settings.secret.set') : t('settings.secret.unset')"
        type="password"
        name="clientSecret"
        class="max-w-md"
        autocomplete="new-password"
      />
      <label class="flex min-h-8 items-start gap-3 text-sm">
        <input v-model="form.required" type="checkbox" class="mt-0.5 size-5" name="required" />
        <span>{{ t('instance.sso.required') }}<span class="block text-xs text-muted-foreground">{{ t('instance.sso.requiredHint') }}</span></span>
      </label>
      <label class="flex min-h-8 items-start gap-3 text-sm">
        <input v-model="form.jit" type="checkbox" class="mt-0.5 size-5" name="jit" />
        <span>{{ t('instance.sso.jit') }}<span class="block text-xs text-muted-foreground">{{ t('instance.sso.jitHint') }}</span></span>
      </label>
      <div v-if="form.jit" class="flex flex-col gap-1">
        <Label for="sso-jit-domains">{{ t('instance.sso.jitDomains') }}</Label>
        <textarea
          id="sso-jit-domains"
          v-model="form.jitDomains"
          name="jitDomains"
          rows="3"
          class="border-input bg-background text-foreground max-w-md rounded-md border px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3"
        ></textarea>
      </div>

      <fieldset class="flex flex-col gap-2">
        <legend class="text-sm font-medium">{{ t('instance.sso.groups') }}</legend>
        <p class="text-xs text-muted-foreground">{{ t('instance.sso.groupsHint') }}</p>
        <div v-for="(entry, index) in form.groups" :key="index" class="flex flex-wrap items-end gap-3">
          <TextField :id="`sso-group-${index}`" v-model="entry.group" :label="t('instance.sso.group')" :name="`group-${index}`" class="w-56" autocomplete="off" />
          <div class="flex flex-col gap-1">
            <Label :for="`sso-role-${index}`">{{ t('instance.sso.role') }}</Label>
            <select :id="`sso-role-${index}`" v-model="entry.role" :class="selectClass">
              <option value="member">{{ t('users.roles.member') }}</option>
              <option value="admin">{{ t('users.roles.admin') }}</option>
            </select>
          </div>
          <Button type="button" variant="outline" size="sm" :aria-label="t('instance.sso.removeGroup', { group: entry.group || String(index + 1) })" @click="settings.removeGroup(index)">{{ t('common.remove') }}</Button>
        </div>
        <div><Button type="button" variant="outline" size="sm" @click="settings.addGroup()">{{ t('instance.sso.addGroup') }}</Button></div>
      </fieldset>

      <div><Button type="submit" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="saving">{{ saving ? t('common.saving') : t('instance.sso.save') }}</Button></div>
    </form>
  </section>
</template>
