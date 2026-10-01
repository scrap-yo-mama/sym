# ADR 0006 : design system SYM (jetons, polices, thèmes, icône)

- Statut : accepté
- Date : 2026-10-01
- Source : `cdc/scrapyomama-runtime/20-specs-marque-ux.md` (§ 1 « Charte visuelle », § 2.3 « La signature SYM », § 4.3 « Mouvement et CSP »),
  `20b-contrats-marque-ux.md` (§ 1 et § 3.1), tâche 3.15

## Contexte

La console (3.3 à 3.9) portait les jetons neutres de shadcn-vue dans `apps/web/src/assets/main.css`. La maquette validée fixe le
rendu de la marque : palette, polices, formes, thèmes clair et sombre, signature « SYM ». L'extension (popup aujourd'hui, panneau
en 3.18) et le site de doc (landing en 4.11) doivent consommer les mêmes jetons.

## Décision

### Un paquet de sources, `packages/ui` (`@runtime/ui`)

Pas d'étape de build : Vite, Tailwind et WXT consomment les sources. Il porte :

| Fichier | Rôle |
|---|---|
| `src/theme.css` | Trois couches : la palette `--sym-*` de la maquette, les jetons sémantiques (`--background`, `--primary`, `--status-*`…) en clair (`:root`) et en sombre (`.dark`, et `.sym-on-ink` pour une zone anthracite d'un écran clair, comme la barre de navigation), puis formes, anneau de focus, signature et mouvement |
| `src/fonts.css` + `fonts/*.woff2` | Bricolage Grotesque 800, DM Sans 400, 500 et 700, JetBrains Mono 400 et 600, sous-ensemble latin |
| `icons/sym-ghost.svg`, `src/sym-ghost.ts`, `src/SymSignature.vue` | Icône unique en `currentColor`, son tracé exploitable par les fonctions de rendu (extension MV3, sans compilateur de gabarits), composant de signature |
| `src/testing/*` | Oracle de contraste WCAG (déplacé depuis `apps/web/src/testing`), règles de feuille, contrôle SVG : outils de test seulement |

`apps/web/src/assets/main.css` ne contient plus aucune valeur de couleur : il nomme les jetons pour Tailwind (`@theme inline`) et pose
les règles de base. Aucune couleur n'est écrite hors de `theme.css` (`assert_no_hardcoded_colors`).

### Règles de couleur (20 § 1.3)

- L'orange est une **surface** à texte anthracite (4,89:1), jamais un texte : les messages d'erreur en ligne deviennent une pastille
  orange (`@utility sym-error`), les alertes d'erreur et le bouton destructif une surface orange. Le survol du bouton destructif
  souligne au lieu d'éclaircir (un mélange à 90 % avec l'anthracite sortait de 4,5:1 en sombre).
- Le bleu n'est jamais posé sur l'anthracite : en sombre, lien, focus, progression et action principale passent au lilas.
- Statuts : surface pleine de la famille du statut, bordure `--status-border`, forme d'icône, libellé et raison inchangés ; en sombre,
  `action_requise` passe en lilas et `reparation` en lilas profond, de sorte qu'aucune surface de statut n'est bleue.
- Valeurs dérivées fixées en 3.15 (« à valider » en 20b § 5, point 8) : cartes et surfaces du sombre `#2F3039` et `#3A3B47`, bordure
  décorative `#4A4B58`, bord de champ `#7A756B` (clair) et `#9C978D` (sombre, 3:1 sur chaque fond), lilas profond `#4B3F72`, teintes
  de comparaison de stratégies. Le test de jetons les juge comme les autres.
- Barre de navigation : `.sym-on-ink` lui donne les jetons sombres, sauf `--nav`, qui reste l'anthracite de la maquette (`#24252D`)
  dans un écran clair ; la surface relevée `#2F3039` ne sert qu'au thème sombre, où la barre doit se détacher d'un fond anthracite.
- L'orange ne sert jamais de trait (bordure, anneau, contour : environ 2:1 sur crème) : l'état d'erreur de chargement porte une
  bordure anthracite pleine, comme le panneau Bloquée. Les ombres de Tailwind (`shadow-xs` à `shadow-2xl`, un noir écrit en dur)
  et l'anneau shadcn à 50 % sont retirés : ombres plates seulement, anneau de focus unique de `theme.css` ; les champs bordés ont
  44 px de haut, comme `Input`.

