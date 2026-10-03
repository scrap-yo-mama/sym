<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file SetupView.vue
 * @description Premier démarrage (04d § 5.3, D13) : jeton de premier démarrage, e-mail et mot de passe de l'admin
 * (12 caractères au minimum). Mauvais jeton : message, aucun compte créé ; bon jeton : compte créé, jeton consommé, retour
 * à /login. La validation est celle du serveur ; le champ en cause reprend le focus.
 * @page
 */
import { nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { PASSWORD_MIN_LENGTH } from '../api/auth.js';
import { useAuth } from '../auth/store.js';
import ConsoleButton from '../components/ConsoleButton.vue';
import SymMessage from '../components/SymMessage.vue';
import TextField from '../components/TextField.vue';
import { errorKey } from '../i18n.js';

const { t } = useI18n();
const router = useRouter();
const auth = useAuth();

const token = ref('');
const email = ref('');
const password = ref('');
const submitting = ref(false);
const failure = ref<string | null>(null);
const tokenField = ref<InstanceType<typeof TextField> | null>(null);
const emailField = ref<InstanceType<typeof TextField> | null>(null);
const passwordField = ref<InstanceType<typeof TextField> | null>(null);

async function submit(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  failure.value = null;
  const result = await auth.setup({ token: token.value.trim(), email: email.value.trim(), password: password.value });
  submitting.value = false;
  if (result.ok) {
    token.value = '';
    password.value = '';
    await router.replace({ name: 'login' });
    return;
  }
  if (result.code === 'already_initialized') {
    await router.replace({ name: 'login' });
    return;
  }
  failure.value = result.code;
  await nextTick();
  if (result.code === 'invalid_email') emailField.value?.focus();
  else if (result.code === 'weak_password') passwordField.value?.focus();
  else tokenField.value?.focus();
}
</script>

<template>
  <section class="mx-auto flex w-full max-w-md flex-col gap-6" aria-labelledby="setup-title">
    <div class="flex flex-col gap-6 rounded-xl border border-border bg-card p-6 text-card-foreground sm:p-8">
      <div class="flex flex-col gap-3">
        <h1 id="setup-title" data-route-heading tabindex="-1" class="text-3xl">{{ t('console.setup.title') }}</h1>
        <SymMessage :text="t('console.setup.intro')" />
      </div>

      <form class="flex flex-col gap-4" novalidate data-testid="setup-form" @submit.prevent="submit">
        <p v-if="failure" id="setup-error" role="alert" class="sym-error">{{ t(errorKey('setup', failure)) }}</p>
        <TextField
          id="setup-token"
          ref="tokenField"
          v-model="token"
          name="token"
          :label="t('console.setup.token')"
          :hint="t('console.setup.tokenHint')"
          autocomplete="off"
          :spellcheck="false"
          :invalid="failure === 'invalid_bootstrap_token'"
          error-id="setup-error"
        />
        <TextField
          id="setup-email"
          ref="emailField"
          v-model="email"
          name="email"
          type="email"
          :label="t('console.setup.email')"
          autocomplete="username"
          inputmode="email"
          :spellcheck="false"
          :invalid="failure === 'invalid_email'"
          error-id="setup-error"
        />
        <TextField
          id="setup-password"
          ref="passwordField"
          v-model="password"
          name="password"
          type="password"
          :label="t('console.setup.password')"
          :hint="t('console.setup.passwordHint')"
          autocomplete="new-password"
          :minlength="PASSWORD_MIN_LENGTH"
          :invalid="failure === 'weak_password'"
          error-id="setup-error"
        />
        <ConsoleButton type="submit" :busy="submitting">{{ submitting ? t('console.setup.submitting') : t('console.setup.submit') }}</ConsoleButton>
      </form>
    </div>
  </section>
</template>
