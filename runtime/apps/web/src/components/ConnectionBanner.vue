<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { StreamStatus } from '@/lib/sse';

defineProps<{ status: StreamStatus }>();
const { t } = useI18n();
</script>

<template>
  <!--
    Région `status` toujours présente (une région ajoutée en même temps que son texte n'est pas toujours annoncée).
    Le bandeau ne prend jamais le focus (06 § 3) et disparaît à la reprise du flux.
  -->
  <div role="status" aria-live="polite" data-testid="connection-banner">
    <p v-if="status === 'reconnecting'" class="border-b bg-secondary px-4 py-2 text-sm text-secondary-foreground">
      {{ t('stream.reconnecting') }}
    </p>
  </div>
</template>
