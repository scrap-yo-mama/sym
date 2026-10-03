<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ConsoleButton.vue
 * @description Bouton de la console aux jetons SYM (04d § 5.1 et § 5.4) : cible de 44 px pour les actions principales, 24 px
 * au moins pour les autres (WCAG 2.5.8), libellé qui passe à la ligne plutôt que de déborder (1.4.10). `busy` : le bouton
 * garde le focus (aria-disabled, pas disabled) et s'annonce occupé pendant l'envoi.
 * @component
 */
import { cva, type VariantProps } from 'class-variance-authority';
import { Primitive, type PrimitiveProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { cn } from '../lib/cn.js';

const button = cva(
  'inline-flex max-w-full items-center justify-center gap-2 rounded-md text-center text-sm font-bold transition-colors aria-disabled:pointer-events-none aria-disabled:opacity-70',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
        outline: 'border border-input bg-background text-foreground hover:bg-accent hover:text-accent-foreground',
        ghost: 'text-foreground underline-offset-4 hover:underline',
      },
      size: { default: 'min-h-11 px-5 py-2', sm: 'min-h-9 px-3.5 py-1.5' },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  },
);
type ButtonVariants = VariantProps<typeof button>;

const props = withDefaults(
  defineProps<PrimitiveProps & { variant?: ButtonVariants['variant']; size?: ButtonVariants['size']; busy?: boolean; class?: HTMLAttributes['class'] }>(),
  { as: 'button', busy: false },
);
</script>

<template>
  <Primitive
    :as="as"
    :as-child="asChild"
    :aria-disabled="busy ? 'true' : undefined"
    :aria-busy="busy ? 'true' : undefined"
    :class="cn(button({ variant, size }), props.class)"
  >
    <slot />
  </Primitive>
</template>
