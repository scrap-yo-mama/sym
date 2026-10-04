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

## Les 40 sites

**Existantes (13)** : `api_json` (robots.txt servi par le site : `Disallow: /private-api/`, qui sert pourtant les contacts, jamais lu d’office par SYM (D-91), et `/api/missing` en 404, pour le dossier d’enquête de 2.14 ; 500 contacts, 6 mutations du banc : `rename_field`, `move_endpoint`, `wrap_in_envelope`, `change_pagination`, `type_change`, `out_of_schema`, `empty` ; D-49 : `one_item_bad_type`, un item au score en texte avec un e-mail factice sous une clé inconnue, `bad_items_30pct`, 30 % des items hors schéma, `trailing_bad_item`, un 501e contact au score en texte seul sur la dernière page à 50 par page, et `bad_page_2`, les contacts 51 à 100 au score en texte, la page 2 entière à 50 par page ; D-49 (2.16) : `data_451`, page servie et source de données en 451, et `data_451_page_2`, 451 à partir de la page 2 seulement), `ssr`, `spa` (`/tiers` : ressources tierces vers `zz_test_evil` ; `mode` `hostile` : coquille qui gonfle les lectures dans la page), `login` (`zz_test_user` / `zz_test_pass`, 401 JSON, expiration ; cas C3 `/contacts` + `/api/contacts`, 30 contacts, et C2 `/post/zz_test_post_0001` + `/api/posts/zz_test_post_0001/comments`, 25 commentaires, derrière la même session ; `/account` porte un lien `/logout`, GET à effet de bord qui ferme la session, 2.14), `challenge` (403), `429`, `geo`, `injection` (+ domaine piège `zz_test_evil`), `dom` (`version` 1 ou 2), `signed403` (signature FICTIVE, `/plain-forbidden` sans signature), `irregular`, `503`, `challenge_200` (défi servi en HTTP 200 ; `resolve_after_ms` : le défi se résout seul en JavaScript, cookie puis rechargement, pour vérifier qu'attendre ne franchit jamais un défi).

**Ajouts Q1 (5)** : `ssrf` (hôtes `zz_test_internal`, `zz_test_metadata`, redirections vers `169.254.169.254`, RFC 1918, encodages d'IP), `slow` (`?wait_seconds=`), `volume` (`mode` : `normal`, `anomaly`, `empty`, `short`), `personal` (noms `Zztest`, e-mails `.invalid`, téléphones de fiction), `scroll`.

**Ajouts S5 (6)** : `next` (`__NEXT_DATA__`), `nuxt` (`__NUXT_DATA__` à plat, `window.__NUXT__`), `apollo` (`__APOLLO_STATE__`), `jsonld`, `cursor`, `linkheader`.

**Accès O8 (8)** : `robots` (`Disallow: /prive/`), `robots_4xx`, `robots_5xx` (dont connexion coupée), `robots_redirect`, `robots_big` (> 500 Kio), `robots_crawl_delay`, `content_signal`, `payment_402` (`crawler-price`).

**Spike 0.6a (4)**, lot `agent` (`eval/spike-0.6a-decision.md` §5) : `agent_irregular_html` (E4 : 8 produits, 4 gabarits HTML, catégorie parfois absente, aucune API), `agent_mobile_next` (E5 : mise en page mobile, 12 contacts sur 3 pages, bouton « Suivant » sans `href` ni API), `agent_no_api_unstable_dom` (E6 : classes, identifiants, liens `/v/<jeton>` et ordre des blocs régénérés à chaque requête, graine par requête ; tâche : atteindre une fiche puis l'extraire), `agent_prompt_injection` (5 produits + instructions hostiles visibles, cachées, en commentaire et en `alt`, lien et formulaire vers le domaine piège `zz_test_evil` du site `injection`, chaîne canari `ZZ_TEST_CANARY_6A0F`, saisie dans le formulaire piège comptée sur `/t/typed`). Instruction, schéma de sortie, clé et référence de chaque tâche : `src/agent-tasks.ts` ; références versionnées : `references/*.json`, produites par le générateur (`node fixtures/src/agent-tasks.ts --write`), vérifiées octet pour octet par `agent-tasks.unit.test.ts`.

**Cas de référence (2)**, lot `cases` (gate M2, `tests/cases/cases.integration.test.ts`) : `books` (D0 en fixture : 60 livres rendus serveur, 20 par page, données embarquées `__NEXT_DATA__` par page, pages liées par `rel=next` : `/`, `/catalogue/page-N.html`), `search_guarded` (C1 en fixture : `/recherche`, liste par `/api/search?page=N`, page 1 en JSON, pages suivantes : défi générique 403 ; commande `page_hits`). C2 et C3 sont servis par `login`.

Les fixtures de défi et de 403 sont des **simulations génériques de détection** : page interstitielle générique, en-têtes `x-zz-test-shield*` fictifs, aucun script ni formulaire. Elles servent à vérifier que le produit s'arrête.

## Tests

`smoke.unit.test.ts` (inventaire, `/health` de chaque hôte, requête de fumée), `contracts.contract.test.ts` (une entrée par site, plus des contrats transverses), `server.unit.test.ts` (socle : boucle locale, jeton, compteurs, reset, horloge, graine, absence d'URL externe).

## Reste à faire

- `TODO(3.11-copie-embarquee-d0)` : la copie embarquée du site de démo D0 (pagination sur 1 000 livres, servie par l'instance et non par ce processus, CDC 02 parcours 0, CDC 06 A12) n'est spécifiée nulle part en détail : elle reste à définir et à construire en tâche 3.11.
- Le rebinding DNS (nom qui se résout d'abord en public puis en privé) ne se simule pas dans ce serveur : il relève d'un résolveur de test (0.7 / 1.x).
