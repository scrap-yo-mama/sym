<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file TwoFactorPanel.vue
 * @description 2FA TOTP du compte (13 § 7) : activer (ré-authentification, graine affichée une fois, premier code, 10 codes de secours
 * affichés une fois), régénérer les codes de secours (mot de passe et code), retirer la 2FA (non proposé quand MFA_ENFORCED concerne
 * le rôle : une explication le remplace). Après chaque changement réussi, la fermeture des autres sessions est proposée en ligne
 * (13 § 5, ASVS 7.4.3). Sert à Mon compte et à l'enrôlement forcé. Mot de passe et codes partent dans la requête et sont effacés des champs ; la
 * graine et les codes de secours quittent la mémoire quand on les range. Pas de code QR : la graine et l'adresse `otpauth` se saisissent.
 * @component
 * @example <TwoFactorPanel :forced="true" />
 */
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import TextField from '@/components/account/TextField.vue';
import CloseOthersOffer from '@/components/account/CloseOthersOffer.vue';
import SecretReveal from '@/components/account/SecretReveal.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useTwoFactor } from '@/composables/useAccount';
import { useSession } from '@/composables/useSession';
import { readFieldValue, takeFieldValue } from '@/lib/form-field';

defineProps<{ forced?: boolean }>();
const emit = defineEmits<{ backupStored: []; sessionsClosed: [] }>();
const { t } = useI18n();
const { me } = useSession();
const twoFactor = useTwoFactor();
const { phase, enrollment, backupCodes, busy, failure, disabledDone, offerCloseOthers } = twoFactor;

const enabled = computed(() => me.value?.mfaEnabled === true);
/** MFA_ENFORCED concerne le rôle : le serveur refuserait le retrait (403 `mfa_enforced`), il n'est pas proposé. */
const required = computed(() => me.value?.mfaRequired === true);
const startPassword = ref('');
const confirmCode = ref('');
const regenPassword = ref('');
const regenCode = ref('');
const disablePassword = ref('');
const disableCode = ref('');

function storeBackup(): void {
  twoFactor.acknowledgeBackup();
  emit('backupStored');
}

const form = (event: Event): HTMLFormElement | null => (event.currentTarget instanceof HTMLFormElement ? event.currentTarget : null);

const start = (event: Event): Promise<boolean> => twoFactor.start(takeFieldValue(form(event), 'currentPassword', startPassword));
async function confirm(event: Event): Promise<void> {
  const ok = await twoFactor.confirm(readFieldValue(form(event), 'code', confirmCode.value).trim());
  if (ok) confirmCode.value = '';
}
const regenerate = (event: Event): Promise<boolean> => {
  const f = form(event);
  return twoFactor.regenerate(takeFieldValue(f, 'currentPassword', regenPassword), takeFieldValue(f, 'code', regenCode).trim());
};
const disable = (event: Event): Promise<boolean> => {
  const f = form(event);
  return twoFactor.disable(takeFieldValue(f, 'currentPassword', disablePassword), takeFieldValue(f, 'code', disableCode).trim());
};
</script>

