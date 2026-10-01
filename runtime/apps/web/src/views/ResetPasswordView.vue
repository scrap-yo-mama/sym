<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ResetPasswordView.vue
 * @description Nouveau mot de passe par lien à usage unique (13 § 4, § 5) : le lien vient d'un e-mail ou d'un admin. Un compte à
 * 2FA saisit aussi un code (TOTP ou secours) : la réinitialisation ne contourne jamais le second facteur (6.4.3). À la fin, toutes les
 * sessions, clés et jetons du compte sont fermés et il faut se reconnecter. Aucun mot de passe n'est choisi par un admin (6.4.6).
 * @page
 */
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, useRoute } from 'vue-router';
import TextField from '@/components/account/TextField.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { confirmPasswordReset } from '@/composables/useAccountFlows';
import { readFieldValue, takeFieldValue } from '@/lib/form-field';

const { t, te } = useI18n();
const route = useRoute();
const token = computed(() => String(route.params.token ?? ''));
const password = ref('');
const code = ref('');
const submitting = ref(false);
const done = ref(false);
const failure = ref<string | null>(null);

const errorText = computed(() => {
  if (!failure.value) return null;
  const key = `auth.reset.errors.${failure.value}`;
  return te(key) ? t(key) : t(failure.value);
});

async function submit(event: Event): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  failure.value = null;
  const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : null;
  const secret = takeFieldValue(form, 'password', password);
  const result = await confirmPasswordReset({ token: token.value, password: secret, code: readFieldValue(form, 'code', code.value).trim() });
  submitting.value = false;
  if (result.ok) {
    done.value = true;
    code.value = '';
  } else {
    failure.value = result.code && te(`auth.reset.errors.${result.code}`) ? result.code : result.messageKey;
  }
}
</script>

<template>
  <section class="mx-auto flex max-w-md flex-col gap-6 py-10">
    <Card>
      <CardHeader>
        <h1 data-route-heading tabindex="-1" class="text-2xl leading-none font-semibold tracking-tight">{{ t('auth.reset.title') }}</h1>
        <CardDescription>{{ t('auth.reset.description') }}</CardDescription>
      </CardHeader>
      <CardContent>
        <div v-if="done" class="flex flex-col gap-4">
          <p role="status" class="text-sm" data-testid="reset-done">{{ t('auth.reset.done') }}</p>
          <div><Button as-child><RouterLink to="/login">{{ t('auth.reset.toLogin') }}</RouterLink></Button></div>
        </div>
        <form v-else class="flex flex-col gap-4" novalidate data-testid="reset-form" @submit.prevent="submit">
          <Alert v-if="errorText" variant="destructive" data-testid="reset-error"><AlertDescription>{{ errorText }}</AlertDescription></Alert>
          <TextField id="reset-password" v-model="password" :label="t('auth.reset.password')" :hint="t('auth.reset.passwordHint')" type="password" name="password" autocomplete="new-password" required />
          <TextField id="reset-code" v-model="code" :label="t('auth.reset.code')" :hint="t('auth.reset.codeHint')" name="code" inputmode="numeric" autocomplete="one-time-code" />
          <Button type="submit" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="submitting" :aria-busy="submitting">
            {{ submitting ? t('auth.reset.submitting') : t('auth.reset.submit') }}
          </Button>
        </form>
      </CardContent>
    </Card>
  </section>
</template>
