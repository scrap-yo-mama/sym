---
name: browser-parity
description: Garde la parité entre le nœud SYM Browser et le pool navigateur de SYM (moteur, arguments de lancement, bac à sable, egress, User-Agent) et prépare assert_provider_parity (BINV4). À utiliser dès qu'une tâche touche au lancement de Chromium, à l'egress, à /v1/version ou aux tests de parité ("parité", "même comportement que SYM", "BrowserProvider", "assert_provider_parity").
---

# Parité avec le pool navigateur de SYM

SYM Browser remplace, à comportement égal, le Chromium que le worker de SYM lance lui-même (fournisseur `local`). Références : `cdc/sym-browser/04e-specs-integration-sym.md` (§ 1 existant, § 3 egress et gardes, § 4 identité, § 5 tests), `04g-specs-fournisseurs-sym.md` § 5 (parité à trois fournisseurs). Lis-les avant d’écrire.

## Ce qui doit rester identique

1. **Moteur** : Playwright 1.63.0 et Chromium 153.0.8010.12 (`BROWSER_ENGINE` du contrat). `GET /v1/version` renvoie la version réelle du navigateur du nœud ; le User-Agent reste la chaîne exacte du moteur qui sert (`assert_user_agent_engine_real`).
2. **Arguments de lancement** : le catalogue du nœud reprend ceux de `apps/worker/src/browser/launch.ts` de SYM (`CHROMIUM_SILENT_ARGS`, `INV11_DISABLED_FEATURES`, WebSocketStream coupé, prérendu coupé), pour les Chromium chauds comme pour les dédiés. Jamais `--no-sandbox`.
3. **Bac à sable** : Chromium sous utilisateur non root, bac à sable actif, profil `deploy/seccomp-chromium.json` identique octet pour octet à `runtime/deploy/seccomp-chromium.json` (le test du module le vérifie ; on met à jour les deux à la fois).
4. **Egress** : une session ouverte avec un egress fermé (0 requête hors contexte au repos), politique de l'essai appliquée avant la première navigation, mêmes compteurs (`requests`, `blocked`, octets) que `BrowserEgress` côté SYM.
5. **Frontière** : tu ne lis le code de SYM que pour comparer. Tu n'importes rien de `apps/worker` ni de `@runtime/*` : tu recopies la valeur (liste d'arguments, constantes) dans le module, et tu ajoutes un test qui compare les deux copies quand elles vivent dans le même dépôt.

## Procédure

1. Repère l'élément de SYM concerné dans le tableau de 04e § 1 et note son fichier et sa version actuelle.
2. Écris d'abord le test du module qui fige le comportement attendu (valeur, argument, compteur), rouge, puis implémente.
3. Si la tâche relève de W4 (4.1 à 4.7) : la liste de 04e § 5.1 et les deux tests de 04g § 4 se jouent avec `local`, `sym-browser` et `cdp` ; le verdict attendu par fournisseur est celui du tableau de 04g § 5. `cdp` vise un Chromium exposé en CDP ou une session de l'instance, jamais un compte tiers.
4. Toute différence assumée (latence, plateforme du nœud) est consignée dans le journal `cdc/sym-browser/.executed/journal.md` avec sa mesure, jamais masquée dans le test.
5. Vérifie avec la CI locale du module (skill `browser-ci`).
