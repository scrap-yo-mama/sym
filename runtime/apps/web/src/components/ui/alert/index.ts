// SPDX-License-Identifier: MIT
// Copyright (c) shadcn et contributeurs de shadcn-vue (https://github.com/unovue/shadcn-vue), licence MIT
// Modifié (tâche 3.15, charte SYM) : l'alerte d'erreur est une surface orange à texte anthracite (jamais de l'orange en texte, 20 § 1.3).
import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Alert } from "./Alert.vue"
export { default as AlertDescription } from "./AlertDescription.vue"
export { default as AlertTitle } from "./AlertTitle.vue"

export const alertVariants = cva(
  "relative w-full rounded-lg border px-4 py-3 text-sm grid has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-0.5 items-start [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground [&>svg]:text-current *:data-[slot=alert-description]:text-destructive-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

export type AlertVariants = VariantProps<typeof alertVariants>
