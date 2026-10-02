<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file RobotIdentitySettingsView.vue
 * @description Réglages > Identité du robot (admin ou owner, 06 § 2, 17 § 5) : le User-Agent réel du moteur embarqué, affiché en
 * lecture seule (il n'a pas de champ de saisie : aucune chaîne ne se choisit ici), l'interrupteur `identify_instance` (désactivé par
 * défaut) qui ajoute le jeton `compatible; Scrapyomama/<version>; +<contact>`, et le contact de l'opérateur de l'instance. Le
 * serveur refuse (403) tout autre rôle ; la route redirige aussi.
 * @page
 */
import { computed, onMounted, onServerPrefetch } from 'vue';
import { useI18n } from 'vue-i18n';
import TextField from '@/components/account/TextField.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useIdentitySettings } from '@/composables/useInstanceSettings';

const { t } = useI18n();
const settings = useIdentitySettings();
const { form, saving, saved, failure } = settings;

// Réglage jamais posé : dire d'où vient ce que le worker applique (sa variable d'environnement), plutôt qu'un « désactivé » supposé.
const identifyHint = computed(() => {
  const data = settings.data.value;
  if (data?.identify_instance !== null) return t('instance.identity.identifyHint');
  if (data.identify_source === 'env') return t(data.identify_effective === true ? 'instance.identity.identifyFromEnvOn' : 'instance.identity.identifyFromEnvOff');
  return t('instance.identity.identifyUnset');
});
const contactHint = computed(() => {
  const data = settings.data.value;
  if (data?.instance_contact !== null) return t('instance.identity.contactHint');
  if (data.instance_contact_source === 'env' && data.instance_contact_effective !== null) return t('instance.identity.contactFromEnv', { contact: data.instance_contact_effective });
  return t('instance.identity.contactUnset');
});

onMounted(() => void settings.load());
onServerPrefetch(() => settings.load());
</script>

<template>
  <section class="flex flex-col gap-6" aria-labelledby="identity-heading">
    <header class="flex flex-col gap-1">
      <h1 id="identity-heading" data-route-heading tabindex="-1" class="text-2xl font-semibold tracking-tight">{{ t('instance.identity.title') }}</h1>
      <p class="text-sm text-muted-foreground">{{ t('instance.identity.intro') }}</p>
    </header>

    <p v-if="settings.loading.value && !settings.data.value" role="status" class="text-sm text-muted-foreground">{{ t('ui.loading') }}</p>
    <Alert v-else-if="settings.loadFailure.value" variant="destructive" data-testid="identity-load-error">
      <AlertDescription>{{ settings.forbidden.value ? t('settings.adminOnly') : t(settings.loadFailure.value) }}</AlertDescription>
    </Alert>
    <template v-else-if="settings.data.value">
      <div class="flex flex-col gap-3 rounded-xl border p-4" data-testid="identity-engine">
        <div class="flex flex-col gap-1">
          <Label for="identity-ua">{{ t('instance.identity.userAgent') }}</Label>
          <Input v-if="settings.data.value.user_agent" id="identity-ua" :model-value="settings.data.value.user_agent" readonly class="font-mono text-xs" aria-describedby="identity-ua-hint" data-testid="identity-ua" />
          <p v-else id="identity-ua" class="text-sm" data-testid="identity-ua-unknown">{{ t('instance.identity.userAgentUnknown') }}</p>
          <p id="identity-ua-hint" class="text-xs text-muted-foreground">{{ t('instance.identity.userAgentHint') }}</p>
        </div>
        <div v-if="settings.data.value.user_agent_identified" class="flex flex-col gap-1">
          <Label for="identity-ua-identified">{{ t('instance.identity.identified') }}</Label>
          <Input id="identity-ua-identified" :model-value="settings.data.value.user_agent_identified" readonly class="font-mono text-xs" aria-describedby="identity-identified-hint" data-testid="identity-ua-identified" />
          <p id="identity-identified-hint" class="text-xs text-muted-foreground">{{ t('instance.identity.identifiedHint') }}</p>
        </div>
      </div>

      <form class="flex flex-col gap-4 rounded-xl border p-4" novalidate data-testid="identity-form" @submit.prevent="settings.save()">
        <Alert v-if="failure" variant="destructive" data-testid="identity-error"><AlertDescription>{{ t(failure) }}</AlertDescription></Alert>
        <p v-if="saved" role="status" class="text-sm" data-testid="identity-saved">{{ t('common.saved') }}</p>
        <label class="flex min-h-8 items-start gap-3 text-sm">
          <input v-model="form.identify" type="checkbox" class="mt-0.5 size-5" name="identify" aria-describedby="identity-identify-hint" data-testid="identity-identify" />
          <span>{{ t('instance.identity.identify') }}</span>
        </label>
        <p id="identity-identify-hint" class="-mt-2 ml-8 text-xs text-muted-foreground" data-testid="identity-identify-hint">{{ identifyHint }}</p>
        <TextField
          id="identity-contact"
          v-model="form.contact"
          :label="t('instance.identity.contact')"
          :hint="contactHint"
          name="contact"
          class="max-w-xl"
          autocomplete="off"
          inputmode="url"
          maxlength="400"
        />
        <div><Button type="submit" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="saving" data-testid="identity-save">{{ saving ? t('common.saving') : t('instance.identity.save') }}</Button></div>
      </form>
    </template>
  </section>
</template>
