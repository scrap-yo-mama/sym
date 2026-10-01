<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { signIn, useSession, type SignInFailure } from '@/composables/useSession';
import { safeRedirect } from '@/router';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { state, expired } = useSession();

const email = ref('');
const password = ref('');
const submitting = ref(false);
const failure = ref<SignInFailure | null>(null);

/** Message d'erreur : échec de la tentative, sinon état du serveur ou session terminée. Toujours un code stable traduit. */
const errorKey = computed<string | null>(() => {
  if (failure.value) return `auth.errors.${failure.value}`;
  if (state.value === 'not_initialized') return 'auth.errors.not_initialized';
  if (state.value === 'unavailable') return 'auth.errors.network';
  if (expired.value) return 'auth.errors.session_expired';
  return null;
});

async function submit(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  failure.value = null;
  const result = await signIn(email.value.trim(), password.value);
  submitting.value = false;
  if (result.ok) {
    password.value = '';
    await router.replace(safeRedirect(route.query.redirect));
  } else {
    failure.value = result.failure;
  }
}
</script>

<template>
  <section class="mx-auto flex max-w-md flex-col gap-6 py-10">
    <Card>
      <CardHeader>
        <CardTitle>
          <h1 data-route-heading tabindex="-1" class="text-2xl font-semibold tracking-tight">{{ t('auth.login.title') }}</h1>
        </CardTitle>
        <CardDescription>{{ t('auth.login.description') }}</CardDescription>
      </CardHeader>
      <CardContent>
        <form class="flex flex-col gap-4" novalidate @submit.prevent="submit">
          <Alert v-if="errorKey" variant="destructive" data-testid="login-error">
            <AlertDescription>{{ t(errorKey) }}</AlertDescription>
          </Alert>
          <div class="flex flex-col gap-2">
            <Label for="login-email">{{ t('auth.login.email') }}</Label>
            <Input
              id="login-email"
              type="email"
              name="email"
              autocomplete="username"
              required
              :model-value="email"
              @update:model-value="(value: string | number) => (email = String(value))"
            />
          </div>
          <div class="flex flex-col gap-2">
            <Label for="login-password">{{ t('auth.login.password') }}</Label>
            <Input
              id="login-password"
              type="password"
              name="password"
              autocomplete="current-password"
              required
              :model-value="password"
              @update:model-value="(value: string | number) => (password = String(value))"
            />
          </div>
          <!-- aria-disabled et non disabled : le bouton garde le focus pendant l'envoi -->
          <Button type="submit" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="submitting" :aria-busy="submitting">
            {{ submitting ? t('auth.login.submitting') : t('auth.login.submit') }}
          </Button>
        </form>
      </CardContent>
    </Card>
  </section>
</template>