### Contrôle des règles de couleur et ses limites

`sheetViolations` juge toutes les feuilles de `apps/web`, `apps/extension` et `packages/ui`, avec les classes des `@apply` et des
`@utility` dépliées (`expandApply`). Un sélecteur sans marque de thème est jugé en clair et en sombre ; le fond d'un texte sans fond
propre se lit sur la règle ancêtre la plus proche (`.nav` pour `.nav a`, même dans un autre bloc), à défaut sur `--background` du
thème (anthracite dans `.dark` et `.sym-on-ink`). Côté gabarits, `inkZoneViolations` refuse toute classe bleue (`primary`, `ring`,
`status-action-requise`) sur un élément `bg-nav` ou `bg-status-bloquee` sans `sym-on-ink` et sur ses descendants du même gabarit.
Limites assumées : la cascade réelle (ordre, spécificité, héritage à travers les composants) n'est pas rejouée, et un descendant venu
d'un autre composant (bouton par défaut) n'est pas vu ; `sym-on-ink` sur la zone est la seule parade sûre, et axe juge le rendu réel
en clair et en sombre (`apps/web/e2e/a11y.e2e.ts`).

### Polices auto-hébergées

Fichiers copiés tels quels des paquets `@fontsource/*` 5.3.0 (SIL OFL 1.1), sans les installer : aucune dépendance de plus,
`check:licenses` inchangé (OFL n'est pas dans la liste des licences de dépendances). Empreintes sha256 gardées par
`packages/ui/src/fonts.unit.test.ts`, textes de licence dans `packages/ui/fonts/OFL-*.txt`, attribution dans `NOTICE`.
Budget de poids fixé ici (20 § 1.2 le laissait « à valider ») : texte et titres 64,7 Ko (≤ 70 Ko, sous les 80 Ko de la landing),
JetBrains Mono 43 Ko à part. Une police déclarée n'est téléchargée que lorsqu'un texte l'emploie : JetBrains Mono ne part que sur
les écrans de code (contrôlé en navigateur). Le paquet de l'extension accepte `assets/*.css` et `assets/*.woff2` et refuse toute
ressource distante dans une feuille.

### Mouvement

Une seule couche d'animations (coche tracée, apparition), en CSS, chacune de 5 s au plus et sans boucle, dont l'état final est l'état
de repos ; `tw-animate-css` (ADR 0002), qu'aucun écran n'employait, est retiré avec son import. Elle est coupée par
`prefers-reduced-motion: reduce` et par le réglage **Animations** (Système, Réduites) de **Mon compte** (20 § 4.3 ; la barre du haut
ne garde que la langue et le thème), posé avant le premier rendu par `public/theme-init.js` (`data-motion` sur `<html>`). Le champ `users.motion` reste
« à valider » (20b § 5, point 6), donc sans migration : le choix est mémorisé dans le navigateur (`runtime.motion`).

### CSP

La CSP du CDC (08b § 2, `style-src 'self'`), définie une fois (`apps/web/e2e/csp.ts`), est servie par les deux bancs E2E de la console :
le faux serveur d'API de `apps/web/e2e` et le relais de l'instance réelle de `tests/e2e` (parcours d'invitation de 3.8). Chaque contexte
de navigateur relève ses `securitypolicyviolation` et tout test de la console échoue s'il en a laissé une (`assert_no_csp_violation`) ;
chaque banc a un témoin qui prouve que le contrôle sait échouer. Le popup de l'extension n'a plus ni `<style>` ni style en ligne ; le harnais E2
de l'extension relève les violations de chaque page du contexte, et chaque test de la suite de l'extension échoue s'il en a laissé une.

## Conséquences

- 3.16, 3.17 et 3.18 appliquent la charte avec les jetons, les classes `bg-status-*` / `sym-error` et `SymSignature` ; 3.18 rejoue la
  signature, la CSP et le mouvement sur le panneau.
- Le site de doc et la landing (4.11) importeront `@runtime/ui/theme.css` ; leur contrôle SVG (`apps/docs/public/`, `.github/assets/`)
  est déjà couvert par `assert_svg_safe`.
- Un jeton ajouté doit être nommé dans `@theme inline` (garde de `apps/web/src/design-tokens.unit.test.ts`) et passer les contrastes.
