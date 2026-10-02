# Module SYM Browser

Service de navigateurs à la demande : passerelle (REST `/v1`, WSS `/playwright` et `/cdp`, SSE), nœuds (pool de Chromium chauds, egress par session), profils, vue en direct, enregistrements, console et SDK. Aucune logique de SYM ici : SYM consomme ce module par le contrat.

- CDC : `cdc/sym-browser/` à la racine du dépôt (versionné, privé : hors du miroir public). Tâches : `06-taches.md`. Invariants BINV1 à BINV7 : `_index.md`.
- Architecture du dépôt : ADR 23 (`cdc/scrapyomama-runtime/23-architecture-modulaire.md`), étape 0 bis. Ce module est le pilote de l'environnement Claude par module.

## Frontière (lint bloquant)

- Hors de `modules/browser/`, tu n'importes que `@sym/contracts/browser` et `@runtime/ui` (packages/ui, console seulement).
- Jamais `@runtime/core`, `@runtime/db`, `apps/worker`… ni par paquet, ni par chemin relatif ou absolu. Règle : `eslint.boundaries.mjs`, test `tests/boundaries.unit.test.ts` (`assert_module_boundaries`).
- Chiffrement, configuration et masquage des journaux suivent le schéma de SYM, avec les mêmes vecteurs de test, mais vivent dans `packages/core` du module (le miroir public reste dans son périmètre).
- Changer `@sym/contracts/browser` : tâche séparée, session lancée avec `--add-dir ../../packages/contracts` ; changement de forme = `BROWSER_PROTOCOL_VERSION` qui change et fixtures rejouées (voir `runtime/packages/contracts/CLAUDE.md`).

## Contenu

| Dossier | Paquet | Licence | Rôle |
|---|---|---|---|
| `apps/gateway` | `@sym-browser/gateway` | AGPL-3.0 | REST, WSS, SSE, quotas, routage |
| `apps/node` | `@sym-browser/node` | AGPL-3.0 | Pool Chromium, sessions, egress |
| `apps/console` | `@sym-browser/console` | AGPL-3.0 | Console Vue 3.5 + `@runtime/ui` + vue-i18n (fr tutoiement, en) |
| `packages/sdk` | `@sym-browser/sdk` | MIT | SDK TypeScript, types du contrat |
| `packages/core` | `@sym-browser/core` | AGPL-3.0 | Chiffrement, configuration, journaux |
| `packages/db` | `@sym-browser/db` | AGPL-3.0 | Schéma PostgreSQL et migrations |
| `.` | `@sym-browser/module` | AGPL-3.0 | CI locale du module, tests de frontière et d'environnement |

Contrat : `runtime/packages/contracts` (`@sym/contracts`, MIT, sous-chemin `browser` seul, `exports` fermés).

## Commandes (depuis `runtime/`)

