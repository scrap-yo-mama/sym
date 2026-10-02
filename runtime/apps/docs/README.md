# Site de documentation

Site statique Diátaxis (tutoriels, guides, référence, explications) : VitePress, recherche Pagefind, `llms.txt`. Il n'est **jamais publié** par la CI : la sortie reste dans `apps/docs/dist`.

| Commande (depuis `runtime/`) | Effet |
|---|---|
| `pnpm --filter @runtime/docs dev` | génère les pages de référence puis lance VitePress en mode développement (sans recherche : l'index Pagefind n'existe qu'après une construction) |
| `pnpm docs:build` | construit le site : pages générées, VitePress, version `.md` de chaque page, `llms.txt`, `llms-full.txt`, vérificateur de liens, index Pagefind. Échoue au premier lien mort |
| `pnpm docs:test` | tests de contenu et de construction (Usage responsable en 11 sections, Hors périmètre, variables, commandes, liens) |
| `pnpm docs:quickstart` | rejoue le tutoriel « Démarrage rapide » sur une instance vierge (PostgreSQL jetable, aucune connexion hors machine) ; prérequis : `pnpm build` |
| `pnpm --filter @runtime/docs preview` | sert `dist` en local |
| `pnpm --filter @runtime/docs test:e2e` | gates Chromium de la landing sur la préproduction (voir « La landing » ci-dessous) |

## La landing (tâche 4.11)

L'accueil du site est la **landing** : anglais à `/`, français à `/fr/` (22 § 2). Elle est servie par GitHub Pages du dépôt public, sous `/sym/` (D-43) ; **rien n'est déployé** avant le GO (`.github/workflows/pages.yml`, déclenchement manuel seul).

| Commande (depuis `runtime/`) | Effet |
|---|---|
| `pnpm --filter @runtime/docs test:e2e` | construit la **préproduction** (`DOCS_BASE=/sym/`, sortie `dist-preprod`), la sert en local comme GitHub Pages (sans en-têtes, CSP en balise meta) et joue les gates Chromium : cookie, requêtes tierces, traceurs, CSP, axe en clair et en sombre, mouvement réduit, budgets de poids |
| `pnpm --filter @runtime/docs landing:probe --preprod` | les mêmes contrôles de confidentialité, avec résultat daté ; avec une adresse à la place de `--preprod`, la sonde lit la production (hebdomadaire après le GO) |
| `pnpm check:landing-go` | porte du GO : rouge tant qu'une preuve du registre n'est pas un vrai test, qu'un champ juridique est à fournir ou qu'une tâche liée manque |
| `pnpm --filter @runtime/docs landing:links` | liens externes en 200 (seule commande qui ouvre des connexions sortantes) |
| `pnpm --filter @runtime/docs landing:stars` | écrit étoiles et version dans `landing/stars.json` (API publique de GitHub) |
| `pnpm --filter @runtime/docs landing:og` | régénère les images sociales 1200×630 (`content/public/og/`) |

- **Contenu** : `src/landing/content.ts` (une fonction pour les deux langues, chaque texte en paire fr/en) ; les phrases factuelles viennent de `.github/claims.json` (registre des allégations : statut, preuve, date). Le thème (`content/.vitepress/theme/landing/`) rend ce contenu avec les jetons de `packages/ui`, sans attribut `style`.
- **CSP** : balise meta calculée à la construction (`src/landing/csp.ts`), empreintes sha256 des scripts en ligne, jamais écrites à la main ; `dist/_headers` (repli Cloudflare Pages) porte la même politique plus `frame-ancestors`. Les pages de doc n'ont pas cette CSP (leur recherche charge du WebAssembly).
- **Variables de construction** : `PUBLIC_REPOSITORY` (propriétaire/dépôt, source unique de l'identité), `DOCS_BASE`, `DOCS_SITE_URL` (défaut : `https://<propriétaire>.github.io`), `DOCS_OUT_DIR` (dossier de sortie sous `apps/docs`), `LANDING_COMPARE=1` (tableau par catégories : éteint tant qu'un avocat ne l'a pas relu).
- Lexique (`landing/lexicon/`), budgets (`scripts/vitrine/budgets.json`) et licences des ressources (`ASSETS-LICENSES.md`) : voir les fichiers.

## Où est quoi

- `content/` : les pages Markdown. Toute page doit être déclarée dans `src/nav.ts` (quadrant, titre, résumé) : c'est ce registre qui produit la barre latérale, `llms.txt` et les contrôles.
- `content/reference/rest.md` et `content/reference/codes-de-raison.md` sont **générées** à la construction (OpenAPI de `packages/client`, textes de la console) et ne sont pas versionnées.
- `content/tutoriels/quickstart.md` est **exécutable** : chaque bloc `bash` précédé d'un marqueur `<!-- quickstart {...} -->` est rejoué par `tests/quickstart.integration.test.ts`. Modifier une commande de la page, c'est modifier ce que la CI exécute.
- `content/reference/variables-environnement.md` est comparée au code par un test, dans les deux sens.
- Variables de construction : `DOCS_BASE` (préfixe des liens, défaut `/`) et `DOCS_SITE_URL` (adresse absolue des liens de `llms.txt`, facultative).

Règles de rédaction de la doc : français, vouvoiement (la landing et ses pages juridiques tutoient, 20 § 3.1), aucune promesse de conformité juridique, aucun nom d'outil ni d'éditeur de protection, aucune ressource chargée hors du site.
