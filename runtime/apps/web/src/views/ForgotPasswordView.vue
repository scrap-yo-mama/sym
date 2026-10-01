<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ForgotPasswordView.vue
 * @description Mot de passe oublié (13 § 4) : l'adresse du compte, puis une réponse identique que le compte existe ou non (6.3.8). Avec
 * SMTP, un lien part par e-mail ; sans SMTP, un admin génère un lien copiable (compte à 2FA) ou l'opérateur utilise la commande
 * serveur : la page ne le dit pas, pour ne rien révéler sur l'existence d'un compte.
 * @page
 */
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import TextField from '@/components/account/TextField.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { requestPasswordReset } from '@/composables/useAccountFlows';
import { readFieldValue } from '@/lib/form-field';

const { t } = useI18n();
const email = ref('');
const submitting = ref(false);
const done = ref(false);
const failure = ref<string | null>(null);

async function submit(event: Event): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  failure.value = null;
  const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : null;
  const result = await requestPasswordReset(readFieldValue(form, 'email', email.value).trim());
  submitting.value = false;
  if (result.ok) done.value = true;
  else failure.value = result.messageKey;
}
</script>

<template>
  <section class="mx-auto flex max-w-md flex-col gap-6 py-10">
    <Card>
      <CardHeader>
        <h1 data-route-heading tabindex="-1" class="text-2xl leading-none font-semibold tracking-tight">{{ t('auth.forgot.title') }}</h1>
        <CardDescription>{{ t('auth.forgot.description') }}</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-4">
        <p v-if="done" role="status" class="text-sm" data-testid="forgot-done">{{ t('auth.forgot.done') }}</p>
        <form v-else class="flex flex-col gap-4" novalidate @submit.prevent="submit">
          <Alert v-if="failure" variant="destructive"><AlertDescription>{{ t(failure) }}</AlertDescription></Alert>
          <TextField id="forgot-email" v-model="email" :label="t('auth.forgot.email')" type="email" name="email" autocomplete="username" required />
          <Button type="submit" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="submitting" :aria-busy="submitting">
            {{ submitting ? t('auth.forgot.submitting') : t('auth.forgot.submit') }}
          </Button>
        </form>
        <p class="text-sm"><RouterLink to="/login" class="underline underline-offset-4">{{ t('auth.forgot.back') }}</RouterLink></p>
      </CardContent>
    </Card>
  </section>
</template>
