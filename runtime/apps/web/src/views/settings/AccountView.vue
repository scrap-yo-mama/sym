<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file AccountView.vue
 * @description Mon compte (06 § 2, 13 § 5 et § 7) : mot de passe, 2FA TOTP, sessions d'interface ouvertes (fermer une, ou toutes les autres ;
 * proposé après un changement de mot de passe ou de 2FA),
 * identités SSO liées, activité récente de son propre compte, réglage Animations (20 § 4.3) ; langue et thème restent dans la barre du haut. Les clés d'API sont dans leur page, l'extension
 * et les appareils dans « Extension et sessions ». Chacun ne voit que son compte : aucune route ici ne renvoie une donnée d'autrui.
 * @page
 */
import { computed, onMounted, onServerPrefetch, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import PasswordPanel from '@/components/account/PasswordPanel.vue';
import TextField from '@/components/account/TextField.vue';
import TwoFactorPanel from '@/components/account/TwoFactorPanel.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useIdentities, useMyAudit, useMySessions } from '@/composables/useAccount';
import { useSsoPublic } from '@/composables/useAccountFlows';
import { persistPreferences, usePreferences } from '@/composables/usePreferences';
import { useSession } from '@/composables/useSession';
import { selectClass } from '@/lib/classes';
import { readFieldValue, takeFieldValue } from '@/lib/form-field';
import { formatDateTime } from '@/lib/format';
import { MOTIONS, isMotion } from '@/lib/motion';

const { t, te, locale } = useI18n();
const route = useRoute();
const { me } = useSession();
const { changeMotion, motion } = usePreferences();

// Fuseau du compte (21b § 1) : IANA, contrôlé par le serveur ; sert aux e-mails, aux messages MCP et au fuseau par défaut d'une
// planification. Jamais déduit de la langue.
const timezone = ref(me.value?.timezone ?? '');
const timezoneStatus = ref<'idle' | 'saved' | 'invalid'>('idle');
const zones: readonly string[] = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
async function saveTimezone(): Promise<void> {
  const value = timezone.value.trim();
  const result = await persistPreferences({ timezone: value === '' ? null : value });
  timezoneStatus.value = result.ok ? 'saved' : 'invalid';
}

function onMotion(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (isMotion(value)) changeMotion(value);
}

const sessions = useMySessions();
const identities = useIdentities();
const activity = useMyAudit();
const { sso, load: loadSso } = useSsoPublic();

onMounted(() => {
  void sessions.reload();
  void identities.reload();
  void loadSso();
});
onServerPrefetch(async () => {
  await Promise.all([sessions.reload(), identities.reload(), activity.refetch()]);
});

const date = (iso: string | null | undefined): string => formatDateTime(iso, locale.value) ?? t('account.sessions.unknown');
const justLinked = computed(() => route.query.sso === 'linked');
const ssoProvider = computed(() => (sso.value?.enabled ? sso.value.providers[0] : undefined));

const linkPassword = ref('');
const linkCode = ref('');
async function link(event: Event): Promise<void> {
  const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : null;
  const url = await identities.startLink(takeFieldValue(form, 'currentPassword', linkPassword), readFieldValue(form, 'code', linkCode.value).trim());
  linkCode.value = '';
  // Redirection de navigateur chez le fournisseur : le retour (`/api/auth/oidc/callback`) lie l'identité.
  if (url) window.location.assign(url);
}

/** Libellé d'une action d'audit ; un code sans traduction s'affiche tel quel (clés avec « _ » au lieu de « . »). */
const actionLabel = (action: string): string => {
  const key = `audit.action.${action.replaceAll('.', '_')}`;
  return te(key) ? t(key) : action;
};
</script>

<template>
  <section class="flex flex-col gap-6" aria-labelledby="account-heading">
    <header class="flex flex-col gap-1">
      <h1 id="account-heading" data-route-heading tabindex="-1" class="sym-title">{{ t('account.title') }}</h1>
      <p class="text-sm text-muted-foreground">{{ t('account.intro') }}</p>
      <p v-if="me" class="text-sm" data-testid="account-identity">{{ me.displayName ? `${me.displayName} · ${me.email}` : me.email }}</p>
    </header>

    <section class="flex flex-col gap-2 rounded-xl border bg-card p-4" aria-labelledby="preferences-heading">
      <h2 id="preferences-heading" class="text-lg font-semibold">{{ t('account.preferences.title') }}</h2>
      <p class="text-sm text-muted-foreground">{{ t('account.preferences.text') }}</p>
      <div class="flex flex-col gap-1">
        <label for="pref-motion" class="text-sm font-medium">{{ t('account.preferences.motion') }}</label>
        <select id="pref-motion" class="max-w-xs" :class="selectClass" :value="motion" aria-describedby="pref-motion-hint" @change="onMotion">
          <option v-for="name in MOTIONS" :key="name" :value="name">{{ t(`account.preferences.motions.${name}`) }}</option>
        </select>
        <p id="pref-motion-hint" class="text-sm text-muted-foreground">{{ t('account.preferences.motionHint') }}</p>
      </div>
      <div class="flex flex-col gap-1">
        <label for="pref-timezone" class="text-sm font-medium">{{ t('account.preferences.timezone') }}</label>
        <div class="flex flex-wrap items-center gap-2">
          <input id="pref-timezone" v-model="timezone" list="pref-timezone-list" class="max-w-xs" :class="selectClass" autocomplete="off" spellcheck="false" aria-describedby="pref-timezone-hint" data-testid="timezone-input" />
          <datalist id="pref-timezone-list"><option v-for="zone in zones" :key="zone" :value="zone" /></datalist>
          <Button type="button" variant="outline" size="sm" data-testid="timezone-save" @click="saveTimezone">{{ t('account.preferences.timezoneSave') }}</Button>
        </div>
        <p id="pref-timezone-hint" class="text-sm text-muted-foreground">{{ t('account.preferences.timezoneHint') }}</p>
        <p v-if="timezoneStatus === 'saved'" role="status" class="text-sm">{{ t('account.preferences.timezoneSaved') }}</p>
        <p v-else-if="timezoneStatus === 'invalid'" role="alert" class="sym-error">{{ t('account.preferences.timezoneInvalid') }}</p>
      </div>
    </section>

    <PasswordPanel @sessions-closed="sessions.reload()" />

    <TwoFactorPanel @sessions-closed="sessions.reload()" />

    <section class="flex flex-col gap-3 rounded-xl border bg-card p-4" aria-labelledby="sessions-heading" data-testid="sessions-panel">
      <h2 id="sessions-heading" class="text-lg font-semibold">{{ t('account.sessions.title') }}</h2>
      <p class="text-sm text-muted-foreground">{{ t('account.sessions.intro') }}</p>
      <Alert v-if="sessions.actionFailure.value" variant="destructive"><AlertDescription>{{ t(sessions.actionFailure.value) }}</AlertDescription></Alert>
      <p v-if="sessions.loading.value && !sessions.data.value" role="status" class="text-sm text-muted-foreground">{{ t('ui.loading') }}</p>
      <p v-else-if="sessions.failure.value" class="sym-error">{{ t(sessions.failure.value) }}</p>
      <div v-else-if="sessions.sessions.value.length > 0" class="relative overflow-x-auto rounded-xl border">
        <table class="w-full text-left text-sm">
          <caption class="sr-only">{{ t('account.sessions.caption') }}</caption>
          <thead class="border-b bg-muted/50">
            <tr>
              <th scope="col" class="p-3 font-medium">{{ t('account.sessions.device') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('account.sessions.address') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('account.sessions.started') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('account.sessions.lastSeen') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('account.sessions.expires') }}</th>
              <th scope="col" class="p-3 font-medium"><span class="sr-only">{{ t('account.sessions.close') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="session in sessions.sessions.value" :key="session.id" class="border-b last:border-0" data-testid="session-row">
              <th scope="row" class="max-w-64 truncate p-3 font-normal" :title="session.user_agent ?? undefined">
                {{ session.user_agent ?? t('account.sessions.unknown') }}
                <span v-if="session.current" class="block text-xs font-medium">{{ t('account.sessions.current') }}</span>
              </th>
              <td class="p-3">{{ session.ip ?? t('account.sessions.unknown') }}</td>
              <td class="p-3">{{ date(session.created_at) }}</td>
              <td class="p-3">{{ date(session.last_seen_at) }}</td>
              <td class="p-3">{{ date(session.expires_at) }}</td>
              <td class="p-3">
                <Button v-if="!session.current" type="button" variant="outline" size="sm" @click="sessions.close(session.id)">{{ t('account.sessions.close') }}</Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="sessions.sessions.value.filter((entry) => !entry.current).length === 0 && !sessions.loading.value && sessions.data.value" class="text-sm text-muted-foreground" data-testid="sessions-none">{{ t('account.sessions.none') }}</p>
      <div v-if="sessions.sessions.value.some((entry) => !entry.current)">
        <Button type="button" variant="outline" size="sm" data-testid="sessions-close-others" @click="sessions.closeOthers()">{{ t('account.sessions.closeOthers') }}</Button>
      </div>
    </section>

    <section v-if="ssoProvider || identities.identities.value.length > 0" class="flex flex-col gap-3 rounded-xl border bg-card p-4" aria-labelledby="identities-heading" data-testid="identities-panel">
      <h2 id="identities-heading" class="text-lg font-semibold">{{ t('account.identities.title') }}</h2>
      <p class="text-sm text-muted-foreground">{{ t('account.identities.intro') }}</p>
      <p v-if="justLinked" role="status" class="text-sm">{{ t('account.identities.justLinked') }}</p>
      <Alert v-if="identities.actionFailure.value" variant="destructive"><AlertDescription>{{ t(identities.actionFailure.value) }}</AlertDescription></Alert>
      <p v-if="identities.identities.value.length === 0" class="text-sm text-muted-foreground">{{ t('account.identities.none') }}</p>
      <div v-else class="relative overflow-x-auto rounded-xl border">
        <table class="w-full text-left text-sm">
          <caption class="sr-only">{{ t('account.identities.caption') }}</caption>
          <thead class="border-b bg-muted/50">
            <tr>
              <th scope="col" class="p-3 font-medium">{{ t('account.identities.provider') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('account.identities.issuer') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('account.identities.linked') }}</th>
              <th scope="col" class="p-3 font-medium"><span class="sr-only">{{ t('account.identities.unlink') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="identity in identities.identities.value" :key="identity.id" class="border-b last:border-0">
              <th scope="row" class="p-3 font-normal">{{ identity.provider }}</th>
              <td class="p-3 break-all">{{ identity.issuer }}</td>
              <td class="p-3">{{ date(identity.created_at) }}</td>
              <td class="p-3"><Button type="button" variant="outline" size="sm" @click="identities.unlink(identity.id)">{{ t('account.identities.unlink') }}</Button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <form v-if="ssoProvider" class="flex flex-col gap-3" novalidate @submit.prevent="link">
        <TextField id="link-password" v-model="linkPassword" :label="t('account.identities.password')" :hint="t('account.twoFactor.passwordHint')" type="password" name="currentPassword" class="max-w-xs" autocomplete="current-password" />
        <TextField v-if="me?.mfaEnabled" id="link-code" v-model="linkCode" :label="t('account.identities.code')" name="code" class="max-w-xs" inputmode="numeric" autocomplete="one-time-code" />
        <div><Button type="submit" variant="outline">{{ t('account.identities.link', { provider: ssoProvider.label || ssoProvider.slug }) }}</Button></div>
      </form>
    </section>

    <section class="flex flex-col gap-3 rounded-xl border bg-card p-4" aria-labelledby="activity-heading" data-testid="activity-panel">
      <h2 id="activity-heading" class="text-lg font-semibold">{{ t('account.activity.title') }}</h2>
      <p v-if="activity.loading.value && !activity.loaded.value" role="status" class="text-sm text-muted-foreground">{{ t('ui.loading') }}</p>
      <p v-else-if="activity.items.value.length === 0" class="text-sm text-muted-foreground">{{ t('account.activity.empty') }}</p>
      <div v-else class="relative overflow-x-auto rounded-xl border">
        <table class="w-full text-left text-sm">
          <caption class="sr-only">{{ t('account.activity.caption') }}</caption>
          <thead class="border-b bg-muted/50">
            <tr>
              <th scope="col" class="p-3 font-medium">{{ t('audit.columns.at') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('audit.columns.action') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('audit.columns.outcome') }}</th>
              <th scope="col" class="p-3 font-medium">{{ t('audit.columns.address') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="event in activity.items.value" :key="event.id" class="border-b last:border-0">
              <th scope="row" class="p-3 font-normal">{{ date(event.at) }}</th>
              <td class="p-3">{{ actionLabel(event.action) }}</td>
              <td class="p-3">{{ t(`audit.outcomes.${event.outcome}`) }}</td>
              <td class="p-3">{{ event.ip ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="activity.hasMore()"><Button type="button" variant="outline" size="sm" :disabled="activity.loadingMore.value" @click="activity.loadMore()">{{ t('ui.loadMore') }}</Button></div>
    </section>
  </section>
</template>
