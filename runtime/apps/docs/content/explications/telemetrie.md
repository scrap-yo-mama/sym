---
title: "Télémétrie"
description: "Aucune donnée ne part vers l'éditeur : ce que cela couvre, ce qui reste local."
---

# Télémétrie

**La version 1.0 n'envoie rien à l'éditeur.** Ni statistiques d'usage, ni contrôle de version, ni rapport d'erreur, ni ressource chargée depuis un service tiers. Ce n'est pas un réglage qu'on désactive : il n'existe aucun code d'envoi à désactiver.

La règle de fond, dite « rien ne part sans décision explicite de l'administrateur », se lit ainsi : le trafic sortant d'une instance ne va qu'à des destinations **que vous avez configurées** : les sites que vous visez, votre fournisseur de modèle, vos proxys, votre courrier sortant, vos webhooks et votre collecteur OpenTelemetry.

## Ce que cela couvre

| Sujet | Version 1.0 |
|---|---|
| Statistiques d'usage | **aucune** |
| Vérification d'une version plus récente | **aucune** : `GET /api/version` est calculé localement (voir [Compatibilité des versions](../reference/compatibilite.md)) |
| Télémétrie de la bibliothèque d'authentification | **retirée** : ses variables d'activation sont supprimées de l'environnement au démarrage, avec un avertissement |
| Ressources de la console (polices, scripts, images, analytics) | **toutes locales**, aucune adresse externe |
| Ce site de documentation | **aucun traceur** ; la recherche est un index statique servi par le site lui-même |
| OpenTelemetry | **coupé par défaut** : ni l'API ni le SDK ne sont chargés. Si vous l'activez, les traces ne vont qu'à l'adresse que vous donnez, et aucun en-tête de trace ne part vers les sites cibles, les proxys ni le modèle |
| `/metrics` | **fermé par défaut** (404 sans jeton), calculé depuis la base, local |
| `DO_NOT_TRACK=1` | respecté, prioritaire sur tout réglage, pour le jour où un module de mesure existera |

## Ce qui reste local

- **`runtime diagnostics`** et le bouton de diagnostic de la console produisent un fichier JSON **masqué** (versions, noms des réglages, compteurs, classes d'échec). Il est écrit sur votre machine et **jamais envoyé** : c'est à vous de le joindre à un ticket, après l'avoir relu.
- Les journaux, les métriques et les traces restent chez vous.
- Les artefacts de run (captures, traces) sont désactivés par défaut.

## Comment c'est vérifié

Des tests de la suite automatique démarrent une instance vierge, exécutent un run, capturent **toutes** les connexions sortantes et échouent si l'une vise une destination qui n'est pas une cible, un modèle, un proxy, un courrier ou un webhook configurés. Le tutoriel de [Démarrage rapide](../tutoriels/quickstart.md) est rejoué avec la même preuve : aucune connexion ne quitte la machine. Un test garantit que OpenTelemetry n'est même pas chargé sans activation.

## Après la 1.0

Une mesure d'adoption **facultative** est envisagée après la 1.0, sous conditions strictes : **désactivée par défaut**, contenu affiché **avant** tout envoi, sans domaine ni URL cible, `DO_NOT_TRACK` respecté, et un avis juridique avant toute première collecte réelle. Elle n'existe pas dans cette version. Tant qu'elle n'existe pas, les signaux d'adoption du projet sont publics (étoiles, forks, tirages de l'image, discussions) : aucun chiffre n'est calculé à partir de vos instances.
