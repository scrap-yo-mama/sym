<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file PasswordPanel.vue
 * @description Mot de passe du compte (06 § 2, 13 § 5) : mot de passe actuel (ré-authentification), nouveau mot de passe répété.
 * Les trois champs sont lus puis effacés à l'envoi ; aucune valeur n'est gardée. Après le changement, les sessions restent
 * ouvertes et la fermeture des autres est proposée en ligne (ASVS 7.4.3). Un compte SSO seul reçoit une explication.
 * @component
 * @example <PasswordPanel @sessions-closed="sessions.reload()" />
 */
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import CloseOthersOffer from '@/components/account/CloseOthersOffer.vue';
import TextField from '@/components/account/TextField.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { usePasswordChange } from '@/composables/useAccount';
import { takeFieldValue } from '@/lib/form-field';

const emit = defineEmits<{ sessionsClosed: [] }>();
const { t } = useI18n();
const password = usePasswordChange();
const current = ref('');
const next = ref('');
const repeated = ref('');
const offer = ref(false);

async function submit(event: Event): Promise<void> {
  const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : null;
  offer.value = false;
  const ok = await password.change(takeFieldValue(form, 'currentPassword', current), takeFieldValue(form, 'newPassword', next), takeFieldValue(form, 'repeatPassword', repeated));
  offer.value = ok && password.otherSessions.value > 0;
}
</script>

<template>
  <section class="flex flex-col gap-3 rounded-xl border p-4" aria-labelledby="password-heading" data-testid="password-panel">
    <h2 id="password-heading" class="text-lg font-semibold">{{ t('account.password.title') }}</h2>
    <p class="text-sm text-muted-foreground">{{ t('account.password.intro') }}</p>
    <Alert v-if="password.failure.value" variant="destructive" data-testid="password-error"><AlertDescription>{{ t(password.failure.value) }}</AlertDescription></Alert>
    <p v-if="password.done.value" role="status" class="text-sm" data-testid="password-done">{{ t('account.password.done') }}</p>
    <CloseOthersOffer v-if="offer" :count="password.otherSessions.value" @closed="emit('sessionsClosed')" @dismiss="offer = false" />
    <form class="flex flex-col gap-3" novalidate @submit.prevent="submit">
      <TextField id="password-current" v-model="current" :label="t('account.password.current')" type="password" name="currentPassword" class="max-w-xs" autocomplete="current-password" required />
      <TextField id="password-new" v-model="next" :label="t('account.password.new')" :hint="t('account.password.newHint')" type="password" name="newPassword" class="max-w-xs" autocomplete="new-password" required />
      <TextField id="password-repeat" v-model="repeated" :label="t('account.password.repeat')" type="password" name="repeatPassword" class="max-w-xs" autocomplete="new-password" required />
      <div>
        <Button type="submit" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="password.busy.value">{{ password.busy.value ? t('account.password.submitting') : t('account.password.submit') }}</Button>
      </div>
    </form>
  </section>
</template>
