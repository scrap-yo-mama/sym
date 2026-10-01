<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file InviteView.vue
 * @description Acceptation d'une invitation (13 § 6) : le lien `/invite/{jeton}` ouvre un formulaire (nom, mot de passe) ; le compte est
 * créé, la session s'ouvre, et si MFA_ENFORCED concerne le rôle l'enrôlement à la 2FA suit avant toute autre page. Un lien inconnu,
 * expiré, révoqué ou déjà utilisé reçoit la même réponse du serveur et le même message ici : la page n'en dit pas plus (6.3.8).
 * Avec SSO exigé, l'invitation s'accepte par le fournisseur d'identité. Le jeton ne quitte jamais l'adresse de la page et le mot de
 * passe n'est conservé nulle part après l'envoi.
 * @page
 */
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import TextField from '@/components/account/TextField.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { acceptInvitation, useSsoPublic } from '@/composables/useAccountFlows';
import { useSession } from '@/composables/useSession';
import { readFieldValue, takeFieldValue } from '@/lib/form-field';

const { t, te } = useI18n();
const route = useRoute();
const router = useRouter();
const { me, isAuthenticated } = useSession();
const { sso, load: loadSso } = useSsoPublic();
onMounted(() => void loadSso());

const token = computed(() => String(route.params.token ?? ''));
const displayName = ref('');
const password = ref('');
const confirmation = ref('');
const submitting = ref(false);
const failure = ref<string | null>(null);
const mismatch = ref(false);

const errorText = computed(() => {
  if (!failure.value) return null;
  const key = `auth.invite.errors.${failure.value}`;
  return te(key) ? t(key) : t(failure.value);
});
const signedInName = computed(() => me.value?.displayName || me.value?.email || '');
const ssoProvider = computed(() => (sso.value?.enabled ? sso.value.providers[0] : undefined));

async function submit(event: Event): Promise<void> {
  if (submitting.value) return;
  failure.value = null;
  mismatch.value = false;
  const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : null;
  const secret = readFieldValue(form, 'password', password.value);
  if (secret !== readFieldValue(form, 'confirm', confirmation.value)) {
    mismatch.value = true;
    return;
  }
  submitting.value = true;
  takeFieldValue(form, 'password', password);
  takeFieldValue(form, 'confirm', confirmation);
  const result = await acceptInvitation({ token: token.value, password: secret, displayName: readFieldValue(form, 'displayName', displayName.value).trim() });
  submitting.value = false;
  if (!result.ok) {
    // Toute invitation inutilisable répond pareil : un seul message (6.3.8) ; les autres codes ont le leur.
    failure.value = result.code && te(`auth.invite.errors.${result.code}`) ? result.code : result.messageKey;
    return;
  }
  await router.replace('/');
}
</script>

<template>
  <section class="mx-auto flex max-w-md flex-col gap-6 py-10">
    <Card>
      <CardHeader>
        <h1 data-route-heading tabindex="-1" class="text-2xl leading-none font-semibold tracking-tight">{{ t('auth.invite.title') }}</h1>
        <CardDescription>{{ t('auth.invite.description') }}</CardDescription>
      </CardHeader>
      <CardContent>
        <form class="flex flex-col gap-4" novalidate data-testid="invite-form" @submit.prevent="submit">
          <Alert v-if="isAuthenticated"><AlertDescription>{{ t('auth.invite.signedIn', { name: signedInName }) }}</AlertDescription></Alert>
          <Alert v-if="errorText" variant="destructive" data-testid="invite-error"><AlertDescription>{{ errorText }}</AlertDescription></Alert>
          <TextField id="invite-name" v-model="displayName" :label="t('auth.invite.displayName')" :hint="t('auth.invite.displayNameHint')" name="displayName" autocomplete="name" />
          <TextField id="invite-password" v-model="password" :label="t('auth.invite.password')" :hint="t('auth.invite.passwordHint')" type="password" name="password" autocomplete="new-password" required />
          <TextField
            id="invite-confirm"
            v-model="confirmation"
            :label="t('auth.invite.confirm')"
            :error="mismatch ? t('auth.invite.mismatch') : null"
            type="password"
            name="confirm"
            autocomplete="new-password"
            required
          />
          <Button type="submit" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="submitting" :aria-busy="submitting">
            {{ submitting ? t('auth.invite.submitting') : t('auth.invite.submit') }}
          </Button>
          <!-- SSO : l'invitation s'accepte chez le fournisseur d'identité (adresse vérifiée égale à celle de l'invitation) -->
          <Button v-if="ssoProvider" as-child variant="outline" data-testid="invite-sso">
            <a :href="`/api/auth/oidc/start?invitation=${encodeURIComponent(token)}`">{{ t('auth.invite.sso', { provider: ssoProvider.label || ssoProvider.slug }) }}</a>
          </Button>
        </form>
      </CardContent>
    </Card>
  </section>
</template>
