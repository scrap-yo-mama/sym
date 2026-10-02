<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file PageHeader.vue
 * @description En-tête d'écran dans le langage des planches (3.21, 20 § 1.2) : pastille de rubrique, titre Bricolage de 44 à 54 px
 * (le titre de premier niveau de la route, cible du focus programmatique) et phrase d'appui en slot. Aucune signature : celle de la marque est
 * dans la barre de navigation.
 * @component
 * @example <PageHeader :title="t('runs.title')" :kicker="t('brand.kicker.runs')"><p class="sym-lead">…</p></PageHeader>
 */
defineProps<{ title: string; kicker?: string; headingId?: string }>();
</script>

<template>
  <header class="flex flex-col gap-2.5">
    <p v-if="kicker" class="sym-kicker" data-testid="page-kicker">{{ kicker }}</p>
    <h1 :id="headingId" data-route-heading tabindex="-1" class="sym-title"><slot name="title">{{ title }}</slot></h1>
    <slot />
  </header>
</template>
