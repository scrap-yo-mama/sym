<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, watch, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import ConnectionBanner from '@/components/ConnectionBanner.vue';
import PreferencesBar from '@/components/PreferencesBar.vue';
import { Button } from '@/components/ui/button';
import { startEventStream, stopEventStream, useEventStream } from '@/composables/useEventStream';
import { applyAccountPreferences } from '@/composables/usePreferences';
import { markExpired, signOut, useSession } from '@/composables/useSession';

const i18n = useI18n();
const { t, locale } = i18n;
const route = useRoute();
const router = useRouter();
const { isAuthenticated, me } = useSession();
const { streamStatus } = useEventStream();

/** Entrées de la navigation principale (06 § 1). Les comptes s'y ajoutent avec 3.8. */
const NAV = [
  { to: '/', label: 'nav.home' },
  { to: '/apis', label: 'nav.catalog' },
  { to: '/apis/new', label: 'nav.newApi' },
  { to: '/runs', label: 'nav.runs' },
  { to: '/settings', label: 'nav.settings' },
] as const;

const displayName = computed(() => me.value?.displayName || me.value?.email || '');

// Titre du document traduit, mis à jour à chaque route et à chaque changement de langue (06 § 1).
watchEffect(() => {
  void locale.value;
  const key = route.meta.titleKey;
  document.title = key ? `${t(key)} · ${t('app.titleSuffix')}` : t('app.name');
});

// Flux SSE unique de l'onglet : ouvert tant que la session est authentifiée. Une session perdue renvoie à la connexion.
watch(
  isAuthenticated,
  (authenticated) => {
    if (authenticated) {
      startEventStream(markExpired);
    } else {
      stopEventStream();
      if (route.meta.public !== true && route.name !== undefined) {
        void router.replace({ name: 'login', query: route.fullPath === '/' ? {} : { redirect: route.fullPath } });
      }
    }
  },
  { immediate: true },
);

// Préférences du compte (langue, thème) appliquées une fois à la connexion.
watch(
  me,
  (account) => {
    if (account) void applyAccountPreferences(i18n, account);
  },
  { immediate: true },
);

function focusMain(): void {
  document.getElementById('main')?.focus();
}
</script>

<template>
  <a
    href="#main"
    class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
    @click.prevent="focusMain"
  >
    {{ t('app.skipToContent') }}
  </a>
  <ConnectionBanner :status="streamStatus" />
  <header class="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
    <p class="text-lg font-semibold tracking-tight">{{ t('app.name') }}</p>
    <nav v-if="isAuthenticated" :aria-label="t('nav.main')">
      <ul class="flex flex-wrap items-center gap-1">
        <li v-for="entry in NAV" :key="entry.to">
          <RouterLink :to="entry.to" class="flex min-h-11 items-center rounded-md px-3 text-sm hover:bg-accent" active-class="bg-accent font-medium">{{ t(entry.label) }}</RouterLink>
        </li>
      </ul>
    </nav>
    <div class="flex flex-wrap items-center gap-3">
      <PreferencesBar />
      <template v-if="isAuthenticated">
        <span class="text-sm text-muted-foreground">{{ t('nav.signedInAs', { name: displayName }) }}</span>
        <Button variant="outline" size="sm" data-testid="sign-out" @click="signOut()">{{ t('nav.signOut') }}</Button>
      </template>
    </div>
  </header>
  <main id="main" tabindex="-1" class="px-4 outline-none">
    <RouterView />
  </main>
</template>
