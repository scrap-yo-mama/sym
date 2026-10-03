<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ModelsSettingsView.vue
 * @description Réglages > Modèles IA (06 § 2, 08 § 7) : fournisseurs (URL de base, clé), modèle par rôle, bouton **Tester**
 * avec échec lisible. La clé est en écriture seule : jamais relue, jamais affichée, champ vidé dès l'envoi (INV8,
 * `assert_secret_masked`). Aucun repli automatique de modèle.
 * @page
 */
import { onMounted, onServerPrefetch } from 'vue';
import { useI18n } from 'vue-i18n';
import TestOutcome from '@/components/settings/TestOutcome.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LLM_PRESETS, LLM_ROLES, useLlmSettings, type LlmPreset } from '@/composables/useSettings';
import { selectClass } from '@/lib/classes';
import { modelValidation } from '@/lib/model-validation';

const { t } = useI18n();
const settings = useLlmSettings();
const { providers, roles, validatedModels, saving, saveFailure, saved, outcomes, loading, failure, forbidden } = settings;

onMounted(() => void settings.load());
onServerPrefetch(() => settings.load());

/** Libellé du statut du banc pour le modèle saisi (lecture seule). */
function validationLabel(model: string): string {
  const validation = modelValidation(validatedModels.value, model.trim());
  return validation.status === 'validated' ? t('settings.models.validation.validated', { date: validation.date }) : t('settings.models.validation.notValidated');
}

function setRole(name: (typeof LLM_ROLES)[number], field: 'provider' | 'model', value: string): void {
  const current = roles[name] ?? { provider: '', model: '' };
  roles[name] = { ...current, [field]: value };
}
</script>

