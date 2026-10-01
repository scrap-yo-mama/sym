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
de repos. Elle est coupée par `prefers-reduced-motion: reduce` et par le réglage **Animations** (Système, Réduites) du sélecteur de
préférences, posé avant le premier rendu par `public/theme-init.js` (`data-motion` sur `<html>`). Le champ `users.motion` reste
« à valider » (20b § 5, point 6), donc sans migration : le choix est mémorisé dans le navigateur (`runtime.motion`).

### CSP

La CSP du CDC (08b § 2, `style-src 'self'`) est servie par le banc E2E de la console ; la fixture fait échouer tout test au premier
`securitypolicyviolation` (`assert_no_csp_violation`). Le popup de l'extension n'a plus ni `<style>` ni style en ligne.

## Conséquences

- 3.16, 3.17 et 3.18 appliquent la charte avec les jetons, les classes `bg-status-*` / `sym-error` et `SymSignature` ; 3.18 rejoue la
  signature, la CSP et le mouvement sur le panneau.
- Le site de doc et la landing (4.11) importeront `@runtime/ui/theme.css` ; leur contrôle SVG (`apps/docs/public/`, `.github/assets/`)
  est déjà couvert par `assert_svg_safe`.
- Un jeton ajouté doit être nommé dans `@theme inline` (garde de `apps/web/src/design-tokens.unit.test.ts`) et passer les contrastes.
