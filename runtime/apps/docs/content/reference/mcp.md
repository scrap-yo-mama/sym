---
title: "Serveur MCP"
description: "Outils génériques, outils par API, enveloppe de résultat, modes d'exposition et erreurs."
---

# Serveur MCP

Le serveur MCP est la porte d'entrée « pour votre IA » : on ajoute l'instance à son client MCP, puis on demande une donnée en langage naturel. L'IA appelle des outils ; derrière, l'agent enquête, enregistre une API au catalogue et la rejoue ensuite à coût de code. Le même catalogue est accessible par l'[API REST](./rest.md).

::: info Disponibilité
Le serveur MCP (`/mcp`) est livré : outils génériques, outils par API, enveloppe de résultat, erreurs, contrôle de `Origin` et `Host`, métadonnées RFC 9728. Ne le sont pas encore : le récit détaillé de l'enquête, la progression, les prompts et l'élicitation (expérience MCP). Le dossier d'enquête `brief` de `create_api` est lu : contrôlé (schéma fermé, 16 000 octets, secrets refusés), masqué, enregistré avec l'API ; chaque indice est vérifié par SYM avant usage, et la réponse porte `brief_report` et le récit du dossier, sans recopier son texte. La suite de conformité MCP officielle est jouée en CI, avec ses écarts attendus commentés.
:::

## Se connecter

