# CLAUDE.md : `runtime/apps/web` (`@runtime/web`)

## Rôle et module

Console web (Vue 3, Vite 8, Tailwind 4, reka-ui, vue-i18n, vue-router) servie par le serveur. Elle appartient au module **Front**
(`docs/modules.md` du dépôt de travail, non publié). Elle ne contient aucune logique métier : elle appelle l'API REST par le client typé `@runtime/client`.

## Ce qu'elle expose

Pas d'API de bibliothèque : `package.json` sans `exports`, c'est une application (un site statique construit dans `dist/`).

- `src/main.ts`, `src/App.vue`, `src/router/` : démarrage et routes.
- `src/views/` : écrans ; `src/components/` (dont `ui/`, composants shadcn-vue copiés) ; `src/composables/` (`useApiCatalog`,
  `useInvestigation`, `useEventStream`, `useAccount`…) ; `src/lib/` ; `src/i18n/` (catalogues français et anglais) ;
  `src/testing/` (environnement de rendu en mémoire, codes de raison de la spécification).
- `e2e/` : parcours Playwright (accessibilité axe, clavier seul, régions live, appairage, marque).

## Ce qu'elle peut importer

- `@runtime/client` (API REST typée, la seule voie vers le serveur) et `@runtime/ui` (jetons, `SymSignature`).
- Bibliothèques de `package.json` : `vue`, `vue-router`, `vue-i18n`, `reka-ui`, `@vueuse/core`, `cronstrue`, `tailwind-merge`,
  `class-variance-authority`, `clsx`.
- Elle n'importe PAS `@runtime/server`, `@runtime/worker`, `@runtime/db`, `@runtime/agent`, `@runtime/llm`, `@runtime/cli`
  dans son code livré (`dependency-cruiser` : `front-pas-serveur`). `@runtime/core` n'est utilisé que par un test d'intégration.
- La console se construit sans le serveur (`assert_console_build_independent_of_server`).

## Tests (scripts de `package.json`)

- `pnpm --filter @runtime/web test` : tests unitaires et de composants (`vitest run`).
- `pnpm --filter @runtime/web typecheck` : `vue-tsc` sur l'application, les tests et les E2E.
- `pnpm --filter @runtime/web build` : typecheck puis `vite build`.
- `pnpm --filter @runtime/web dev` : serveur de développement Vite.
- `pnpm --filter @runtime/web test:e2e` : Playwright (Chromium ; verrou de tests).

## Invariants applicables

Tests nommés présents dans ce dossier (table : `runtime/tests/invariants.json`) :

- Accessibilité : `assert_a11y_axe_clean`, `assert_keyboard_only_path`, `assert_live_regions_plan`, `assert_contrast_tokens`,
  `assert_reduced_motion_respected`, `assert_status_not_color_only`, `assert_no_nested_headings`.
- Contenu et i18n : `assert_i18n_key_parity`, `assert_i18n_fallback_english`, `assert_ui_strings_no_forbidden_words`,
  `assert_reason_codes_stable`, `assert_reason_visible_without_hover`.
- Sécurité et comptes : `assert_no_csp_violation`, `assert_secret_masked`, `assert_mfa_enforced`, `assert_password_change_reauth`,
  `assert_invitation_single_use`, `assert_no_impersonation`, `assert_admin_metadata_only`, `assert_robots_not_gating`,
  `assert_blocked_panel_no_tunnel_link`, `assert_fonts_self_hosted`.
- Parcours : `assert_cost_estimate_before_run`, `assert_budget_and_stop_controls`, `assert_diff_three_levels`,
  `assert_revert_shows_preview`, `assert_sse_banner_and_resume_last_event_id`, `assert_stale_is_flag`.

Toute chaîne visible passe par `src/i18n` (jamais de texte en dur) ; aucun `v-html` (règle ESLint `vue/no-v-html`).
