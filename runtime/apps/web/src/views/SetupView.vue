<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file SetupView.vue
 * @description Assistant de premier démarrage (13 § 4), à usage unique : jeton de démarrage, e-mail, mot de passe. L'owner créé, la
 * console le connecte, montre UNE FOIS l'empreinte de la clé avec le rappel « sauvegarde MASTER_KEY hors de cette plateforme »
 * (case à cocher avant de continuer), puis enchaîne sur les modèles IA, les proxys et l'e-mail avec leurs boutons Tester. Aucun
 * compte par défaut. Quand un owner existe, la route répond « introuvable » (garde du routeur) ; la page ne garde ni le jeton ni
 * le mot de passe après l'envoi.
 * @page
 */
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, useRouter } from 'vue-router';
import TextField from '@/components/account/TextField.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { postSetup } from '@/composables/useAccountFlows';
import { signIn } from '@/composables/useSession';
import { takeFieldValue, readFieldValue } from '@/lib/form-field';

const { t, te } = useI18n();
const router = useRouter();

const token = ref('');
const email = ref('');
const displayName = ref('');
const password = ref('');
const submitting = ref(false);
/** Clé i18n de l'erreur du serveur, sinon null. */
const failure = ref<string | null>(null);
/** Empreinte de la clé : montrée une fois, effacée dès que la page est quittée (jamais relue du serveur). */
const fingerprint = ref<string | null>(null);
const signedIn = ref(true);
const acknowledged = ref(false);
const showNext = ref(false);

const errorText = computed(() => {
  if (!failure.value) return null;
  const key = `setup.errors.${failure.value}`;
  return te(key) ? t(key) : t(failure.value);
});

async function submit(event: Event): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  failure.value = null;
  const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : null;
  // Jeton et mot de passe lus dans le DOM puis effacés : ils ne restent ni dans le champ ni en mémoire après l'envoi.
  const secretToken = takeFieldValue(form, 'token', token);
  const secretPassword = takeFieldValue(form, 'password', password);
  const address = readFieldValue(form, 'email', email.value).trim();
  const result = await postSetup({ token: secretToken, email: address, password: secretPassword, displayName: readFieldValue(form, 'displayName', displayName.value).trim() });
  if (!result.ok) {
    submitting.value = false;
    // Les codes du serveur (`forbidden`, `weak_password`, `too_many_attempts`) ont leur message ; sinon le message du statut.
    failure.value = result.code && te(`setup.errors.${result.code}`) ? result.code : result.messageKey;
    return;
  }
  fingerprint.value = result.data.keyFingerprint;
  // L'owner est connecté avec ce qu'il vient de saisir (pas de seconde saisie) ; un échec renvoie à la page de connexion.
  signedIn.value = (await signIn(address, secretPassword)).ok;
  submitting.value = false;
}

async function goOn(): Promise<void> {
  // L'empreinte quitte la mémoire de l'écran : elle ne sera plus jamais affichée.
  fingerprint.value = null;
  if (signedIn.value) showNext.value = true;
  else await router.replace({ name: 'login' });
}
</script>

<template>
  <section class="mx-auto flex max-w-xl flex-col gap-6 py-10">
    <Card v-if="showNext" data-testid="setup-next">
      <CardHeader>
        <h1 data-route-heading tabindex="-1" class="text-2xl leading-none font-semibold tracking-tight">{{ t('setup.next.title') }}</h1>
        <CardDescription>{{ t('setup.next.intro') }}</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-4">
        <ol class="flex flex-col gap-3">
          <li v-for="step in ['models', 'proxies', 'alerts'] as const" :key="step" class="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <span class="text-sm">{{ t(`setup.next.${step}`) }}</span>
            <Button as-child variant="outline" size="sm"><RouterLink :to="`/settings/${step}`">{{ t('setup.next.open') }}</RouterLink></Button>
          </li>
        </ol>
        <div><Button as-child><RouterLink to="/">{{ t('setup.next.later') }}</RouterLink></Button></div>
      </CardContent>
    </Card>

    <Card v-else-if="fingerprint !== null" data-testid="setup-done">
      <CardHeader>
        <h1 data-route-heading tabindex="-1" class="text-2xl leading-none font-semibold tracking-tight">{{ t('setup.done.title') }}</h1>
      </CardHeader>
      <CardContent class="flex flex-col gap-4">
        <Alert v-if="!signedIn" variant="destructive"><AlertDescription>{{ t('setup.signInFailed') }}</AlertDescription></Alert>
        <div role="status" class="flex flex-col gap-2 rounded-lg border-2 p-3">
          <p class="text-sm font-medium">{{ t('setup.done.fingerprint') }}</p>
          <code class="font-mono text-lg break-all select-all" data-testid="key-fingerprint">{{ fingerprint }}</code>
          <p class="text-sm text-muted-foreground">{{ t('setup.done.onlyOnce') }}</p>
        </div>
        <p class="text-sm font-medium" data-testid="key-reminder">{{ t('setup.done.reminder') }}</p>
        <label class="flex min-h-11 items-center gap-3 text-sm">
          <input v-model="acknowledged" type="checkbox" class="size-5" data-testid="key-acknowledge" />
          <span>{{ t('setup.done.acknowledge') }}</span>
        </label>
        <div>
          <Button type="button" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="!acknowledged" data-testid="setup-continue" @click="acknowledged && goOn()">{{ t('setup.done.continue') }}</Button>
        </div>
      </CardContent>
    </Card>

    <Card v-else>
      <CardHeader>
        <h1 data-route-heading tabindex="-1" class="text-2xl leading-none font-semibold tracking-tight">{{ t('setup.title') }}</h1>
        <CardDescription>{{ t('setup.intro') }}</CardDescription>
      </CardHeader>
      <CardContent>
        <form class="flex flex-col gap-4" novalidate data-testid="setup-form" @submit.prevent="submit">
          <Alert v-if="errorText" variant="destructive" data-testid="setup-error"><AlertDescription>{{ errorText }}</AlertDescription></Alert>
          <TextField id="setup-token" v-model="token" :label="t('setup.token')" :hint="t('setup.tokenHint')" type="password" name="token" autocomplete="off" required />
          <TextField id="setup-email" v-model="email" :label="t('setup.email')" type="email" name="email" autocomplete="username" required />
          <TextField id="setup-name" v-model="displayName" :label="t('setup.displayName')" :hint="t('setup.displayNameHint')" name="displayName" autocomplete="name" />
          <TextField id="setup-password" v-model="password" :label="t('setup.password')" :hint="t('setup.passwordHint')" type="password" name="password" autocomplete="new-password" required />
          <Button type="submit" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="submitting" :aria-busy="submitting">
            {{ submitting ? t('setup.submitting') : t('setup.submit') }}
          </Button>
        </form>
      </CardContent>
    </Card>
  </section>
</template>
