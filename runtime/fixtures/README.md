# Fixtures (tâche 0.5)

Serveur de sites de test locaux, lancé par `pnpm fixtures` (depuis `runtime/`). Un processus Fastify, **hôtes virtuels** choisis par l'en-tête `Host` (`zz_test_<id>.localhost`), écoute sur `127.0.0.1` uniquement (refus de toute autre adresse), aucune ressource externe, graine fixe, horloge pilotable. Variables : `FIXTURES_PORT` (4010), `FIXTURES_TOKEN`, `FIXTURES_SEED`. Les tests démarrent le serveur sur un port éphémère (`startFixtureServer({ port: 0 })`).

Comme `*.localhost` peut ne pas se résoudre selon le poste, un client se connecte à `127.0.0.1:<port>` et fixe `Host: zz_test_api_json.localhost:<port>`.

## Commandes (toutes hôtes confondus)

| Route | Rôle |
|---|---|
| `GET /health` | 200 sur chaque hôte virtuel (et sur un hôte inconnu) |
| `POST /__reset` | remet compteurs, journal, horloge (2026-01-01T00:00:00Z) et états de site à zéro |
| `GET /__stats[?host=h][&log=1]` | compteurs `hosts[h].paths[chemin]` (sans chaîne de requête, hors routes de contrôle) : base des assertions « 0 requête » ; `log=1` ajoute l'ordre et l'horodatage des requêtes (cadence) |
| `GET /__sites` | registre : id, lot, hôtes, requête de fumée |
| `POST /__control` | en-tête `x-zz-test-token` obligatoire, boucle locale seulement. `{"op":"clock.set","iso":"..."}`, `{"op":"clock.advance","seconds":60}`, `{"op":"site","site":"<id>", ...}` |

`/robots.txt` est permissif par défaut (`Disallow:` vide) sur les sites qui ne le servent pas eux-mêmes ; les sites O8 le servent.

## Les 32 sites

**Existantes (13)** : `api_json` (500 contacts, 6 mutations du banc : `rename_field`, `move_endpoint`, `wrap_in_envelope`, `change_pagination`, `type_change`, `out_of_schema`, `empty`), `ssr`, `spa` (`/tiers` : ressources tierces vers `zz_test_evil` ; `mode` `hostile` : coquille qui gonfle les lectures dans la page), `login` (`zz_test_user` / `zz_test_pass`, 401 JSON, expiration), `challenge` (403), `429`, `geo`, `injection` (+ domaine piège `zz_test_evil`), `dom` (`version` 1 ou 2), `signed403` (signature FICTIVE, `/plain-forbidden` sans signature), `irregular`, `503`, `challenge_200` (défi servi en HTTP 200 ; `resolve_after_ms` : le défi se résout seul en JavaScript, cookie puis rechargement, pour vérifier qu'attendre ne franchit jamais un défi).

**Ajouts Q1 (5)** : `ssrf` (hôtes `zz_test_internal`, `zz_test_metadata`, redirections vers `169.254.169.254`, RFC 1918, encodages d'IP), `slow` (`?wait_seconds=`), `volume` (`mode` : `normal`, `anomaly`, `empty`, `short`), `personal` (noms `Zztest`, e-mails `.invalid`, téléphones de fiction), `scroll`.

**Ajouts S5 (6)** : `next` (`__NEXT_DATA__`), `nuxt` (`__NUXT_DATA__` à plat, `window.__NUXT__`), `apollo` (`__APOLLO_STATE__`), `jsonld`, `cursor`, `linkheader`.

**Accès O8 (8)** : `robots` (`Disallow: /prive/`), `robots_4xx`, `robots_5xx` (dont connexion coupée), `robots_redirect`, `robots_big` (> 500 Kio), `robots_crawl_delay`, `content_signal`, `payment_402` (`crawler-price`).

Les fixtures de défi et de 403 sont des **simulations génériques de détection** : page interstitielle générique, en-têtes `x-zz-test-shield*` fictifs, aucun script ni formulaire. Elles servent à vérifier que le produit s'arrête.

## Tests

`smoke.unit.test.ts` (inventaire, `/health` de chaque hôte, requête de fumée), `contracts.contract.test.ts` (une entrée par site, plus des contrats transverses), `server.unit.test.ts` (socle : boucle locale, jeton, compteurs, reset, horloge, graine, absence d'URL externe).

## Reste à faire

- `TODO(3.11-copie-embarquee-d0)` : la copie embarquée du site de démo D0 (pagination sur 1 000 livres, servie par l'instance et non par ce processus, CDC 02 parcours 0, CDC 06 A12) n'est spécifiée nulle part en détail : elle reste à définir et à construire en tâche 3.11.
- Le rebinding DNS (nom qui se résout d'abord en public puis en privé) ne se simule pas dans ce serveur : il relève d'un résolveur de test (0.7 / 1.x).
