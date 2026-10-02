<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file LoginView.vue
 * @description Connexion (06 § 1) : e-mail et mot de passe, puis second facteur (code TOTP ou code de secours) quand le compte en
 * a un (13 § 7), connexion SSO si l'instance en propose une, lien « mot de passe oublié ». Les messages sont des codes stables
 * traduits ; un compte inconnu et un mauvais mot de passe reçoivent le même message (13 § 5).
 * @page
 */
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import TextField from '@/components/account/TextField.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import PageHeader from '@/components/brand/PageHeader.vue';
import SymIllustration from '@/components/brand/SymIllustration.vue';
import { Card, CardContent } from '@/components/ui/card';
import { useSsoPublic } from '@/composables/useAccountFlows';
import { signIn, signOut, useSession, verifySecondFactor, type SecondFactorFailure, type SignInFailure } from '@/composables/useSession';
import { readFieldValue } from '@/lib/form-field';
import { safeRedirect } from '@/router';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { state, expired } = useSession();
const { sso, load: loadSso } = useSsoPublic();
onMounted(() => void loadSso());

const email = ref('');
const password = ref('');
const code = ref('');
const submitting = ref(false);
const failure = ref<SignInFailure | SecondFactorFailure | null>(null);

/** Second facteur attendu : le mot de passe est vérifié, le code reste à saisir. */
const awaitingCode = computed(() => state.value === 'mfa_pending');
/** Code d'erreur du retour de l'IdP (`/login?sso_error=<code>`), seulement s'il a la forme d'un code stable. */
const ssoError = computed(() => {
  const value = route.query.sso_error;
  return typeof value === 'string' && /^[a-z0-9_]{1,40}$/.test(value) ? value : null;
});

/** Message d'erreur : échec de la tentative, sinon état du serveur, retour SSO ou session terminée. Toujours un code stable traduit. */
const errorText = computed<string | null>(() => {
  if (failure.value) return t(`auth.errors.${failure.value}`);
  if (state.value === 'not_initialized') return t('auth.errors.not_initialized');
  if (state.value === 'unavailable') return t('auth.errors.network');
  if (ssoError.value) return t('auth.errors.sso', { code: ssoError.value });
  if (expired.value) return t('auth.errors.session_expired');
  return null;
});

async function finish(): Promise<void> {
  password.value = '';
  code.value = '';
  await router.replace(safeRedirect(route.query.redirect));
}

async function submit(event: Event): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  failure.value = null;
  // Valeurs lues dans le DOM : l'autoremplissage du navigateur ne déclenche pas toujours `input` (F-20261001-UX01).
  const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : null;
  const result = await signIn(readFieldValue(form, 'email', email.value).trim(), readFieldValue(form, 'password', password.value));
  submitting.value = false;
  if (!result.ok) {
    failure.value = result.failure;
  } else if (state.value === 'authenticated') {
    await finish();
  }
  // Sinon `state` vaut `mfa_pending` : la saisie du code remplace le formulaire.
}

async function submitCode(event: Event): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  failure.value = null;
  const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : null;
  const result = await verifySecondFactor(readFieldValue(form, 'code', code.value).trim());
  submitting.value = false;
  if (result.ok) await finish();
  else failure.value = result.failure;
}

async function cancelCode(): Promise<void> {
  failure.value = null;
  await signOut();
}
</script>

<template>
  <section class="mx-auto grid max-w-6xl gap-7 py-8 lg:grid-cols-2 lg:items-start">
    <div class="flex flex-col gap-6">
      <PageHeader :title="awaitingCode ? t('auth.secondFactor.title') : t('auth.login.title')" :kicker="t('brand.kicker.login')">
        <p class="sym-lead">{{ awaitingCode ? t('auth.secondFactor.description') : t('auth.login.description') }}</p>
      </PageHeader>
    <Card>
      <CardContent>
        <form v-if="awaitingCode" class="flex flex-col gap-4" novalidate data-testid="second-factor-form" @submit.prevent="submitCode">
          <Alert v-if="errorText" variant="destructive" data-testid="login-error">
            <AlertDescription>{{ errorText }}</AlertDescription>
          </Alert>
          <TextField id="login-code" v-model="code" :label="t('auth.secondFactor.code')" name="code" inputmode="numeric" autocomplete="one-time-code" required />
          <!-- aria-disabled et non disabled : le bouton garde le focus pendant l'envoi -->
          <Button type="submit" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="submitting" :aria-busy="submitting">
            {{ submitting ? t('auth.secondFactor.submitting') : t('auth.secondFactor.submit') }}
          </Button>
          <Button type="button" variant="outline" @click="cancelCode()">{{ t('auth.secondFactor.cancel') }}</Button>
        </form>
        <div v-else class="flex flex-col gap-4">
          <form class="flex flex-col gap-4" novalidate @submit.prevent="submit">
            <Alert v-if="errorText" variant="destructive" data-testid="login-error">
              <AlertDescription>{{ errorText }}</AlertDescription>
            </Alert>
            <TextField id="login-email" v-model="email" :label="t('auth.login.email')" type="email" name="email" autocomplete="username" required />
            <TextField id="login-password" v-model="password" :label="t('auth.login.password')" type="password" name="password" autocomplete="current-password" required />
            <!-- aria-disabled et non disabled : le bouton garde le focus pendant l'envoi -->
            <Button type="submit" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="submitting" :aria-busy="submitting">
              {{ submitting ? t('auth.login.submitting') : t('auth.login.submit') }}
            </Button>
          </form>
          <p class="text-sm"><RouterLink to="/forgot-password" class="underline underline-offset-4">{{ t('auth.login.forgot') }}</RouterLink></p>
          <template v-for="provider in sso?.enabled ? sso.providers : []" :key="provider.slug">
            <p class="text-center text-sm text-muted-foreground">{{ t('auth.login.ssoSeparator') }}</p>
            <!-- Redirection de navigateur vers l'IdP (PKCE côté serveur) : un lien, pas un appel d'API -->
            <Button as-child variant="outline" data-testid="sso-login"><a href="/api/auth/oidc/start?intent=login">{{ t('auth.login.sso', { provider: provider.label || provider.slug }) }}</a></Button>
          </template>
        </div>
      </CardContent>
    </Card>
    </div>
    <!-- Pas de bulle sur un message d'erreur (20 § 2.3) : la signature de SYM n'accompagne jamais une erreur -->
    <SymIllustration class="hidden lg:block" :bubble="errorText ? undefined : t('brand.bubble.onIt')" />
  </section>
</template>
