<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file SettingsView.vue
 * @description Réglages BYO (06 § 2) : modèles IA, proxys, extension et sessions, alertes, diagnostic. Cadre commun des
 * sous-pages. Les secrets ne s'affichent jamais : masque et remplacement seul (INV8).
 * @page
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, RouterView } from 'vue-router';
import { useSession, type Permission } from '@/composables/useSession';

const { t } = useI18n();
const { can } = useSession();
/** Sections des réglages (06 § 1, figure 1). Sécurité et SSO n'apparaissent que si `can()` l'autorise (owner, 13 § 2). */
const SECTIONS: readonly { id: string; permission?: Permission }[] = [
  { id: 'models' },
  { id: 'proxies' },
  { id: 'extension' },
  { id: 'keys' },
  { id: 'alerts' },
  { id: 'diagnostic' },
  { id: 'account' },
  { id: 'security', permission: 'settings:security:write' },
  { id: 'sso', permission: 'settings:sso:write' },
];
const sections = computed(() => SECTIONS.filter((section) => !section.permission || can(section.permission)));
</script>

<template>
  <div class="mx-auto flex max-w-5xl flex-col gap-6 py-8 md:flex-row">
    <nav :aria-label="t('settings.nav.label')" class="md:w-56 md:shrink-0">
      <ul class="flex flex-wrap gap-1 md:flex-col">
        <li v-for="section in sections" :key="section.id">
          <RouterLink
            :to="`/settings/${section.id}`"
            class="flex min-h-11 items-center rounded-md px-3 text-sm hover:bg-accent"
            active-class="bg-accent font-medium"
            aria-current-value="page"
          >
            {{ t(`settings.nav.${section.id}`) }}
          </RouterLink>
        </li>
      </ul>
    </nav>
    <div class="min-w-0 flex-1">
      <RouterView />
    </div>
  </div>
</template>
