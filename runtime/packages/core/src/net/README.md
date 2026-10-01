# `@runtime/core/net` : garde SSRF et proxy d'egress (INV10)

Spécification : CDC `08b-specs-securite-applicative.md` §1. Tests : `net.unit.test.ts`, `tests/security/ssrf-guard.security.test.ts` (`pnpm test:security`).

## Règles pour le code appelant

- **fetch serveur, `ctx.fetch`, webhooks** : utiliser uniquement `guardedFetch` (ou `deliverWebhook`, qui ne suit aucune redirection). Ne jamais appeler le `fetch` global ni un `Agent` undici non gardé.
- **Chromium** : lancer avec `chromiumEgressLaunchOptions(proxy.url)` (proxy d'egress local, DNS de Chromium coupé, pas de contournement de la boucle locale) et naviguer uniquement avec `guardedGoto(page, url, guard)` (http(s) seulement).
- **`playwright.request.newContext()` / `APIRequestContext`** : ce client HTTP de Playwright ne passe pas par le navigateur. Il doit recevoir explicitement le même proxy (`request.newContext({ proxy: { server: proxy.url } })`) ; à câbler en tâche 1.6. `browser.newContext()` hérite du proxy de lancement.
- **Dérogations** : `ALLOWED_PRIVATE_HOSTS` (noms exacts ou CIDR d'au plus /8 en IPv4 et /16 en IPv6), vide par défaut. Les métadonnées cloud, `0.0.0.0`, le multicast et la diffusion ne sont jamais dérogeables.
- **Drapeau de test `RUNTIME_TEST_ALLOW_PRIVATE`** : lu seulement sous `NODE_ENV=test`, sa présence ailleurs fait échouer le démarrage.

## Proxy d'egress

HTTP en forme absolue et CONNECT (HTTPS, ws, wss). Chaque connexion : résolution unique, contrôle de toutes les adresses, socket ouvert sur l'adresse validée, contrôle de l'adresse distante effective. Réglages : `idleTimeoutMs` (120 s par défaut), `maxConnections` (256 par défaut), `connectTimeoutMs` (10 s). Il n'a pas d'authentification : il écoute sur 127.0.0.1 et applique la garde à tout client.

## Modes réseau `direct`, `dc_proxy`, `res_proxy` (tâche 1.4, `modes/`)

Spécification : CDC `04-specs-api-strategies.md` §3.2 et §7, `08-specs-byo-securite.md` §2, `_exclusions.md` X4. Tests : `modes/modes.unit.test.ts`, `tests/network/network-modes.unit.test.ts` (proxy de test local, `assert_no_ip_change_after_refusal`), `tests/network/proxy-credentials.integration.test.ts` (dépôt de secrets réel).

- **Proxys définis par l'admin seul** (`parseProxyDefinitions`, forme JSON snake_case prévue pour `settings.proxies`) : type `dc` ou `res`, URL `http(s)://` ou `socks5://` **sans identifiants**, `credentials_secret_id` (secret `kind = proxy`, JSON `{"username","password"}`), `username_template` (jetons `{username}`, `{country}`, `{city}`, `{session}` ; segment `[...]` optionnel), `price` (`per_gb_usd`, `per_request_usd`), `allow_private_address`. Une API ne choisit qu'un `id` (`network_policy.proxy_ids`) et des paramètres validés (`dc_proxy_params`, `res_proxy_params` : pays alpha-2, ville et session en `[a-z0-9_]`).
- **N3 sur opt-in** : `res_proxy` n'entre dans l'échelle que s'il figure explicitement dans `network_policy.allow`.
- **Escalade** (`NetworkLadder`, `networkDecision`) : seule la classe `network` (géo-restriction, erreur de connexion) fait monter d'un barreau, sans retour en arrière. `rate_limited` → ralentir sur la même IP ; `forbidden`, `blocked_by_protection`, `robots_disallowed` → arrêt ; `auth_required`, `payment_required`, `account_limit` → `action_requise`. Chaque saut est journalisé (`hops`, `onHop` : niveau, proxy, motif) ; les identifiants n'y figurent jamais.
- **Garde SSRF** (`openNetworkSession`) : la connexion au proxy passe par une garde dédiée (`proxyGuardFor` : port du proxy seulement, privé refusé sauf `allow_private_address`, métadonnées cloud jamais) ; la cible est contrôlée localement (schéma, port, résolution) avant chaque tunnel, redirections comprises. Toujours `CONNECT`, y compris pour `http://`. Risque résiduel documenté : le proxy amont résout lui-même le nom (08 §2).
- **Coût** : `usage()` = octets émis et reçus sur les connexions au proxy × prix au Go + requêtes × prix par requête ; `RunProxyCost` cumule par essai pour `runs.cost_proxy_usd`.
- **Non couvert ici** : `tunnel` (2.6, 2.7) ; Chromium via un proxy BYO (chaînage du proxy d'egress, tâche 1.6) ; pour `socks5://`, la cible n'a que le contrôle statique local (pas de résolution locale avant le tunnel).
