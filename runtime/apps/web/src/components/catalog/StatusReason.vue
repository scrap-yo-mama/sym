<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file StatusReason.vue
 * @description Raison d'un statut, en texte visible sur sa propre ligne (06 § 2) : ni survol ni focus requis, car le
 * survol n'existe ni au clavier ni au tactile. Le code stable reçu de l'API est traduit ; code inconnu ou absent : phrase
 * générique du statut. Toute raison porte son nombre quand le serveur en fournit un. Avec `task` (colonne Statut du
 * catalogue), une « Action requise » de cause connue affiche le titre de la tâche, le même verbe que le bandeau de la fiche.
 * @component
 * @example <StatusReason status="sain" :reason="{ code: 'escalated', params: {} }" />
 * @example <StatusReason status="action_requise" :reason="reason" task session-domain="monsite.example" />
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { actionCause, actionTitleParams } from '@/lib/action-required';
import { describeReason, type ReasonMessage } from '@/lib/reasons';
import type { ApiStatus } from '@/lib/status';

const props = defineProps<{ status: ApiStatus; reason: ReasonMessage | null | undefined; task?: boolean; sessionDomain?: string | null }>();
const { t, te, locale } = useI18n();
const text = computed(() => {
  const cause = props.task && props.status === 'action_requise' ? actionCause(props.reason?.code) : null;
  if (cause) return t(`actionRequired.${cause.cause}.title`, actionTitleParams(props.reason?.params, props.sessionDomain, t('blockedPanel.thisSite')));
  return describeReason((key, named) => t(key, named ?? {}), te, locale.value, props.status, props.reason);
});
</script>

<template>
  <p class="text-sm text-muted-foreground" data-testid="status-reason" :data-reason-code="reason?.code ?? ''">{{ text }}</p>
</template>
