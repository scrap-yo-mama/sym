<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file JsonTree.vue
 * @description Arbre de lecture d'une valeur JSON (schémas d'entrée et de sortie, spécification de stratégie). Les nœuds
 * se déplient par `<details>` natifs (clavier et lecteur d'écran sans code), les valeurs sont insérées comme texte
 * (jamais en HTML : le contenu peut venir d'un site scrapé).
 * @component
 * @example <JsonTree :value="detail.output_schema" />
 */
import { computed } from 'vue';

const props = withDefaults(defineProps<{ value: unknown; name?: string | null; depth?: number }>(), { name: null, depth: 0 });

const isContainer = computed(() => typeof props.value === 'object' && props.value !== null);
const entries = computed<[string, unknown][]>(() => {
  if (Array.isArray(props.value)) return props.value.map((entry, index) => [String(index), entry]);
  if (typeof props.value === 'object' && props.value !== null) return Object.entries(props.value as Record<string, unknown>);
  return [];
});
const summary = computed(() => (Array.isArray(props.value) ? `[${entries.value.length}]` : `{${entries.value.length}}`));
const leaf = computed(() => (typeof props.value === 'string' ? JSON.stringify(props.value) : String(props.value)));
</script>

<template>
  <details v-if="isContainer" :open="depth < 2" class="ml-0">
    <summary class="min-h-6 cursor-pointer py-0.5 font-mono text-sm">
      <span v-if="name !== null" class="font-semibold">{{ name }}</span>
      <span class="text-muted-foreground"> {{ summary }}</span>
    </summary>
    <ul class="ml-4 border-l pl-3">
      <li v-for="[key, child] in entries" :key="key">
        <JsonTree :value="child" :name="key" :depth="depth + 1" />
      </li>
    </ul>
  </details>
  <p v-else class="font-mono text-sm">
    <span v-if="name !== null" class="font-semibold">{{ name }}</span>
    <span v-if="name !== null" class="text-muted-foreground">: </span>
    <span>{{ leaf }}</span>
  </p>
</template>
