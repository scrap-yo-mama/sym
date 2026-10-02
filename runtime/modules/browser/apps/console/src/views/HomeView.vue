<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file HomeView.vue
 * @description Accueil de la console connectée (tâche 3.5) : point d'arrivée après connexion. Les écrans de 04d § 5.2
 * (sessions, nœuds, clés et quotas, profils, consommation) s'y brancheront avec la tâche 3.6.
 * @page
 */
import { useI18n } from 'vue-i18n';
import { useAuth } from '../auth/store.js';
import SymMessage from '../components/SymMessage.vue';

const { t } = useI18n();
const auth = useAuth();
</script>

<template>
  <section class="mx-auto flex w-full max-w-3xl flex-col gap-6" aria-labelledby="home-title">
    <h1 id="home-title" data-route-heading tabindex="-1" class="text-4xl">{{ t('console.home.title') }}</h1>
    <div class="rounded-xl border border-border bg-card p-6 text-card-foreground">
      <SymMessage :text="t('console.home.welcome')" />
    </div>
    <p v-if="auth.admin.value" class="text-muted-foreground">{{ t('console.common.signedInAs', { email: auth.admin.value.email }) }}</p>
  </section>
</template>
