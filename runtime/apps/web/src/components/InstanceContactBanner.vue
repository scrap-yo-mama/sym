<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file InstanceContactBanner.vue
 * @description Bandeau « contact du robot manquant » (UX-06, 17 § 5) : le contact de l'opérateur est requis avant la première
 * enquête ; tant qu'il manque, le catalogue et « Nouvelle API » le disent et mènent à Réglages > Identité du robot. Région
 * `status` toujours présente ; le bandeau ne prend jamais le focus.
 */
import { onMounted, onServerPrefetch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { useInstanceContactStatus } from '@/composables/useInstanceContactStatus';

const { t } = useI18n();
const { missing, load } = useInstanceContactStatus();
onMounted(() => void load());
onServerPrefetch(() => load());
</script>

<template>
  <div role="status" aria-live="polite" class="contents" data-testid="instance-contact-status">
    <div v-if="missing" class="flex flex-col gap-2 rounded-xl border-2 border-foreground bg-card p-4" data-testid="instance-contact-banner">
      <p class="font-medium">{{ t('instanceContactBanner.title') }}</p>
      <p class="text-sm">{{ t('instanceContactBanner.text') }}</p>
      <RouterLink to="/settings/robot" class="min-h-11 self-start py-2 text-sm font-bold underline underline-offset-4">{{ t('instanceContactBanner.link') }}</RouterLink>
    </div>
  </div>
</template>
