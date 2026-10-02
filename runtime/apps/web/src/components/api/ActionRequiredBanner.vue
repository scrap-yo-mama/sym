<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ActionRequiredBanner.vue
 * @description « Action requise » présentée comme une tâche (06 § 2) : titre, bouton principal, vérification en direct
 * (flux SSE). Quand l'utilisateur agit (transition 17), le bandeau devient « Reprise de l'enquête… » au lieu de
 * disparaître. Annoncé une fois (`role="alert"`) sans retirer le focus. Aucune relance automatique ; une vérification
 * affichée dans le navigateur de l'utilisateur ne reçoit jamais de réponse (INV6).
 * @component
 * @example <ActionRequiredBanner :detail="detail" :resuming="resuming" />
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { Button } from '@/components/ui/button';
import type { ApiDetail } from '@/composables/useApiDetail';
import { actionCause, actionTitleParams, publisherSiteUrl } from '@/lib/action-required';

const props = defineProps<{ detail: ApiDetail; resuming: boolean }>();
const { t } = useI18n();

const cause = computed(() => (props.detail.status === 'action_requise' ? actionCause(props.detail.status_reason?.code) : null));

/** Mêmes paramètres que la colonne Statut du catalogue (même titre, même verbe). */
const named = computed(() => actionTitleParams(props.detail.status_reason?.params, props.detail.requires.session_domain, t('blockedPanel.thisSite')));

/** Site de l'éditeur (cause « paiement ») : un lien sortant vers le domaine concerné, jamais un appel du serveur. */
const siteUrl = computed(() => publisherSiteUrl(named.value.domain));
</script>

<template>
  <!-- Région `status` toujours présente : la reprise est annoncée poliment, sans voler le focus. -->
  <div role="status" aria-live="polite">
    <p v-if="resuming" class="rounded-lg border border-primary p-3 font-medium" data-testid="action-resuming">
      {{ t('actionRequired.resuming') }}
    </p>
  </div>
  <section v-if="cause && !resuming" role="alert" class="flex flex-col gap-3 rounded-lg border-2 border-primary p-4" data-testid="action-banner" :data-cause="cause.cause">
    <h2 class="text-lg font-semibold">{{ t(`actionRequired.${cause.cause}.title`, named) }}</h2>
    <p v-if="cause.cause === 'challenge' || cause.cause === 'accountLimit' || cause.cause === 'payment'" class="text-sm">{{ t(`actionRequired.${cause.cause}.text`, named) }}</p>
    <div class="flex flex-wrap items-center gap-3">
      <Button v-if="cause.primary?.kind === 'route'" as-child data-testid="action-primary">
        <RouterLink :to="cause.primary.to">{{ t(`actionRequired.${cause.cause}.button`) }}</RouterLink>
      </Button>
      <Button v-else-if="cause.primary?.kind === 'hash'" as-child data-testid="action-primary">
        <a :href="cause.primary.hash">{{ t(`actionRequired.${cause.cause}.button`) }}</a>
      </Button>
      <Button v-else-if="cause.primary?.kind === 'site' && siteUrl" as-child data-testid="action-primary">
        <a :href="siteUrl" target="_blank" rel="noopener noreferrer">{{ t(`actionRequired.${cause.cause}.button`) }}</a>
      </Button>
    </div>
    <p class="text-sm text-muted-foreground" data-testid="action-verify">{{ t(`actionRequired.${cause.cause}.verify`) }}</p>
  </section>
</template>