- CI locale du module, sous verrou de test : `pnpm --filter @sym-browser/module ci:local` (skill `browser-ci`).
- Sans l'image Docker : `pnpm --filter @sym-browser/module ci:local --skip-image` ; sans les tests sur Chromium réels : `--skip-chromium` (à dire dans le compte rendu).
- Schéma (Docker requis) : `pnpm --filter @sym-browser/db test` (PostgreSQL 16, `PG_VERSION` pour 17 ou 18) ; matrice 16/17/18 : `pnpm --filter @sym-browser/db test:matrix`. Migrations dans `packages/db/migrations/NNNN_nom/{up,down}.sql`, jamais modifiées après fusion (somme de contrôle).
- Pool du nœud sur de vrais Chromium (non root, espaces de noms utilisateur, `playwright install chromium`) : `pnpm --filter @sym-browser/node test:chromium`.
- Schéma (Docker requis) : `pnpm --filter @sym-browser/db test` (PostgreSQL 16, `PG_VERSION` pour 17 ou 18) ; matrice 16/17/18 : `pnpm --filter @sym-browser/db test:matrix`. Migrations dans `packages/db/migrations/NNNN_nom/{up,down}.sql`, jamais modifiées après fusion (somme de contrôle).
- Tests d'un paquet : `pnpm --filter @sym-browser/gateway test` ; tout le module : `pnpm --filter "./modules/browser/**" test`.
- Types : `pnpm --filter "./modules/browser/**" typecheck` ; lint : `pnpm exec eslint modules/browser packages/contracts`.
- `MASTER_KEY` de développement : `pnpm --filter @sym-browser/core keygen` (après build ; jamais committée ni journalisée). Vecteurs de SYM rejoués : `packages/core/vectors/sym-crypto.json`.
- Image : `docker build -f modules/browser/Dockerfile -t sym-browser:dev .` puis `docker run --rm --security-opt seccomp=modules/browser/deploy/seccomp-chromium.json --security-opt no-new-privileges --cap-drop ALL -e MASTER_KEY="$(openssl rand -base64 32)" -e DATABASE_URL=postgres://… sym-browser:dev` (`SYMB_MODE` : `all`, `gateway`, `node`).
- Egress par session (BINV2, 04c § 1) : `apps/node/src/egress/` (`startSessionEgress`, garde de résolution unique, arguments figés de Chromium) ; test `assert_session_egress_enforced` sur Chromium et le site de `fixtures/` (0.5).
- Proxys amont (04c § 2) : `apps/node/src/egress/upstream/` (`startUpstreamSessionEgress` : relais HTTP(S) et SOCKS5 authentifiés, profils chiffrés, test de l'IP de sortie, 502 `proxy_unreachable`) ; recette 10 sur Docker Compose (`fixtures/`).
- Relais WSS (tâche 2.3) : passerelle `apps/gateway/src/relay/` (`authorizeConnection` de 2.1 en preValidation, routage, ping), nœud `apps/node/src/relay/` (NODE_TOKEN, réécritures CDP de 04f § 4) ; bout en bout sur vrai Chromium (non root) : `pnpm --filter @sym-browser/module test:chromium`.
- Configuration : catalogue `packages/core/src/config/env-catalog.ts` (source unique, secrets `NOM_FILE`) ; config invalide = sortie code 1 nommant la variable ; `node dist/main.js --check-config` valide sans écouter ; `/healthz`, `/readyz`.
- Capacité d'un nœud : constantes dans `packages/core/src/capacity.ts`, mesures et banc dans `bench/` (`bench/run.sh`), rapport `docs/mesures-capacite.md`.
- ObjectStore `s3` (`packages/core/src/storage`) : ses tests lancent un MinIO jetable en conteneur (Docker requis, obligatoire sous `CI`, sauté avec avertissement sinon) ; point d'accès externe : `SYMB_TEST_S3_ENDPOINT`, `SYMB_TEST_S3_ACCESS_KEY_ID`, `SYMB_TEST_S3_SECRET_ACCESS_KEY`.
- `MASTER_KEY` de développement : `pnpm --filter @sym-browser/core keygen` (après build ; jamais committée ni journalisée). Vecteurs de SYM rejoués : `packages/core/vectors/sym-crypto.json`.

## Authentification (tâche 2.1)
- Code : `packages/core/src/auth/` (pur) et `packages/db/src/api-keys.ts` (SQL). Formats : clé `symb_<12>_<43>` (préfixe affiché `symb_<12>` = `api_keys.key_prefix`), jeton de connexion `symt_…` ; masqués dans les journaux (`CREDENTIAL_PREFIXES`, `createLogger`).
- Clé : `newApiKey({scopes, expiresAt})` rend la clé une seule fois (`Secret`) et l'empreinte argon2id (`node:crypto`) ; `insertApiKey`, `listApiKeys`, `revokeApiKey`. Première clé : `ensureFirstApiKey(pool, await bootstrapApiKeyRecord(config.bootstrapApiKey))` au démarrage de la passerelle ; clé neuve : `pnpm --filter @sym-browser/core apikey`.
- REST (2.2) : `auth = new ApiKeyAuthenticator(pgApiKeyStore(pool))` remplit `GatewayDeps.auth` (`authenticate`) ; ou `authorizeRequest(auth, request.headers, scope)` → 401 `unauthorized` / 403 `forbidden` + `requiredScope`.
- Jetons (2.2, 2.3) : `tokens = new ConnectTokens(keyring)` (`loadKeyring`) remplit `GatewayDeps.tokens` (`issue`, 300 s, 1 h au plus). Upgrade WSS et `json/version` (2.3) : `authorizeConnection({auth, tokens, session}, {sessionId, protocol, headers, query})` en `preValidation`, avant tout octet vers le nœud ; `session(id)` lit `tenant_id` et `state`.
- Admin d'instance : `resolveBootstrapToken`, `setupFirstAdmin(store, token, form)` ; la table de l'admin et `/setup` arrivent avec la console (3.5).

## Versions et dépendances

- Playwright **1.63.0**, Chromium **153.0.8010.12** (`BROWSER_ENGINE` du contrat ; le test du nœud vérifie `playwright-core`).
- Toute dépendance passe par le catalogue de `runtime/pnpm-workspace.yaml` : `catalog:` ou `workspace:*`, versions exactes, publiées depuis plus de 7 jours (`minimumReleaseAge`).
- Image : `mcr.microsoft.com/playwright:v1.63.0-noble` épinglée par empreinte, utilisateur non root (`pwuser`), `tini` en PID 1, profil `deploy/seccomp-chromium.json` (copie exacte de celui de SYM, vérifiée par test), aucun binaire setuid.

## Règles de travail

- Lis la ligne de ta tâche dans `06-taches.md` et les specs 04 qu'elle cite avant d'écrire. Un correctif commence par un test qui échoue.
- Chaque fichier source porte un en-tête SPDX conforme à la licence de son paquet (`pnpm spdx:add` depuis `runtime/`).
- `git add` fichier par fichier. Jamais `git add -A`, jamais `push --force`, jamais de `.py` ni `.ipynb`, jamais de secret ni d'identifiant de proxy dans un commit ou un journal.
- Demande avant : publication (npm, image, release), push vers un dépôt public, compte payant.
- Textes d'interface en français (tutoiement) et en anglais ; DA SYM via `@runtime/ui`.
- Fusion dans `main` : orchestrateur seulement, sous `/tmp/claude-501/scrapyomama-merge.lock`.

## Environnement Claude

- Lance la session ici : `git worktree add`, puis `cd <worktree>/runtime/modules/browser && claude`. Pas `claude --worktree` (il ignorerait ce dossier `.claude/`).
- `.claude/settings.json` est autonome (rien n'est hérité de la racine) : `deny` des garde-fous, mémoire dans `~/.claude-memory/scrapyomama-browser`.
- Skills : `.claude/skills/` (`browser-ci`, `browser-contract-change`, `browser-parity`). Agent du module : `browser-dev` (`.claude/agents/` à la racine du dépôt).
