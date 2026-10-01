<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';

const { t } = useI18n();
</script>

<template>
  <section class="mx-auto flex max-w-3xl flex-col items-start gap-3 py-10">
    <h1 data-route-heading tabindex="-1" class="text-2xl font-semibold tracking-tight">{{ t('notFound.title') }}</h1>
    <RouterLink to="/" class="text-primary underline underline-offset-4">{{ t('notFound.back') }}</RouterLink>
  </section>
</template>
