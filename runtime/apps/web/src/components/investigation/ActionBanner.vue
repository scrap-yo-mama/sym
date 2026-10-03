<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ActionBanner.vue
 * @description Bandeau « Action requise » d'une enquête (06 § 2) : présenté comme une tâche (titre, bouton principal,
 * vérification en direct par le flux SSE). Quand l'utilisateur agit (transition 17), le bandeau devient « Reprise de
 * l'enquête… » au lieu de disparaître. Une vérification rencontrée dans le navigateur de l'utilisateur ne propose jamais de
 * reprise automatique ni de prise de contrôle : seule une nouvelle action de l'utilisateur relance une enquête.
 * @component
 * @example <ActionBanner :action="state.action" @reinvestigate="reinvestigate" />
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { Button } from '@/components/ui/button';
import type { ActionCause, ActionView } from '@/lib/investigation';

interface Props {
  action: ActionView;
}

const props = defineProps<Props>();

interface Emits {
  /** Nouvelle action de l'utilisateur : relancer une enquête (`challenge_in_tunnel`). */
  (e: 'reinvestigate'): void;
}
const emit = defineEmits<Emits>();

const { t, te } = useI18n();

/** Page des réglages qui porte l'action principale de chaque cause ; null : relance manuelle ou aucune action. */
const TARGETS: Record<ActionCause, string | null> = {
  auth_required: '/settings/extension',
  cookie_expired: '/settings/extension',
  session_device_bound: '/settings/extension',
  proxy_required: '/settings/proxies',
  tunnel_offline: '/settings/extension',
  instance_contact_missing: '/settings/robot',
  llm_price_missing: '/settings/models',
  challenge_in_tunnel: null,
  secret_unreadable: '/settings/models',
  payment_required: null,
  account_limit: null,
};

const target = computed(() => TARGETS[props.action.cause]);
const params = computed(() => ({
  domain: props.action.domain ?? t('blocked.unknownDomain'),
  platform: props.action.platform ?? props.action.domain ?? t('blocked.unknownDomain'),
  offer: props.action.offer ?? '—',
  model: props.action.model ?? t('action.modelUnnamed'),
}));
const hasButton = computed(() => te(`action.${props.action.cause}.button`));
</script>

<template>
  <div class="flex flex-col gap-2 rounded-xl border-2 p-4" role="alert" data-testid="action-banner" :data-cause="action.cause">
    <template v-if="action.resuming">
      <p class="font-medium" data-testid="action-resuming">{{ t('action.resuming') }}</p>
    </template>
    <template v-else>
      <p class="flex items-start gap-2 font-medium">
        <!-- Point d'exclamation dans un losange : forme propre à « Action requise » -->
        <span aria-hidden="true">◆!</span>
        <span>{{ t(`action.${action.cause}.title`, params) }}</span>
      </p>
      <p class="text-sm text-muted-foreground">{{ t(`action.${action.cause}.body`, params) }}</p>
      <div v-if="hasButton">
        <Button v-if="target" as-child><RouterLink :to="target">{{ t(`action.${action.cause}.button`) }}</RouterLink></Button>
        <Button v-else type="button" @click="emit('reinvestigate')">{{ t(`action.${action.cause}.button`) }}</Button>
      </div>
    </template>
  </div>
</template>
