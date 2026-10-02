<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file App.vue
 * @description Cadre de la console (04d § 5.1 et § 5.4) : lien d'évitement, barre anthracite arrondie en pilule (signature
 * SYM de packages/ui, langue, déconnexion), contenu principal. À chaque changement de page : titre du document mis à jour et
 * focus posé sur le <h1> de la page (sauf au premier affichage), pour les lecteurs d'écran et le clavier.
 * @component
 */
import { SymSignature } from '@runtime/ui';
import { computed, nextTick, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterView, useRoute, useRouter } from 'vue-router';
import { useAuth } from './auth/store.js';
import ConsoleButton from './components/ConsoleButton.vue';
import LocaleSwitcher from './components/LocaleSwitcher.vue';

const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuth();

const signedIn = computed(() => auth.state.value === 'authenticated' && auth.admin.value !== null);

watch(
  [() => route.meta.titleKey, locale],
  ([titleKey]) => {
    if (typeof document === 'undefined' || !titleKey) return;
    document.title = `${t(titleKey)} · ${t('console.common.titleSuffix')}`;
  },
  { immediate: true },
);

let firstPage = true;
watch(
  () => route.fullPath,
  async () => {
    if (firstPage) {
      firstPage = false;
      return;
    }
    await nextTick();
    if (typeof document !== 'undefined') document.querySelector<HTMLElement>('[data-route-heading]')?.focus();
  },
);

// Session expirée pendant la lecture d'une page protégée (401 d'une requête authentifiée) : retour à /login, puis ici.
watch(
  () => auth.state.value,
  (state) => {
    if (state !== 'authenticated' && route.meta.requiresAuth) void router.replace({ name: 'login', query: { redirect: route.fullPath } });
  },
);

async function signOut(): Promise<void> {
  await auth.logout();
  await router.replace({ name: 'login' });
}
</script>

<template>
  <a
    href="#main"
    class="sr-only z-50 rounded-md bg-signature px-4 py-2 font-bold text-signature-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
  >
    {{ t('console.common.skipToContent') }}
  </a>
  <div class="flex min-h-screen flex-col" data-console-root>
    <header class="px-4 pt-4">
      <div class="sym-on-ink mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 rounded-[2rem] bg-nav px-4 py-2 text-nav-foreground sm:rounded-full">
        <p class="flex items-center gap-2 font-display text-lg font-extrabold">
          <SymSignature variant="badge" :locale="locale === 'fr' ? 'fr' : 'en'" />
          <span>{{ t('console.common.product') }}</span>
        </p>
        <div class="ms-auto flex flex-wrap items-center gap-x-4 gap-y-2">
          <LocaleSwitcher />
          <ConsoleButton v-if="signedIn" type="button" variant="outline" size="sm" @click="signOut">{{ t('console.common.signOut') }}</ConsoleButton>
        </div>
      </div>
    </header>
    <main id="main" tabindex="-1" class="flex-1 px-4 py-10 outline-none">
      <RouterView />
    </main>
  </div>
</template>
