<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file EmptyState.vue
 * @description État vide (06 § 2) : un titre positif, une explication et, au besoin, un bouton (slot `action`). Se
 * distingue visuellement et par son rôle d'une erreur (`ErrorState`).
 * @component
 * @example <EmptyState title="Aucune API" description="Crée ta première API." />
 */
defineProps<{ title: string; description: string }>();
</script>

<template>
  <section class="flex flex-col items-start gap-2 rounded-lg border border-dashed p-6" data-testid="empty-state">
    <h2 class="text-lg font-semibold">{{ title }}</h2>
    <p class="text-muted-foreground">{{ description }}</p>
    <slot name="action" />
  </section>
</template>
