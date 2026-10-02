# CLAUDE.md : `runtime/packages/llm` (`@runtime/llm`)

## Rôle et module

Couche LLM maison : transport Chat Completions, `providers[]` par rôle, sonde de capacités, échelle de sortie structurée S1 à S4
avec validation Ajv finale, classification des échecs, mesure d'usage et coût, rédaction des secrets. Elle appartient au module
**Brain** (`docs/modules.md` du dépôt de travail, non publié). Elle ne dépend que du noyau.

## Ce qu'elle expose

`package.json` déclare deux points d'entrée, construits par `tsc -b` :

- `@runtime/llm` (`dist/index.js`, `src/index.ts`) : `types`, `errors`, `classifyFailure`, `extractErrorFields`,
  `parseRetryAfter`, `usage`, `redact`, `profile`, `schema`, `transport`, `client` (`LlmClient`, `createLlmClient`), `settings`.
- `@runtime/llm/testing` (`dist/testing.js`) : faux fournisseur et outils de test, réservés aux tests des paquets consommateurs.

`cassettes/` contient les enregistrements des contrats de fournisseurs.

## Ce qu'elle peut importer

- `@runtime/core` (types, utilitaires, journalisation) et `ajv`.
- Rien d'autre d'interne : ni `@runtime/db`, ni `@runtime/agent` (le sens est `agent` → `llm`, jamais l'inverse), ni aucune
  application (`dependency-cruiser` : `brain-pas-runner`). `msw` n'est qu'une dépendance de test.

## Tests (scripts de `package.json`)

- `pnpm --filter @runtime/llm test` : `vitest run` (unitaires et contrats, `msw` pour le réseau simulé).
- `pnpm --filter @runtime/llm build` : `tsc -b`.
- Depuis `runtime/` : `pnpm test:fast`, `pnpm typecheck`, `pnpm lint`.

Pas de script `typecheck` propre : la vérification de types passe par `tsc -b` et par `pnpm typecheck` de la racine.

## Invariants applicables

Tests nommés présents dans ce dossier (table : `runtime/tests/invariants.json`) :

- `assert_llm_contract` : comportement attendu des fournisseurs sur les cassettes (formats, erreurs, reprise).
- `assert_llm_no_fallback` : un refus donne `llm_refused` après une seule requête ; le fournisseur de repli n'est jamais appelé.
- `assert_llm_redaction` : clés, jetons et secrets masqués dans les journaux, erreurs et traces.

Aucun appel LLM réel en test ; toute clé d'API vient de la configuration, jamais du code ni d'une cassette.
