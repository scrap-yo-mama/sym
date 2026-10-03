<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file LoginView.vue
 * @description Connexion admin de la console (03 § 7, tâche 3.5) : e-mail et mot de passe, puis code TOTP si la 2FA est
 * activée. Les erreurs sont des codes stables traduits ; compte inconnu et mauvais mot de passe reçoivent le même message.
 * Après un échec, le mot de passe est vidé et reprend le focus ; l'erreur est annoncée (role="alert").
 * @page
 */
import { computed, nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useAuth } from '../auth/store.js';
import ConsoleButton from '../components/ConsoleButton.vue';
import SymMessage from '../components/SymMessage.vue';
import TextField from '../components/TextField.vue';
import { errorKey } from '../i18n.js';
import { safeRedirect } from '../router.js';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuth();

const email = ref('');
const password = ref('');
const code = ref('');
const submitting = ref(false);
const failure = ref<string | null>(null);
const passwordField = ref<InstanceType<typeof TextField> | null>(null);
const codeField = ref<InstanceType<typeof TextField> | null>(null);

const awaitingCode = computed(() => auth.state.value === 'totp_pending');
const errorText = computed<string | null>(() => {
  if (failure.value) return t(errorKey('login', failure.value));
  if (auth.state.value === 'unavailable') return t('console.login.errors.network');
  if (auth.expired.value) return t('console.login.errors.session_expired');
  return null;
});

async function finish(): Promise<void> {
  password.value = '';
  code.value = '';
  await router.replace(safeRedirect(route.query.redirect));
}

async function submit(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  failure.value = null;
  const result = await auth.login(email.value.trim(), password.value);
  submitting.value = false;
  if (!result.ok) {
    failure.value = result.code;
    password.value = '';
    await nextTick();
    passwordField.value?.focus();
    return;
  }
  if (result.step === 'done') return finish();
  password.value = '';
  await nextTick();
  codeField.value?.focus();
}

async function submitCode(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  failure.value = null;
  const result = await auth.verifyTotp(code.value.trim());
  submitting.value = false;
  if (result.ok) return finish();
  failure.value = result.code;
  code.value = '';
  await nextTick();
  codeField.value?.focus();
}

async function cancelCode(): Promise<void> {
  failure.value = null;
  code.value = '';
  await auth.cancelTotp();
}
</script>

<template>
  <section class="mx-auto flex w-full max-w-md flex-col gap-6" aria-labelledby="login-title">
    <div class="flex flex-col gap-6 rounded-xl border border-border bg-card p-6 text-card-foreground sm:p-8">
      <div class="flex flex-col gap-2">
        <h1 id="login-title" data-route-heading tabindex="-1" class="text-3xl">{{ awaitingCode ? t('console.login.totp.title') : t('console.login.title') }}</h1>
        <p class="text-muted-foreground">{{ awaitingCode ? t('console.login.totp.description') : t('console.login.description') }}</p>
      </div>

      <div v-if="auth.justInitialized.value && !awaitingCode" role="status" class="rounded-md bg-secondary px-3 py-2 text-secondary-foreground">
        <SymMessage :text="t('console.login.initialized')" />
      </div>

      <form v-if="awaitingCode" class="flex flex-col gap-4" novalidate data-testid="totp-form" @submit.prevent="submitCode">
        <p v-if="errorText" id="login-error" role="alert" class="sym-error">{{ errorText }}</p>
        <TextField
          id="login-code"
          ref="codeField"
          v-model="code"
          name="code"
          :label="t('console.login.totp.code')"
          inputmode="numeric"
          autocomplete="one-time-code"
          :maxlength="8"
          :spellcheck="false"
          :invalid="failure !== null"
          error-id="login-error"
        />
        <ConsoleButton type="submit" :busy="submitting">{{ submitting ? t('console.login.totp.submitting') : t('console.login.totp.submit') }}</ConsoleButton>
        <ConsoleButton type="button" variant="outline" @click="cancelCode">{{ t('console.login.totp.cancel') }}</ConsoleButton>
      </form>

      <form v-else class="flex flex-col gap-4" novalidate data-testid="login-form" @submit.prevent="submit">
        <p v-if="errorText" id="login-error" role="alert" class="sym-error">{{ errorText }}</p>
        <TextField
          id="login-email"
          v-model="email"
          name="email"
          type="email"
          :label="t('console.login.email')"
          autocomplete="username"
          inputmode="email"
          :spellcheck="false"
          :invalid="failure === 'invalid_credentials'"
          error-id="login-error"
        />
        <TextField
          id="login-password"
          ref="passwordField"
          v-model="password"
          name="password"
          type="password"
          :label="t('console.login.password')"
          autocomplete="current-password"
          :invalid="failure === 'invalid_credentials'"
          error-id="login-error"
        />
        <ConsoleButton type="submit" :busy="submitting">{{ submitting ? t('console.login.submitting') : t('console.login.submit') }}</ConsoleButton>
      </form>
    </div>
  </section>
</template>
