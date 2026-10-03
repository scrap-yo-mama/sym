<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file HomeView.vue
 * @description Accueil de la console connectée (tâche 3.5) : point d'arrivée après connexion, avec les liens vers les écrans de
 * 04d § 5.2 (tâche 3.6) : sessions, nœuds, clés et quotas, profils, consommation.
 * @page
 */
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { useAuth } from '../auth/store.js';
import SymMessage from '../components/SymMessage.vue';

const { t } = useI18n();
const auth = useAuth();
const SECTIONS = ['sessions', 'nodes', 'keys', 'profiles', 'usage'] as const;
</script>

<template>
  <section class="mx-auto flex w-full max-w-5xl flex-col gap-6" aria-labelledby="home-title">
    <h1 id="home-title" data-route-heading tabindex="-1" class="text-4xl">{{ t('console.home.title') }}</h1>
    <div class="rounded-xl border border-border bg-card p-6 text-card-foreground">
      <SymMessage :text="t('console.home.welcome')" />
    </div>
    <p v-if="auth.admin.value" class="text-muted-foreground">{{ t('console.common.signedInAs', { email: auth.admin.value.email }) }}</p>
    <h2 class="sr-only">{{ t('console.home.sections') }}</h2>
    <ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <li v-for="section in SECTIONS" :key="section">
        <RouterLink :to="`/${section}`" class="flex h-full min-h-11 flex-col gap-1 rounded-xl border border-border bg-card p-4 text-card-foreground hover:border-primary">
          <span class="font-display text-xl font-extrabold text-primary underline underline-offset-4">{{ t(`console.nav.${section}`) }}</span>
          <span>{{ t(`console.home.${section}`) }}</span>
        </RouterLink>
      </li>
    </ul>
  </section>
</template>
