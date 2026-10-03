// SPDX-License-Identifier: MIT
// Copyright (c) shadcn et contributeurs de shadcn-vue (https://github.com/unovue/shadcn-vue), licence MIT
// Modifié (tâche 3.9, WCAG 1.4.10) : le libellé passe à la ligne (retour à la ligne permis, hauteurs minimales) au lieu de déborder à 320 px.
// Modifié (tâche 3.15, charte SYM) : jetons de la marque (l'orange est une surface à texte anthracite), cibles de 44 px, sans ombre ni anneau à 50 %.
// Modifié (tâche 3.17, D-60) : variante `signature`, le bouton jaune des planches.
import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Button } from "./Button.vue"

export const buttonVariants = cva(
  "inline-flex max-w-full items-center justify-center gap-2 rounded-md text-center text-sm font-bold transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring aria-invalid:border-foreground",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground underline-offset-4 hover:underline",
        outline:
          "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        // Bouton jaune de la planche (« Nouvelle API », « Valider et lancer les essais ») : texte anthracite (20 § 1.2).
        signature: "bg-signature text-signature-foreground hover:bg-signature/90",
      },
      size: {
        "default": "min-h-11 px-5 py-2 has-[>svg]:px-4",
        "xs": "min-h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        "sm": "min-h-9 rounded-md gap-1.5 px-3.5 has-[>svg]:px-2.5",
        "lg": "min-h-12 rounded-md px-6 has-[>svg]:px-4",
        "icon": "size-11",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-9",
        "icon-lg": "size-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)
export type ButtonVariants = VariantProps<typeof buttonVariants>
