<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file TwoFactorSetupView.vue
 * @description Enrôlement forcé à la 2FA (13 § 7) : quand MFA_ENFORCED concerne le rôle et que le compte n'a pas de second facteur, la
 * garde du routeur mène ici avant toute autre route (le serveur refuse déjà le reste avec 403 `mfa_enrollment_required`). Une fois la
 * 2FA confirmée et les codes de secours rangés, la console s'ouvre. Seule autre issue : se déconnecter.
 * @page
 */
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, useRouter } from 'vue-router';
import TwoFactorPanel from '@/components/account/TwoFactorPanel.vue';
import { Button } from '@/components/ui/button';
import { signOut } from '@/composables/useSession';

const { t } = useI18n();
const router = useRouter();
/** Vrai quand les codes de secours sont rangés : seulement alors la console s'ouvre (ils ne se reverront pas). */
const finished = ref(false);

async function leave(): Promise<void> {
  await signOut();
  await router.replace({ name: 'login' });
}
</script>

<template>
  <section class="mx-auto flex max-w-2xl flex-col gap-6 py-8">
    <header class="flex flex-col gap-1">
      <h1 data-route-heading tabindex="-1" class="text-2xl font-semibold tracking-tight">{{ t('twoFactorSetup.title') }}</h1>
      <p class="text-sm text-muted-foreground">{{ t('twoFactorSetup.intro') }}</p>
    </header>
    <TwoFactorPanel forced @backup-stored="finished = true" />
    <!-- L'enrôlement confirmé lève l'exigence : la page reste le temps d'afficher les codes de secours, puis la console s'ouvre. -->
    <div class="flex flex-wrap gap-3">
      <Button v-if="finished" as-child data-testid="two-factor-continue"><RouterLink to="/">{{ t('twoFactorSetup.continue') }}</RouterLink></Button>
      <Button type="button" variant="outline" @click="leave()">{{ t('twoFactorSetup.signOut') }}</Button>
    </div>
  </section>
</template>
