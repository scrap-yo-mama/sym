<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// Accueil de la console (`/`), où mène l'assistant de premier démarrage : tant que le contact du robot manque, le bandeau le
// dit ici aussi (UX-06), pas seulement dans le catalogue et « Nouvelle API ».
import { useI18n } from 'vue-i18n';
import InstanceContactBanner from '@/components/InstanceContactBanner.vue';

const { t } = useI18n();
</script>

<template>
  <section class="mx-auto flex max-w-3xl flex-col gap-3 py-10">
    <h1 data-route-heading tabindex="-1" class="text-2xl font-semibold tracking-tight">{{ t('home.title') }}</h1>
    <InstanceContactBanner />
    <p class="text-muted-foreground">{{ t('home.empty') }}</p>
  </section>
</template>