<template>
  <section class="flex flex-col gap-5" aria-labelledby="models-heading">
    <header class="flex flex-col gap-1">
      <h1 id="models-heading" data-route-heading tabindex="-1" class="sym-title">{{ t('settings.models.title') }}</h1>
      <p class="text-sm text-muted-foreground">{{ t('settings.models.intro') }}</p>
    </header>

    <p v-if="loading && providers.length === 0" role="status" class="text-sm text-muted-foreground">{{ t('common.loading') }}</p>
    <Alert v-else-if="forbidden" data-testid="settings-forbidden"><AlertDescription>{{ t('settings.adminOnly') }}</AlertDescription></Alert>
    <Alert v-else-if="failure" variant="destructive">
      <AlertDescription class="flex flex-wrap items-center gap-3">
        {{ t(failure) }}
        <Button type="button" variant="outline" size="sm" @click="settings.load()">{{ t('common.retry') }}</Button>
      </AlertDescription>
    </Alert>

    <form v-else class="flex flex-col gap-6" novalidate data-testid="models-form" @submit.prevent="settings.save()">
      <div class="flex flex-col gap-3">
        <h2 class="text-lg font-semibold">{{ t('settings.models.providers') }}</h2>
        <p v-if="providers.length === 0" class="text-sm text-muted-foreground">{{ t('settings.models.noProvider') }}</p>
        <fieldset v-for="(provider, at) in providers" :key="at" class="flex flex-col gap-3 rounded-lg border p-3" data-testid="provider">
          <legend class="px-1 text-sm font-medium">{{ t('settings.models.provider', { n: at + 1 }) }}</legend>
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="flex flex-col gap-1">
              <Label :for="`provider-id-${at}`">{{ t('settings.models.id') }}</Label>
              <Input :id="`provider-id-${at}`" autocomplete="off" :model-value="provider.id" @update:model-value="(value: string | number) => (provider.id = String(value))" />
            </div>
            <div class="flex flex-col gap-1">
              <Label :for="`provider-preset-${at}`">{{ t('settings.models.preset') }}</Label>
              <select :id="`provider-preset-${at}`" v-model="provider.preset" :class="selectClass">
                <option v-for="preset in LLM_PRESETS" :key="preset" :value="preset as LlmPreset">{{ t(`settings.models.presets.${preset}`) }}</option>
              </select>
            </div>
            <div class="flex flex-col gap-1 sm:col-span-2">
              <Label :for="`provider-url-${at}`">{{ t('settings.models.baseUrl') }}</Label>
              <Input :id="`provider-url-${at}`" type="url" autocomplete="off" :model-value="provider.base_url" @update:model-value="(value: string | number) => (provider.base_url = String(value))" />
            </div>
            <div class="flex flex-col gap-1 sm:col-span-2">
              <Label :for="`provider-key-${at}`">{{ t('settings.models.apiKey') }}</Label>
              <!-- Écriture seule : le champ ne reçoit jamais la clé enregistrée ; vide, la clé existante est conservée -->
              <Input
                :id="`provider-key-${at}`"
                type="password"
                autocomplete="new-password"
                :aria-describedby="`provider-key-hint-${at}`"
                :model-value="provider.newApiKey"
                @update:model-value="(value: string | number) => (provider.newApiKey = String(value))"
              />
              <p :id="`provider-key-hint-${at}`" class="text-sm text-muted-foreground" data-testid="secret-hint">
                {{ provider.apiKeyUnreadable ? t('settings.secret.unreadable') : provider.apiKeySet ? t('settings.secret.set') : t('settings.secret.unset') }}
              </p>
            </div>
          </div>
          <div>
            <Button type="button" variant="outline" size="sm" @click="settings.removeProvider(at)">{{ t('settings.models.removeProvider') }}</Button>
          </div>
        </fieldset>
        <div>
          <Button type="button" variant="outline" @click="settings.addProvider()">{{ t('settings.models.addProvider') }}</Button>
        </div>
      </div>

      <div class="flex flex-col gap-3">
        <h2 class="text-lg font-semibold">{{ t('settings.models.roles') }}</h2>
        <p class="text-sm text-muted-foreground">{{ t('settings.models.rolesIntro') }}</p>
        <div v-for="role in LLM_ROLES" :key="role" class="grid items-end gap-3 rounded-lg border p-3 sm:grid-cols-[8rem_1fr_1fr_auto]" data-testid="role-row">
          <p class="text-sm font-medium">{{ t(`settings.models.role.${role}`) }}</p>
          <div class="flex flex-col gap-1">
            <Label :for="`role-provider-${role}`">{{ t('settings.models.roleProvider') }}</Label>
            <select :id="`role-provider-${role}`" :class="selectClass" :value="roles[role]?.provider ?? ''" @change="setRole(role, 'provider', ($event.target as HTMLSelectElement).value)">
              <option value="">{{ t('settings.models.roleNone') }}</option>
              <option v-for="provider in providers.filter((p) => p.id.trim() !== '')" :key="provider.id" :value="provider.id">{{ provider.id }}</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <Label :for="`role-model-${role}`">{{ t('settings.models.roleModel') }}</Label>
            <Input :id="`role-model-${role}`" autocomplete="off" :model-value="roles[role]?.model ?? ''" @update:model-value="(value: string | number) => setRole(role, 'model', String(value))" />
          </div>
          <Button type="button" variant="outline" :disabled="!roles[role]?.provider || !roles[role]?.model" @click="settings.test(role)">{{ t('settings.test') }}</Button>
          <p
            v-if="roles[role]?.model?.trim()"
            class="text-sm sm:col-span-4"
            :class="modelValidation(validatedModels, roles[role]!.model.trim()).status === 'validated' ? 'text-foreground' : 'text-muted-foreground'"
            :title="t('settings.models.validation.hint')"
            data-testid="model-validation"
          >
{{ validationLabel(roles[role]!.model) }}
</p>
          <div class="sm:col-span-4"><TestOutcome :outcome="outcomes[role]" /></div>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <Button type="submit" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="saving">{{ saving ? t('common.saving') : t('common.save') }}</Button>
        <p role="status" class="text-sm text-muted-foreground">{{ saved ? t('common.saved') : '' }}</p>
      </div>
      <Alert v-if="saveFailure" variant="destructive"><AlertDescription>{{ t(saveFailure) }}</AlertDescription></Alert>
    </form>
  </section>
</template>