<template>
  <section class="flex flex-col gap-4 rounded-xl border p-4" aria-labelledby="two-factor-heading" data-testid="two-factor-panel">
    <header class="flex flex-col gap-1">
      <h2 id="two-factor-heading" class="text-lg font-semibold">{{ t('account.twoFactor.title') }}</h2>
      <p class="text-sm text-muted-foreground">{{ t('account.twoFactor.intro') }}</p>
      <p class="text-sm font-medium" data-testid="two-factor-state">{{ enabled ? t('account.twoFactor.on') : t('account.twoFactor.off') }}</p>
      <p v-if="forced" class="text-sm">{{ t('account.twoFactor.enforced') }}</p>
    </header>

    <Alert v-if="failure" variant="destructive" data-testid="two-factor-error"><AlertDescription>{{ t(failure) }}</AlertDescription></Alert>
    <p v-if="disabledDone" role="status" class="text-sm">{{ t('account.twoFactor.disabledDone') }}</p>
    <CloseOthersOffer v-if="offerCloseOthers && phase !== 'backup'" @closed="emit('sessionsClosed')" @dismiss="twoFactor.dismissCloseOthers()" />

    <SecretReveal
      v-if="phase === 'backup'"
      :title="t('account.twoFactor.backupTitle')"
      :text="t('account.twoFactor.backupHelp')"
      :value="backupCodes.join('\n')"
      :copy-label="t('account.twoFactor.backupCopy')"
      :dismiss-label="t('account.twoFactor.backupDone')"
      multiline
      @dismiss="storeBackup()"
    />

    <template v-else-if="!enabled">
      <form v-if="phase === 'idle'" class="flex flex-col gap-3" novalidate data-testid="two-factor-start" @submit.prevent="start">
        <h3 class="font-medium">{{ t('account.twoFactor.enrollTitle') }}</h3>
        <TextField id="two-factor-password" v-model="startPassword" :label="t('account.twoFactor.password')" :hint="t('account.twoFactor.passwordHint')" type="password" name="currentPassword" class="max-w-xs" autocomplete="current-password" />
        <div><Button type="submit" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="busy">{{ t('account.twoFactor.start') }}</Button></div>
      </form>
      <form v-else-if="phase === 'enrolling' && enrollment" class="flex flex-col gap-3" novalidate data-testid="two-factor-confirm" @submit.prevent="confirm">
        <h3 class="font-medium">{{ t('account.twoFactor.seedTitle') }}</h3>
        <p class="text-sm text-muted-foreground">{{ t('account.twoFactor.seedHelp') }}</p>
        <div class="flex flex-col gap-1" role="status">
          <p class="text-sm font-medium">{{ t('account.twoFactor.seed') }}</p>
          <code class="rounded-md border p-2 font-mono text-sm break-all select-all" data-testid="two-factor-seed">{{ enrollment.secret }}</code>
          <p class="text-sm font-medium">{{ t('account.twoFactor.uri') }}</p>
          <code class="rounded-md border p-2 font-mono text-xs break-all select-all">{{ enrollment.uri }}</code>
        </div>
        <TextField id="two-factor-code" v-model="confirmCode" :label="t('account.twoFactor.code')" name="code" class="max-w-xs" inputmode="numeric" autocomplete="one-time-code" required />
        <div class="flex flex-wrap gap-3">
          <Button type="submit" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="busy">{{ busy ? t('account.twoFactor.confirming') : t('account.twoFactor.confirm') }}</Button>
          <Button type="button" variant="outline" @click="twoFactor.cancel()">{{ t('account.twoFactor.cancel') }}</Button>
        </div>
      </form>
    </template>

    <template v-else>
      <form class="flex flex-col gap-3 border-t pt-4" novalidate data-testid="two-factor-regenerate" @submit.prevent="regenerate">
        <h3 class="font-medium">{{ t('account.twoFactor.regenerateTitle') }}</h3>
        <p class="text-sm text-muted-foreground">{{ t('account.twoFactor.regenerateHelp') }}</p>
        <TextField id="regen-password" v-model="regenPassword" :label="t('account.twoFactor.password')" :hint="t('account.twoFactor.passwordHint')" type="password" name="currentPassword" class="max-w-xs" autocomplete="current-password" />
        <TextField id="regen-code" v-model="regenCode" :label="t('account.twoFactor.currentCode')" name="code" class="max-w-xs" inputmode="numeric" autocomplete="one-time-code" required />
        <div><Button type="submit" variant="outline" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="busy">{{ t('account.twoFactor.regenerate') }}</Button></div>
      </form>
      <p v-if="required" class="border-t pt-4 text-sm" data-testid="two-factor-removal-blocked">{{ t('account.twoFactor.removalBlocked') }}</p>
      <form v-else class="flex flex-col gap-3 border-t pt-4" novalidate data-testid="two-factor-disable" @submit.prevent="disable">
        <h3 class="font-medium">{{ t('account.twoFactor.disableTitle') }}</h3>
        <p class="text-sm text-muted-foreground">{{ t('account.twoFactor.disableHelp') }}</p>
        <TextField id="disable-password" v-model="disablePassword" :label="t('account.twoFactor.password')" :hint="t('account.twoFactor.passwordHint')" type="password" name="currentPassword" class="max-w-xs" autocomplete="current-password" />
        <TextField id="disable-code" v-model="disableCode" :label="t('account.twoFactor.currentCode')" name="code" class="max-w-xs" inputmode="numeric" autocomplete="one-time-code" required />
        <div><Button type="submit" variant="outline" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="busy">{{ t('account.twoFactor.disable') }}</Button></div>
      </form>
    </template>
  </section>
</template>
