# @sym/contracts

Contrats partagés entre SYM et ses modules (ADR 23 § 3, `cdc/scrapyomama-runtime/23-architecture-modulaire.md`). Licence MIT (à valider par l'avocat, ADR 23 § 7).

## Règles de forme

- Un sous-chemin `exports` par contrat. Aujourd'hui : `./browser` seul (SYM Browser). Les autres (`strategy`, `tunnel`, `api`) arrivent avec la tâche 5.1 de SYM.
- `exports` fermés : aucun import interne (`@sym/contracts/src/...`, `dist/...`). Le test `exports.unit.test.ts` le garde.
- Feuille : aucune dépendance de production, aucun import hors du paquet.
- Types et constantes seulement, aucune logique. Les énumérations sont des constantes `as const` dont dérivent les types et les schémas OpenAPI.
- Changement de forme (champ, type, enum) : `BROWSER_PROTOCOL_VERSION` change, les fixtures valides et invalides sont rejouées, producteur et consommateurs relisent.
- Changement cassant : nouvelle forme en parallèle, migration des consommateurs, puis retrait ; deux versions servies pendant la transition.

## Commandes (depuis `runtime/`)

- Build : `pnpm --filter @sym/contracts build`
- Tests : `pnpm --filter @sym/contracts test`
- Types : `pnpm --filter @sym/contracts typecheck`
