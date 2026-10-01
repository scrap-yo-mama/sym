<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file SettingsView.vue
 * @description Réglages BYO (06 § 2) : modèles IA, proxys, extension et sessions, alertes, diagnostic. Cadre commun des
 * sous-pages. Les secrets ne s'affichent jamais : masque et remplacement seul (INV8).
 * @page
 */
import { useI18n } from 'vue-i18n';
import { RouterLink, RouterView } from 'vue-router';

const { t } = useI18n();
const SECTIONS = ['models', 'proxies', 'extension', 'alerts', 'diagnostic'] as const;
</script>

<template>
  <div class="mx-auto flex max-w-5xl flex-col gap-6 py-8 md:flex-row">
    <nav :aria-label="t('settings.nav.label')" class="md:w-56 md:shrink-0">
      <ul class="flex flex-wrap gap-1 md:flex-col">
        <li v-for="section in SECTIONS" :key="section">
          <RouterLink
            :to="`/settings/${section}`"
            class="flex min-h-11 items-center rounded-md px-3 text-sm hover:bg-accent"
            active-class="bg-accent font-medium"
            aria-current-value="page"
          >
            {{ t(`settings.nav.${section}`) }}
          </RouterLink>
        </li>
      </ul>
    </nav>
    <div class="min-w-0 flex-1">
      <RouterView />
    </div>
  </div>
</template>