- **URL** : `https://<votre-instance>/mcp`.
- **Authentification** : une [clé d'API](../guides/comptes.md#cles-d-api) en `Authorization: Bearer`. Les portées de la clé limitent les outils disponibles : la liste d'outils ne montre que ceux que la clé peut appeler, et l'appel d'un outil hors de ses portées répond 403 `insufficient_scope`. Le propriétaire de la clé limite les données.
- **Transport** : Streamable HTTP, sans état, spécification MCP `2026-07-28` (voir [Compatibilité des versions](./compatibilite.md)).
- **Protection** : un en-tête `Origin` présent est comparé en entier (schéma, hôte et port) à l'origine de l'instance et à `MCP_ALLOWED_ORIGINS` ; non autorisé, il est refusé (403). L'en-tête `Host` est contrôlé, et les métadonnées de ressource protégée (RFC 9728) sont servies avec un `WWW-Authenticate` qui y renvoie. OAuth 2.1 viendra après la première version.

## Les outils génériques

| Outil | Entrée | Sortie |
|---|---|---|
| `create_api` | `description`, `url`, et facultativement `example_output`, `brief`, `auto_validate`, `network_policy`, `wait_seconds` | identifiant, schéma de sortie proposé, échantillon, rapport d'accès et récit de l'enquête ; ou le résultat d'un run avec `auto_validate` |
| `validate_schema` | `api_id`, et facultativement un `output_schema` corrigé | résultat d'un run (ou « en cours ») |
| `run_api` | `slug` ou `api_id`, `input`, et facultativement `wait_seconds`, `force_investigate` | résultat d'un run |
| `get_run` | `run_id` | résultat d'un run |
| `get_items` | `run_id` ou `dataset_id`, `cursor`, `limit` (200 au plus), `fields` | items et curseur suivant |
| `cancel_run` | `run_id` | run annulé et coût engagé (les coûts déjà engagés restent imputés) |
| `list_apis` | `status`, `q`, `limit`, `cursor` | API du catalogue : statut, raison, drapeau `stale`, exécution, réseau, coût moyen |
| `get_api` | `slug`, `response_format` (`concise` ou `detailed`) | fiche : schémas, stratégie courante, derniers runs, statut, rapport d'accès |
| `report_problem` | `slug`, `run_id`, `note` | identifiant du problème consigné dans le journal de l'API |

Les outils sont regroupés en **jeux** (`build`, `run`, `catalog`), activables par `?toolsets=` : un consommateur du catalogue n'a pas besoin de `build`. Les outils de lecture (`get_*`, `list_apis`) portent l'annotation `readOnlyHint`. Les annotations sont des aides pour le client : les droits restent côté serveur.

## Les outils par API

Selon `MCP_TOOL_EXPOSURE`, chaque API peut aussi devenir un outil nommé **`api_<slug>`**, dont le schéma d'entrée est celui de l'API.

| Mode | Outils exposés | Pour qui |
|---|---|---|
| `generic` | aucun outil par API : tout passe par `run_api` et `list_apis` (paginé, avec recherche) | un grand catalogue, ou un client qui gère mal beaucoup d'outils |
| `pinned` (défaut) | les API que leur propriétaire a épinglées, 20 au plus | l'usage courant |
| `all` | toutes les API, 20 au plus ; au-delà de 30 API, le mode `pinned` est conseillé | une petite instance |

Une API nouvellement créée n'est **pas épinglée** : en mode `pinned`, son outil apparaît une fois que son propriétaire l'a épinglée (dans la console, ou par `PATCH /api/apis/{slug}` avec `mcp_exposed: true`). Les outils par API ne viennent que de **vos** API : une API partagée par un autre membre n'est jamais un outil de votre liste (elle reste accessible par `list_apis` et `run_api`), pour qu'aucun membre ne place de description ni de schéma dans l'outillage d'un autre.

La description d'un outil par API est **figée** : elle ne contient pas le statut, pour ne pas changer la liste d'outils à chaque transition. Quand **votre** liste change, le serveur le signale aux clients abonnés (`subscriptions/listen`, spécification `2026-07-28`) ; l'abonnement se ferme si la clé est révoquée ou le compte désactivé, et une clé ouvre au plus 4 abonnements à la fois (8 par compte). Si un outil n'apparaît pas, reconnectez le serveur.

## L'enveloppe de résultat

Toute exécution renvoie la même enveloppe (c'est aussi l'`outputSchema` des outils `api_<slug>`) :

```json
{
  "run_id": "uuid",
  "state": "succeeded",
  "status": "sain",
  "items": [],
  "total": 48,
  "dataset_id": "uuid",
  "truncated": true,
  "next_cursor": "opaque",
  "degraded_reasons": [],
  "message": "une phrase",
  "next_action": { "tool": "get_items", "args": {} },
  "poll_after_seconds": null,
  "timeline": [],
  "cost": {},
  "console_url": "https://…"
}
```

Une réponse contient **20 items au plus** (et un ordre de grandeur de 10 000 jetons) : au-delà, `truncated` vaut vrai et `get_items` pagine. Les items sont **toujours conformes** au schéma de sortie de l'API : une sortie hors schéma n'est jamais présentée comme un succès.

Un admin ou l'owner qui lit par `get_run` le run d'un autre utilisateur reçoit ses **métadonnées seulement** (état, coût, nombre d'items, `metadata_only: true`, `items` vide), comme `GET /api/runs/{id}` ; jamais ses items, son entrée ni son jeu de données. Cette lecture est journalisée.

## Le récit de l'enquête

Pendant une enquête, le texte de la réponse raconte ce qui s'est passé, parce que c'est le seul canal que tous les clients affichent :

```text
Enquête zz-books · books.toscrape.com · testing
1. Rapport d'accès : conditions du site signalées, plan du site trouvé [0,2 s, 0 $]
2. Reconnaissance : pas d'API JSON, pagination ?page= [3,1 s, 0,002 $]
3. Essai fetch/direct : conforme, 20 items, page 2 OK [0,4 s, 0 $]
Stratégie retenue : fetch/direct (E1, 0 $ par run)
Prochaine étape : appelle api_zz_books({ max_pages }) ou run_api.
Console : https://<instance>/apis/zz-books
```

Les mêmes faits sont dans `structuredContent` (`timeline`, `attempts`, `console_url`, `cost`). Le **rapport d'accès** (signaux d'usage, conditions du site) est toujours la première ligne : voir [Usage responsable](../explications/usage-responsable.md).

## Runs longs

Les outils acceptent `wait_seconds` (25 par défaut et au plus). Au-delà, ils renvoient `{ run_id, state: "running", poll_after_seconds }` et l'IA interroge `get_run`. Un run complet à la cadence par défaut (1,5 seconde entre deux requêtes vers un domaine) dure plusieurs minutes : le mode asynchrone est la règle, pas l'exception.

## Erreurs

Une erreur est un texte JSON avec `isError`, jamais une exception muette :

| Champ | Sens |
|---|---|
| `failure_class` | la classe du classifieur (voir [Statuts et classes d'échec](./statuts-et-raisons.md)) |
| `what_to_do` | ce que l'IA ou l'utilisateur peut faire, parmi une liste fermée de gabarits |
| `retryable` | si un nouvel essai a un sens |
| `access` | le rapport d'accès, quand il explique l'erreur |

Un outil inconnu, ou retiré depuis la dernière liste du client, répond `not_found` avec `list_apis` pour prochaine action ; une erreur interne de l'instance répond `internal`, sans son détail (journalisé côté serveur).

Une API **`bloquee`** répond `retryable: false`, et l'instruction du serveur dit explicitement de **ne jamais réessayer en boucle**. Les gabarits de message ne proposent jamais de moyen de passer outre un refus : aucun outil ne propose de changer de réseau ou de basculer sur le tunnel à cause d'un blocage.

## Prompts et élicitation

Quatre prompts MCP : `new_api` (créer une API), `fix_api` (réparer), `first_steps` (la démonstration D0) et `review_catalog` (passer le catalogue en revue). Si le client déclare l'élicitation, `create_api` pose une question plate (« Valider ce schéma ? ») avec le schéma en texte ; sinon on reste sur `validate_schema`. **Aucun secret** ne transite jamais par une élicitation.

## Contenu non fiable

Le contenu d'une page lue peut contenir des instructions destinées à tromper votre IA (injection de prompt). Les défenses côté serveur : aucune donnée collectée n'entre jamais dans le nom ni la description d'un outil ; les sorties sont strictement typées par le schéma ; les signaux d'usage lus sur un site (par exemple une demande de ne pas utiliser le contenu pour l'IA) sont des **données affichées**, jamais des consignes transmises au modèle. Votre IA reste libre de se méfier de ce qu'elle lit : un mode sans texte libre est disponible pour les schémas qui n'en ont pas besoin.
