# Site de documentation

Site statique Diátaxis (tutoriels, guides, référence, explications) : VitePress, recherche Pagefind, `llms.txt`. Il n'est **jamais publié** par la CI : la sortie reste dans `apps/docs/dist`.

| Commande (depuis `runtime/`) | Effet |
|---|---|
| `pnpm --filter @runtime/docs dev` | génère les pages de référence puis lance VitePress en mode développement (sans recherche : l'index Pagefind n'existe qu'après une construction) |
| `pnpm docs:build` | construit le site : pages générées, VitePress, version `.md` de chaque page, `llms.txt`, `llms-full.txt`, vérificateur de liens, index Pagefind. Échoue au premier lien mort |
| `pnpm docs:test` | tests de contenu et de construction (Usage responsable en 11 sections, Hors périmètre, variables, commandes, liens) |
| `pnpm docs:quickstart` | rejoue le tutoriel « Démarrage rapide » sur une instance vierge (PostgreSQL jetable, aucune connexion hors machine) ; prérequis : `pnpm build` |
| `pnpm --filter @runtime/docs preview` | sert `dist` en local |

## Où est quoi

- `content/` : les pages Markdown. Toute page doit être déclarée dans `src/nav.ts` (quadrant, titre, résumé) : c'est ce registre qui produit la barre latérale, `llms.txt` et les contrôles.
- `content/reference/rest.md` et `content/reference/codes-de-raison.md` sont **générées** à la construction (OpenAPI de `packages/client`, textes de la console) et ne sont pas versionnées.
- `content/tutoriels/quickstart.md` est **exécutable** : chaque bloc `bash` précédé d'un marqueur `<!-- quickstart {...} -->` est rejoué par `tests/quickstart.integration.test.ts`. Modifier une commande de la page, c'est modifier ce que la CI exécute.
- `content/reference/variables-environnement.md` est comparée au code par un test, dans les deux sens.
- Variables de construction : `DOCS_BASE` (préfixe des liens, défaut `/`) et `DOCS_SITE_URL` (adresse absolue des liens de `llms.txt`, facultative).

Règles de rédaction : français, vouvoiement, aucune promesse de conformité juridique, aucun nom d'outil ni d'éditeur de protection, aucune ressource chargée hors du site.
