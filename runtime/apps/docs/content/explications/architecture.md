---
title: "Architecture"
description: "Serveur, worker, PostgreSQL, échelle des stratégies, enquête et machine à états."
---

# Architecture

## L'idée

Une API du catalogue joue le même rôle qu'un « acteur » d'une plateforme de scraping, avec une différence : c'est un agent qui l'a fabriquée. Vous demandez une donnée (« les annonces de cette page, avec la pagination »). Un agent **enquête** pour trouver **la méthode la moins chère qui produit la sortie demandée**, l'enregistre comme une API (avec un schéma de sortie et un schéma d'entrée), puis la **rejoue** ensuite à coût de code. Si elle casse, il la **répare** et suit son état.

« Qui marche » veut dire : la sortie est **conforme au schéma validé**, pagination comprise, sur plusieurs échantillons. « Le moins cher » est un coût estimé par run qui additionne le modèle IA, le proxy et le calcul. On ne paie l'agent que s'il n'existe rien de moins cher.

## Les pièces

```text
 Votre IA / vos scripts / la console
          │ REST · MCP · console
          ▼
 ┌────────────────────┐         ┌──────────────────────────┐
 │ Service web        │         │ Service worker           │
 │ REST, MCP, console │         │ accès, enquête,          │
 │ passerelle tunnel  │         │ exécuteurs E1 à E6,      │
 │ comptes, clés      │         │ réseau, bac à sable,     │
 └─────────┬──────────┘         │ réparation, navigateur   │
           │                    └────────────┬─────────────┘
           └────────────┬────────────────────┘
                        ▼
              PostgreSQL (le vôtre)
              données + file de jobs
```

- **Le web reçoit, le worker exécute, PostgreSQL fait le lien** : les données et la file de jobs sont dans la même base, sans Redis ni autre service. On peut lancer les deux dans un seul processus (`RUNTIME_MODE=all`) pour un petit budget.
- **Une seule image**, un mode par rôle : `server`, `worker`, `all`, `migrate`. Voir [Déployer une instance](../guides/deploiement.md).
- **Tout est à vous** : la base, le modèle IA, les proxys. L'éditeur n'a aucun accès ([Télémétrie](./telemetrie.md)).

## Le flux d'un run

1. Le web insère le run **et** son job dans la même transaction. Un balayeur remet en file les runs orphelins.
2. Un worker prend le job, inscrit régulièrement un battement, charge la stratégie courante et exécute.
3. Le worker valide la sortie contre le schéma, écrit le jeu de données, met à jour le statut et publie les événements de l'enquête.
4. Le web répond de façon **synchrone** si le run finit avant `wait` (25 secondes au plus), sinon avec un identifiant de run à suivre.

Si un worker est tué en plein run, le run est repris ou échoue : il ne reste jamais bloqué « en cours ». À l'arrêt propre (`SIGTERM`), un worker cesse de prendre des jobs et termine ou remet en file ce qui reste.

## L'échelle des stratégies

La stratégie d'une API est un couple **exécution × réseau**.

| Exécution | Ce qui tourne | Modèle IA à chaque run ? |
|---|---|---|
| E1 `fetch` | une requête HTTP vers une API trouvée (JSON, GraphQL, données embarquées dans la page), extraction **déclarative** | non |
| E2 `fetch_in_page` | un navigateur ouvert sur le site, avec un `fetch` exécuté dans la page | non |
| E3 `playwright` | un script de navigateur déterministe, en bac à sable | non |
| E4 `agent_fetch` | les données d'E1 ou d'E2, mises en forme par le modèle | oui, peu |
| E5 `hybrid` | un script dont certaines étapes sont déléguées à l'agent | oui, par étape |
| E6 `agent` | l'agent pilote le navigateur de bout en bout | oui, beaucoup |

| Réseau | Mode |
|---|---|
| N1 `direct` | l'adresse de votre hébergeur |
| N2 `dc_proxy` | un proxy serveur que **vous** avez configuré |
| N3 `res_proxy` | un proxy résidentiel que **vous** avez configuré, activé API par API, pour des motifs réseau seulement |
| T `tunnel` | **votre** navigateur, avec votre adresse et votre session, par l'extension, quand l'API l'exige ou que vous l'avez choisi |

