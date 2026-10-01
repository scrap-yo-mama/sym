<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file AccountNotices.vue
 * @description Signalements au titulaire du compte, montrés une fois après une authentification complète (13 § 4, 13 § 6) :
 * lien de réinitialisation émis par l'opérateur du serveur, lien par e-mail retenu après un changement de relais. Le serveur
 * envoie un code stable et une date ; le texte est celui de la console. Annoncé en `role="status"` sans prendre le focus.
 * @component
 * @example <AccountNotices />
 */
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { dismissNotices, useSession } from '@/composables/useSession';
import { formatDateTime } from '@/lib/format';

const { t, te, locale } = useI18n();
const { notices } = useSession();

function text(notice: { code: string; at: string }): string {
  const date = formatDateTime(notice.at, locale.value) ?? notice.at;
  return te(`account.notice.codes.${notice.code}`) ? t(`account.notice.codes.${notice.code}`, { date }) : t('account.notice.unknown', { code: notice.code, date });
}
</script>

<template>
  <div v-if="notices.length > 0" class="flex flex-col gap-2 border-b px-4 py-3" role="status" :aria-label="t('account.notice.title')" data-testid="account-notices">
    <p v-for="notice in notices" :key="`${notice.code}-${notice.at}`" class="text-sm">{{ text(notice) }}</p>
    <div><Button type="button" variant="outline" size="sm" @click="dismissNotices()">{{ t('account.notice.dismiss') }}</Button></div>
  </div>
</template>
