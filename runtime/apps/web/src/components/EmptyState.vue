<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file EmptyState.vue
 * @description État vide (06 § 2) : un titre positif, une explication et, au besoin, un bouton (slot `action`). Se
 * distingue visuellement et par son rôle d'une erreur (`ErrorState`). Avec `shapes` (catalogue vide, 20 § 5.2, u3 R5) : carte
 * papier et formes plates de la marque (cercle orange, carré lilas, disque jaune), décoratives et `aria-hidden`, à la place de
 * la boîte en pointillés.
 * @component
 * @example <EmptyState title="Aucune API" description="Crée ta première API." shapes />
 */
withDefaults(defineProps<{ title: string; description: string; shapes?: boolean }>(), { shapes: false });
</script>

<template>
  <section
    class="relative flex flex-col items-start gap-2 p-6"
    :class="shapes ? 'min-h-48 overflow-hidden rounded-xl bg-card text-card-foreground sm:pr-44' : 'rounded-lg border border-dashed'"
    data-testid="empty-state"
  >
    <div v-if="shapes" aria-hidden="true" class="pointer-events-none absolute inset-y-0 right-0 hidden w-40 sm:block" data-testid="empty-shapes">
      <div class="absolute -right-6 -bottom-8 size-28 rounded-full bg-sym-orange" />
      <div class="absolute top-5 right-12 size-16 rotate-18 rounded-[22px] bg-sym-lilac" />
      <div class="absolute right-24 bottom-12 size-9 rounded-full bg-sym-yellow" />
    </div>
    <h2 class="text-lg font-semibold">{{ title }}</h2>
    <p class="text-muted-foreground">{{ description }}</p>
    <slot name="action" />
  </section>
</template>
