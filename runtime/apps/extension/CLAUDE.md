# CLAUDE.md : `runtime/apps/extension` (`@runtime/extension`)

## Rôle et module

Extension Chrome MV3 (WXT 0.21.4, popup en Vue 3 sans compilateur de gabarits : CSP MV3). Elle appartient au module
**Extension** (`docs/modules.md` du dépôt de travail, non publié). Elle appaire l'appareil de l'utilisateur à l'instance, recueille le consentement par site, ouvre
la WSS du tunnel vers le serveur et exécute localement les commandes CDP reçues, sur une liste blanche figée. Aucune logique
distante : tout le code exécuté est celui du paquet publié.

## Ce qu'elle expose

Pas d'API de bibliothèque : `package.json` sans `exports`, c'est une application. Elle livre le paquet d'extension
(`pnpm --filter @runtime/extension build`, puis `pnpm package:extension` depuis `runtime/`).

- `src/manifest.ts` : manifeste (permissions minimales, hôtes optionnels).
- `src/entrypoints/background.ts` : service worker (alarme de 30 s pour la reconnexion), `src/entrypoints/popup/`.
- `src/core/` : `tunnel-client.ts` (WSS, reprise), `tunnel-executor.ts` et `cdp-driver.ts` (commandes CDP et `agent_step`),
  `allowlist.ts` (ré-exporte la liste blanche de `@runtime/core/tunnel`), `host-guard.ts` (consentement et hôtes),
  `controller.ts`, `in-page.ts`, `instance.ts`, `alarms.ts`, `messages.ts`.
- `src/platform/chrome-api.ts` : seule couche qui touche `chrome.*`.
- `store/` : fiche du Chrome Web Store (justification des permissions).

## Ce qu'elle peut importer

- `@runtime/core` et ses sous-chemins : `@runtime/core/tunnel` (contrat extension ↔ serveur : trames, liste blanche CDP,
  détection de défi, actions d'écriture), `@runtime/core/net` (garde SSRF, côté tests).
- `@runtime/ui` (icône seule : `@runtime/ui/sym-ghost`) et `vue`.
- Elle n'importe PAS `@runtime/db`, `@runtime/server`, `@runtime/worker`, `@runtime/agent`, `@runtime/llm` dans son code livré.
  `@runtime/db` n'apparaît que dans `e2e/` (harnais de bout en bout : base jetable), jamais dans `src/`.
  `dependency-cruiser` signale toute entorse (`extension-pas-worker`).

## Tests (scripts de `package.json`)

- `pnpm --filter @runtime/extension test` : tests unitaires (`vitest run`).
- `pnpm --filter @runtime/extension typecheck` : `tsc --noEmit`.
- `pnpm --filter @runtime/extension build` : construction WXT (requise avant les E2E).
- `pnpm --filter @runtime/extension test:e2e` : Playwright, Chromium, serveur et base réels (Docker requis ; verrou de tests).

## Invariants applicables

Tests nommés présents dans ce dossier (table : `runtime/tests/invariants.json`) :

- Tunnel : `assert_cdp_allowlist` (seules les méthodes de la liste figée, ni `Runtime.*` ni `Emulation.*`),
  `assert_ws_token_not_in_url`, `assert_sw_alarm_reconnect`, `assert_identity_pinned`, `assert_no_cookie_in_tunnel_mode`.
- Consentement et révocation : `assert_consent_before_capture`, `assert_optional_hosts`, `assert_revocation_local_first`.
- Défi et écriture : `assert_challenge_in_tunnel_stops` (aucune prise de contrôle, onglet laissé à l'utilisateur),
  `assert_write_action_blocked`, `assert_agent_step_stale_ref`.
- Sûreté du paquet : `assert_no_remote_logic`, `assert_no_csp_violation`, `assert_ssrf_guard`, `assert_store_package_clean`,
  `assert_store_permissions_justified`, `assert_store_listing_complete`, `assert_fonts_self_hosted`.

Ne jamais élargir la liste blanche CDP ni ajouter un hôte obligatoire sans décision et test. Les E2E qui lancent des processus
respectent la règle de sécurité du `CLAUDE.md` racine du dépôt de travail (non publié) : aucun `kill` large (`kill -1`,
`kill 0`, `pkill`, `killall`, `process.kill(0 | -1, …)`), on ne tue que le PID d'un enfant que le test a lui-même lancé.
