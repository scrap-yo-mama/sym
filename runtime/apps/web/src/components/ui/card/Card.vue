<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (c) shadcn et contributeurs de shadcn-vue (https://github.com/unovue/shadcn-vue), licence MIT -->
<!-- Modifié (tâche 3.15, charte SYM) : cartes de 20 px de rayon, sans ombre (les ombres plates sont réservées aux cartes d'illustration, 20 § 1.2). -->
<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="card"
    :class="
      cn(
        'bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6',
        props.class,
      )
    "
  >
    <slot />
  </div>
</template>
