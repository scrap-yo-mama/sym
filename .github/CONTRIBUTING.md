<!-- Copie générée de runtime/CONTRIBUTING.md par `pnpm vitrine:community` : GitHub ne lit le profil de communauté qu'à la racine, dans .github/ ou docs/. Modifier runtime/CONTRIBUTING.md, puis régénérer. -->
# Contribuer

## Pyramide de tests

- **unit** (`*.unit.test.ts`, `*.prop.test.ts`) : fonctions pures, propriétés fast-check, sans base. `pnpm test:fast`.
- **integration** (`*.integration.test.ts`) : Postgres réel, jamais de mock de base.
- **contract** (`*.contract.test.ts`) : contrats REST et MCP.
- Au-dessus : e2e Playwright, suite de sécurité, charge k6 (nuit), recette.

Avant de marquer une tâche faite : `pnpm test:fast`, puis `pnpm -r build && pnpm -r test`.

## Règles

- **Un correctif commence par un test qui échoue** sur la branche sans le correctif. La PR montre deux commits : test rouge, puis correctif.
- **Aucun site réel, aucun LLM réel en PR.** Les tests sont hermétiques : fixtures locales préfixées `zz_test_`, faux fournisseur LLM scripté.
- **Aucun fichier `.py` ni `.ipynb`**, où que ce soit (garde X6 en CI). Les outils Python tournent en image Docker, jamais en dépendance du dépôt.
- Aucune dépendance hors de la stack de `cdc/scrapyomama-runtime/03-architecture.md` sans accord préalable. Versions exactes, via le catalogue de `pnpm-workspace.yaml`.
- Chaque test nommé de `tests/invariants.json` existe, au moins en `test.todo` (`pnpm check:invariants`).

## Licences et en-têtes SPDX

- Cœur (serveur, worker, console, extension, CLI, outillage) : **AGPL-3.0-only** ([LICENSE](../runtime/LICENSE)).
- `packages/client` et `packages/schemas` : **MIT** ([LICENSES/MIT.txt](../runtime/LICENSES/MIT.txt)). Ils n'importent jamais le cœur.
- Chaque fichier source (`.ts`, `.mjs`, `.sql`, `.sh`) commence par `SPDX-License-Identifier: <licence du paquet>`. `pnpm spdx:add` ajoute les en-têtes manquants ; le test `tests/governance.unit.test.ts` vérifie leur présence et leur cohérence avec la licence du paquet.
- Le choix `-only` ou `-or-later` reste **à valider par un avocat**.

## Signer : DCO et CLA

> Brouillon, à valider par un avocat avant toute publication. Le dépôt est public, mais rien de ce qui suit n'est actif avant la première release : les contributions externes ne sont pas encore ouvertes et le bot CLA reste désactivé.

- **DCO (toutes les contributions)** : chaque commit porte `Signed-off-by: Prénom Nom <adresse>` (`git commit -s`). Texte : [DCO.md](../runtime/DCO.md) (Developer Certificate of Origin 1.1).
- **CLA (cœur AGPL uniquement)** : licence, pas cession, signée via CLA Assistant. Texte **provisoire** dans [CLA.md](../runtime/CLA.md), non relu par un avocat ; le bot est **non activé** (`.github/workflows/cla.yml`, déclenchement manuel seul). Pas de CLA sur les paquets MIT : DCO seul.
- **Engagement** (formulation à valider par un avocat) : le cœur reste disponible sous une licence approuvée par l'OSI, et les protections de base (isolation, secrets, multi-utilisateur, 2FA, clés à scopes, journal d'audit) ne deviennent jamais payantes.

## Contributions refusées

Nous n'acceptons pas de contribution (code, dépendance, documentation, extrait dans une issue) dont le but est de :

- résoudre ou faire résoudre un captcha, ou de se connecter à un service qui le fait (X1) ;
- masquer l'identité réelle du navigateur ou du client pour tromper une détection (X2) ;
- franchir un défi anti-robot ou une protection d'accès (X3) ;
- changer d'adresse IP après un refus pour déjouer une détection (X4) ;
- utiliser des comptes ou des identités multiples pour échapper à une limite (X5) ;
- réintroduire du code de franchissement de protections, sous quelque forme que ce soit, dont tout fichier Python ou notebook (X6).

Ces sujets sont exclus par conception : voir la page [Hors périmètre](../runtime/docs/hors-perimetre.md). Une pull request de ce type est fermée sans revue technique (label `out-of-scope`) et le débat ne se rouvre pas. Merci de ne pas publier ce type de code dans les issues. En CI, une contribution externe passe aussi `assert_no_circumvention` et la garde X6.

Reste bienvenu : respect de `robots.txt` et des conditions d'usage, limitation de cadence, API officielles, meilleur diagnostic des blocages, documentation des cas où le produit s'arrête.

En ouvrant une pull request, vous certifiez (DCO) avoir le droit de soumettre votre code et qu'il ne relève pas de la liste ci-dessus.

## Conduite et sécurité

- Code de conduite : [CODE_OF_CONDUCT.md](../runtime/CODE_OF_CONDUCT.md) (Contributor Covenant 3.0).
- Vulnérabilités : jamais en issue publique, voir [SECURITY.md](../runtime/SECURITY.md).
- Marque : [TRADEMARK.md](../runtime/TRADEMARK.md).