Les couples autorisés sont triés par **coût estimé croissant** : on essaie le moins cher d'abord, et chaque couple écarté est journalisé avec sa raison. Une trace d'agent réussie (E6) est compilée en script (E5), puis rejouée sans modèle quand c'est possible : un succès est alors une baisse de coût. Les budgets (essais, durée, coût par run) bornent le tout.

## L'enquête

1. **Rapport d'accès, avant tout** : sonde de l'adresse (signaux d'usage `Content-Signal`, `tdm-reservation`, `Content-Usage`, affichés sans bloquer ; conditions du site signalées ; flux et API officielle ; réponse 402 affichée, sans paiement), puis `/llms.txt` et `/sitemap.xml` en sondes passives. Le `robots.txt` est une source d'information que l'agent peut consulter, par exemple pour trouver le sitemap ; il ne conditionne pas la collecte.
2. **Reconnaissance** : le trafic réseau de la page est capturé, et les données embarquées (états de framework, JSON-LD) sont cherchées avant de conclure qu'il n'y a pas d'API. Un jeton calculé côté client rend la voie « non supportée », sans tentative de le reproduire.
3. **Schéma de sortie proposé**, avec un échantillon : vous le validez ou le corrigez (ou l'agent le valide seul avec `auto_validate`).
4. **Essais par coût croissant**, élagués par le classifieur d'échec. « Ça marche » = sortie conforme sur plusieurs exécutions, dont la page 2 si l'API est paginée.
5. **Schéma d'entrée proposé**, puis la stratégie v1 : l'API est « Saine ».

Un refus, un défi ou une connexion requise **arrête l'enquête** : statut « Bloquée » ou « Action requise », sans aucune escalade. Voir [Statuts et classes d'échec](../reference/statuts-et-raisons.md).

## La réparation

Quand un rejeu casse (sélecteur introuvable, format changé, sortie hors schéma), la **garde de classification** passe d'abord : un refus n'est jamais envoyé à la réparation, et l'agent ne reçoit jamais une page de défi. Pour une vraie casse :

1. l'agent reçoit la stratégie, les journaux masqués, le diff de forme et le schéma, et propose un correctif **borné** (jamais sur les hôtes autorisés ni la session) ;
2. le résultat est validé contre le schéma **d'origine**, qui ne change jamais pendant une réparation, et contre les champs stables des dernières sorties saines ;
3. sinon, escalade selon l'ordre de coût ;
4. un succès enregistre la version suivante, l'API passe en « À surveiller » ;
5. arrêt si le budget est épuisé ou si le même correctif est proposé deux fois : l'API passe en « En erreur » et la stratégie précédente est conservée.

## Les invariants

Quelques règles ne se négocient pas, et chacune est un test nommé :

- **La sortie est toujours conforme au schéma validé.** Un résultat hors schéma n'est jamais un succès.
- **Le moins cher d'abord**, chaque essai journalisé avec son coût.
- **Le statut suit une machine à états fermée** (22 transitions).
- **Chaque run est tracé** : stratégie, mode d'exécution, réseau, coût, classe d'échec.
- **Une session appartient à son propriétaire**, sans impersonation.
- **Aucun contournement intégré** ([Hors périmètre](./hors-perimetre.md)).
- **Le code généré tourne en bac à sable**, **les secrets sont chiffrés**, **rien ne part vers l'éditeur**, **toute sortie réseau passe la garde SSRF**, **les utilisateurs sont isolés**. Voir [Sécurité](./securite.md).

## La pile technique

TypeScript sur Node 24, Fastify, PostgreSQL (Drizzle, file pg-boss), Playwright et Chromium dans l'image, `isolated-vm` pour le bac à sable, Ajv pour la validation des schémas, Vue 3 pour la console, WXT pour l'extension Chrome, VitePress et Pagefind pour ce site. Les versions exactes sont figées dans le fichier de verrouillage du dépôt.
