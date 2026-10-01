<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
</script>

<template>
  <section class="mx-auto flex max-w-3xl flex-col gap-3 py-10">
    <h1 data-route-heading tabindex="-1" class="text-2xl font-semibold tracking-tight">{{ t('home.title') }}</h1>
    <p class="text-muted-foreground">{{ t('home.empty') }}</p>
  </section>
</template>
