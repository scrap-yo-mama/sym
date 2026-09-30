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
