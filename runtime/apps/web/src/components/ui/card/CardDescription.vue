<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (c) shadcn et contributeurs de shadcn-vue (https://github.com/unovue/shadcn-vue), licence MIT -->
<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <p
    data-slot="card-description"
    :class="cn('text-muted-foreground text-sm', props.class)"
  >
    <slot />
  </p>
</template>
