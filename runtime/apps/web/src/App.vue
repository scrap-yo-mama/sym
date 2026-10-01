<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, watch, watchEffect } from 'vue';
import { SymSignature } from '@runtime/ui';
import { useI18n } from 'vue-i18n';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import AccountNotices from '@/components/account/AccountNotices.vue';
import ConnectionBanner from '@/components/ConnectionBanner.vue';
import PreferencesBar from '@/components/PreferencesBar.vue';
import { Button } from '@/components/ui/button';
import { startEventStream, stopEventStream, useEventStream } from '@/composables/useEventStream';
import { applyAccountPreferences } from '@/composables/usePreferences';
import { markExpired, signOut, useSession } from '@/composables/useSession';
import { visibleNav } from '@/lib/nav';

const i18n = useI18n();
const { t, locale } = i18n;
const route = useRoute();
const router = useRouter();
const { isAuthenticated, mustEnrollTwoFactor, state, me, can } = useSession();
const { streamStatus } = useEventStream();

/** Entrées de la navigation : Utilisateurs et Audit selon `can()` ; aucune avant l'enrôlement forcé à la 2FA (lib/nav.ts). */
const navEntries = computed(() => visibleNav(can, mustEnrollTwoFactor.value));
/** Bandeau « tu es owner / admin » (06 § 2) : seul un rôle qui administre l'instance le voit. */
const roleBanner = computed(() => (me.value?.role === 'owner' || me.value?.role === 'admin' ? `nav.roleBanner.${me.value.role}` : null));

/** Classe de l'entrée courante ; « Mon compte » vit sous /settings mais n'allume pas aussi « Réglages ». */
function activeClass(to: string): string {
  return to === '/settings' && route.path.startsWith('/settings/account') ? 'router-link-active' : 'bg-accent font-bold text-nav-foreground';
}

const displayName = computed(() => me.value?.displayName || me.value?.email || '');

// Titre du document traduit, mis à jour à chaque route et à chaque changement de langue (06 § 1).
watchEffect(() => {
  void locale.value;
  const key = route.meta.titleKey;
  document.title = key ? `${t(key)} · ${t('app.titleSuffix')}` : t('app.name');
});

// Flux SSE unique de l'onglet : ouvert tant que la session est authentifiée et complète (pas d'enrôlement 2FA forcé en attente).
// Une session perdue renvoie à la connexion ; un second facteur attendu ou un enrôlement exigé en cours de route mène à l'écran concerné.
watch(
  [isAuthenticated, mustEnrollTwoFactor, state],
  ([authenticated, mustEnroll]) => {
    if (authenticated && !mustEnroll) {
      startEventStream(markExpired);
      return;
    }
    stopEventStream();
    if (route.name === undefined || route.meta.public === true || route.meta.open === true) return;
    if (authenticated) {
      if (route.name !== 'two-factor-setup') void router.replace({ name: 'two-factor-setup' });
    } else if (state.value === 'mfa_pending') {
      void router.replace({ name: 'login', query: { mfa: '1' } });
    } else if (state.value === 'not_initialized') {
      void router.replace({ name: 'setup' });
    } else {
      void router.replace({ name: 'login', query: route.fullPath === '/' ? {} : { redirect: route.fullPath } });
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
  <!-- Barre de navigation anthracite de la maquette (20 § 5) ; `sym-on-ink` donne à ses textes et contrôles les jetons du thème sombre, et à `bg-nav` l’anthracite de la maquette en clair (surface relevée en sombre). -->
  <header class="sym-on-ink mx-3 mt-3 mb-2 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-nav px-4 py-3 text-nav-foreground sm:mx-4 sm:px-6">
    <div class="flex items-center gap-2.5">
      <p class="font-display text-[22px] leading-none font-extrabold tracking-tight">{{ t('app.name') }}</p>
      <SymSignature variant="badge" />
    </div>
    <nav v-if="isAuthenticated && navEntries.length > 0" :aria-label="t('nav.main')">
      <ul class="flex flex-wrap items-center gap-1">
        <li v-for="entry in navEntries" :key="entry.to">
          <RouterLink :to="entry.to" class="flex min-h-11 items-center rounded-md px-3 text-sm text-nav-muted-foreground hover:bg-accent hover:text-nav-foreground" :active-class="activeClass(entry.to)">{{ t(entry.label) }}</RouterLink>
        </li>
      </ul>
    </nav>
    <div class="flex flex-wrap items-center gap-3">
      <PreferencesBar />
      <template v-if="isAuthenticated">
        <span class="text-sm text-nav-muted-foreground">{{ t('nav.signedInAs', { name: displayName }) }}</span>
        <Button variant="outline" size="sm" data-testid="sign-out" @click="signOut()">{{ t('nav.signOut') }}</Button>
      </template>
    </div>
  </header>
  <p v-if="isAuthenticated && roleBanner" class="border-b bg-muted/50 px-4 py-2 text-sm" data-testid="role-banner">{{ t(roleBanner) }}</p>
  <AccountNotices v-if="isAuthenticated" />
  <main id="main" tabindex="-1" class="px-4 outline-none">
    <RouterView />
  </main>
</template>
