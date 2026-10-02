# CLAUDE.md : `runtime/apps/docs` (`@runtime/docs`)

## Rôle et module

Site de documentation publique (VitePress 2.0.0-alpha.20, index Pagefind, `llms.txt`), structuré en Diataxis. Il appartient au
module **Front** (`docs/modules.md`). Il se construit en site statique, sans serveur ni base.

## Ce qu'il expose

Pas d'API de bibliothèque : `package.json` sans `exports`, `dependencies` vide. Il produit un site statique.

- `content/` : pages Markdown (`tutoriels/`, `guides/`, `explications/`, `reference/`) et configuration VitePress
  (`content/.vitepress/`).
- `scripts/build.ts` : construction complète ; `scripts/gen-reference.ts` : pages de référence générées (REST depuis
  `packages/client/openapi/openapi.yaml`, raisons depuis `apps/web/src/i18n`, variables depuis le catalogue).
- `src/` : logique testable (`site.ts`, `nav.ts`, `rest-reference.ts`, `reasons-reference.ts`, `quickstart.ts`).

## Ce qu'il peut importer

- Aucun paquet `@runtime/*` en import : les sources de référence sont lues comme des FICHIERS (OpenAPI, catalogues), pas importées.
- Bibliothèques de `package.json` : `vitepress`, `pagefind`, `vue`, `yaml`.
- Il n'importe PAS `@runtime/server`, `@runtime/worker`, `@runtime/db`, `@runtime/agent`, `@runtime/llm`
  (`dependency-cruiser` : `front-pas-serveur`).

## Tests (scripts de `package.json`)

- `pnpm --filter @runtime/docs test` : tests de contenu et unitaires (`vitest run`).
- `pnpm --filter @runtime/docs typecheck` : `tsc`.
- `pnpm --filter @runtime/docs build` : construction du site, contrôle des liens, `llms.txt`, index Pagefind.
- `pnpm --filter @runtime/docs dev` / `preview` : développement et aperçu local.
- Depuis `runtime/` : `pnpm docs:test` (build + tests), `pnpm docs:quickstart`, `pnpm gen:env-docs`, `pnpm check:env-docs`.

## Invariants applicables

Tests nommés présents dans ce dossier (table : `runtime/tests/invariants.json`) :

- `assert_docs_site_builds`, `assert_docs_links_clean` (0 lien mort), `assert_docs_no_external_resources`,
  `assert_llms_txt_cites_every_page`, `assert_docs_diataxis_structure`.
- `assert_docs_rest_reference_generated`, `assert_docs_env_in_sync`, `assert_docs_commands_exist` (toute commande citée existe).
- `assert_responsible_use_sections` (page « Usage responsable » en 11 sections), `assert_out_of_scope_cites_x1_x6`,
  `assert_quickstart_terminal_boundary`.

Ne pas éditer à la main les pages de référence générées : modifier la source (OpenAPI, catalogue) puis relancer la génération.
