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
