# ADR 0005 : accessibilité de la console (WCAG 2.2 AA)

- Statut : accepté
- Date : 2026-10-01
- Source : `cdc/scrapyomama-runtime/06-specs-interface.md` (§ 1 « Accessibilité et langues », § 3 « Plan des live regions »,
  § 4.2 et § 4.3), `15-strategie-tests.md` (axe), tâche 3.9

## Contexte

La tâche 3.3 a posé les fondations (lien d'évitement, focus sur le `<h1>`, `document.title` traduit, thèmes appliqués avant
le premier rendu, mouvement réduit), 3.4 et 3.5 ont livré les écrans. 3.9 en fait une **gate de recette** (pas un invariant,
A10) : axe sans violation, parcours au clavier seul, parité des clés `en`/`fr`, jetons de contraste, live regions.

## Décision

### La gate tourne en Chromium, sur la console construite

`apps/web/e2e/` (Playwright Test, `pnpm test:e2e`, aussi dans `ci:local` et dans le job `e2e` de la CI). Le test construit la
console avec Vite dans un dossier temporaire et la sert en boucle locale sur un port éphémère, avec un faux serveur d'API
(objets typés par le client généré, flux SSE tenu par le serveur). Pas de base de données, pas de site réel : la gate ne juge
que le rendu. La suite E2E complète sur une instance réelle reste la tâche 3.6, qui rejoue ces trois critères.

| Fichier | Critère |
|---|---|
| `a11y.e2e.ts` | `assert_a11y_axe_clean` : chaque écran et état (37, dont les états affichés après une action : lancement, relance, items, comparaison, replay), en clair et en sombre, en `en` et en `fr`, 0 violation et 0 erreur de console ; reflow à 320 px (WCAG 1.4.10) |
| `keyboard.e2e.ts` | `assert_keyboard_only_path` : du premier Tab à Lancer (bouton atteint par Tab) et à Nouvelle API, retour au catalogue par le lien de la navigation, sans souris ni retour arrière du navigateur ; chaque écran, dans chacun de ses états préparés (`prepare`), se parcourt avec Tab sans piège, anneau de focus visible à chaque arrêt ; focus rendu à l'ouvreur d'une confirmation |
| `live-regions.e2e.ts` | `assert_live_regions_plan` : une annonce par le bon rôle ARIA, jamais de déplacement du focus ; l'étape annoncée change au texte exact (avant et après `phase.started`) ; l'alerte d'action requise garde son nœud et n'est pas réécrite quand les mêmes événements sont rejoués |

Axe tourne avec les tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` (le CDC liste les quatre derniers ;
`wcag21a` s'y ajoute, la gate est plus stricte). Toute violation est refusée, pas seulement les sérieuses et critiques. Les
écrans sont dans `e2e/screens.ts` ; un écran ajouté par une tâche suivante (comptes, audit, personnes : 3.8) s'y ajoute avec sa
donnée. `src/a11y.unit.test.ts` vérifie que chaque route du routeur y a un écran.

Une réponse 4xx ou 5xx voulue (connexion refusée, serveur en panne) ou une coupure du flux est journalisée par Chromium comme
erreur de console : les écrans qui la montrent portent `expectsNetworkError`, et seules ces erreurs-là sont tolérées.

### Jetons de contraste (test unitaire)

`src/design-tokens.unit.test.ts` convertit les jetons OKLCH de `main.css` (clair et sombre) et les teintes de statut de Tailwind
en sRGB et vérifie 4,5:1 pour le texte (dont survols et fonds translucides) et 3:1 pour bordures de champ, anneau de focus
et badges. Le calcul a son propre oracle (noir/blanc, gris 50 %, `sky-800`).

**`--border` est décoratif.** Il fait 1,26:1 en clair et 1,46:1 en sombre sur `background` : il dessine des séparateurs, des
cartes et des tableaux, jamais le contour d'un contrôle. Tout `<input>`, `<select>` et `<textarea>` à bordure porte
`border-input` (3:1), et le bouton à contour s'identifie par son texte. Une garde statique (`src/a11y.unit.test.ts`) le fait
respecter : un champ sans `border-input` fait échouer le test (elle a trouvé la zone de saisie du schéma de l'enquête, qui
utilisait `border` seul). Cases à cocher et boutons radio, widgets natifs du navigateur, en sont exclus.

### Correctifs livrés avec la gate

- **Anneau de focus** : une règle sans calque pose `outline: 2px solid var(--ring)` sur tout `:focus-visible` (hors
  `tabindex="-1"`). Les anneaux `ring-ring/50` de shadcn-vue, seuls, étaient trop pâles pour un bouton plein.
- **`role="log"` sur un conteneur**, jamais sur le `<ol>` : il remplaçait le rôle de liste et les `<li>` n'avaient plus de parent
  de liste (axe `listitem`).
- **Cibles de 24 px** (2.5.8) : les `<summary>` de l'arbre JSON ont `min-h-6`.
- **Reflow à 320 px** (1.4.10) : `Button` ne force plus `whitespace-nowrap` ni une hauteur fixe ; les conteneurs à défilement
  horizontal sont `relative` (le texte `sr-only` d'un tableau, absolu, débordait de la page).
- **Suspendre le suivi** (2.2.2) aussi sur le catalogue, qui se relit toutes les 15 s : plus de relecture ni d'annonce tant qu'il
  est suspendu, une relecture à la reprise. Le bouton à bascule change de libellé sans `aria-pressed` (un seul signal).
- **Changement d'étape annoncé** dans la région `status` de l'enquête (« Étape : Essais. »), comme le plan de § 3 le demande.
- **Focus sur le `<h1>` d'une page qui charge ses données** : la fiche d'une API montre d'abord un squelette sans titre, le
  focus restait sur `<body>`. Il attend le `<h1>` (5 s au plus, sauf si la personne a mis le focus ailleurs).
- **Retour du focus** à l'ouvreur quand la confirmation en ligne se ferme (2.4.3).

### Dépendance

`@axe-core/playwright` 4.13.0 (MPL-2.0, compatible AGPL-3.0, devDependency de `apps/web`), qui tire `axe-core` ~4.13.0.
Pas de plugin ESLint d'accessibilité : hors de la stack de 03.

## Conséquences

- Un écran ou un état de plus se déclare dans `e2e/screens.ts` ; la gate échoue sinon (test de couverture des routes).
- Le champ de date natif : le bouton de calendrier est un contrôle interne de Chromium, où le champ n'est plus `:focus-visible`
  ; c'est le navigateur qui y dessine l'indicateur, le test de parcours au clavier l'exclut explicitement.
- Pas encore couvert, à rejouer en 3.6 sur l'instance réelle : lecteur d'écran réel (les annonces sont jugées par rôle et
  contenu des régions), zoom de texte à 200 % (1.4.4), espacement du texte (1.4.12).
