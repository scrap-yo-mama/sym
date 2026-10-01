<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file StatusReason.vue
 * @description Raison d'un statut, en texte visible sur sa propre ligne (06 § 2) : ni survol ni focus requis, car le
 * survol n'existe ni au clavier ni au tactile. Le code stable reçu de l'API est traduit ; code inconnu ou absent : phrase
 * générique du statut. Toute raison porte son nombre quand le serveur en fournit un.
 * @component
 * @example <StatusReason status="sain" :reason="{ code: 'escalated', params: {} }" />
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { describeReason, type ReasonMessage } from '@/lib/reasons';
import type { ApiStatus } from '@/lib/status';

const props = defineProps<{ status: ApiStatus; reason: ReasonMessage | null | undefined }>();
const { t, te, locale } = useI18n();
const text = computed(() => describeReason((key, named) => t(key, named ?? {}), te, locale.value, props.status, props.reason));
</script>

<template>
  <p class="text-sm text-muted-foreground" data-testid="status-reason" :data-reason-code="reason?.code ?? ''">{{ text }}</p>
</template>
