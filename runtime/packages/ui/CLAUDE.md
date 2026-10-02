# CLAUDE.md : `runtime/packages/ui` (`@runtime/ui`)

## Rôle et module

Paquet de design SYM : jetons (couleurs OKLCH, typographie, mouvement), polices auto-hébergées, composant de marque et icône
fantôme. Il appartient au module **Front** (`docs/modules.md` du dépôt de travail, non publié). Il est consommé par la console (`apps/web`) et, pour l'icône seule,
par l'extension MV3. Il est livré en sources (pas de `dist/`).

## Ce qu'il expose

`package.json` déclare ces points d'entrée, tous en sources :

- `@runtime/ui` (`src/index.ts`) : composant `SymSignature` (`SymSignature.vue`), `SYM_GHOST_PATH`, `SYM_GHOST_VIEWBOX`.
- `@runtime/ui/theme.css` : jetons et polices (`src/theme.css`, `src/fonts.css`).
- `@runtime/ui/sym-ghost` : l'icône seule en TypeScript, utilisable sans compilateur de gabarits (extension MV3).
- `@runtime/ui/icons/sym-ghost.svg` : le SVG de l'icône.
- `@runtime/ui/testing/contrast` et `@runtime/ui/testing/color-rules` : calcul de contraste WCAG et règles de couleur, pour les
  tests des paquets consommateurs.

## Ce qu'il peut importer

- `vue` seulement. Aucune dépendance interne : ni `@runtime/core`, ni `@runtime/client`, ni aucune application. C'est la feuille
  du graphe : toute importation d'un autre paquet `@runtime/*` est une entorse.
- Les polices sont locales ; aucune ressource externe (CDN, Google Fonts).

## Tests (scripts de `package.json`)

- `pnpm --filter @runtime/ui test` : `vitest run` (jetons, polices, couleurs en dur, mouvement, SVG, `SymSignature`).
- `pnpm --filter @runtime/ui typecheck` : `vue-tsc --noEmit`.
- Depuis `runtime/` : `pnpm test:fast`, `pnpm lint`.

## Invariants applicables

Tests nommés présents dans ce dossier (table : `runtime/tests/invariants.json`) :

- `assert_brand_tokens_contrast` : contrastes WCAG des jetons de marque (1.4.3 et 1.4.11).
- `assert_no_hardcoded_colors` : aucune couleur en dur hors des jetons.
- `assert_fonts_self_hosted` : polices servies par le paquet, aucune requête externe.
- `assert_reduced_motion_respected` : tout mouvement respecte `prefers-reduced-motion`.
- `assert_svg_safe` : SVG sans script ni ressource externe.
- `assert_sym_signature_rendering` : rendu de `SymSignature` conforme à la marque.

Un nouveau jeton passe par `src/theme.css` et ses tests de contraste ; pas de couleur ni de police ailleurs.
