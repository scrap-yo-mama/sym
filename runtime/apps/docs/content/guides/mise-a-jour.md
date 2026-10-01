---
title: "Mettre à jour et revenir en arrière"
description: "De la version N-1 à N, et le seul retour arrière qui tienne : image précédente et restauration."
---

# Mettre à jour et revenir en arrière

## Mettre à jour (de N-1 à N)

1. Lisez la section « Migration cassante » des notes de la version visée.
2. **Sauvegardez** la base (voir [Sauvegarder et restaurer](./sauvegarde.md)). `MASTER_KEY` doit déjà être rangée à part.
3. Changez le tag d'image épinglé `X.Y.Z`. Ne sautez jamais une version majeure : passez par chaque version publiée. Il n'existe pas de tag `latest`.
4. Redéployez : `runtime migrate` d'abord (étape de pré-déploiement ou service `migrate`), puis `server` et `worker`.
5. Vérifiez `GET /api/ready` = 200, la version affichée par `GET /api/version`, et `runtime doctor`.

La montée d'une version à la suivante est garantie. Les montées qui sautent une version ne sont pas supportées avant la 1.0, et la politique de support est : avant la 1.0, la dernière version mineure seule, sans rétroportage.

### Ce qui se passe pendant la migration

- Le `worker` ne migre jamais : il attend la version de schéma que son code attend.
- Un `server` démarré sur un schéma **en retard** entre en mode dégradé : `/api/health` répond 200, `/api/ready` répond 503 et tout le reste répond 503, jusqu'à ce que `runtime migrate` ait passé. Il termine ensuite son démarrage tout seul.
- Un `server` ou un `worker` dont le code est **plus ancien** que le schéma refuse de démarrer, avec un message qui renvoie à la restauration. C'est la garde contre un retour d'image sans restauration.
- `runtime migrate` est idempotent et pris sous un verrou : deux lancements simultanés appliquent chaque migration une seule fois.

## Revenir en arrière

Il n'existe **pas de migration descendante en production** : `runtime migrate down` est refusé quand `NODE_ENV=production`, et les scripts de descente ne servent qu'aux tests. Un retour arrière, c'est donc **les deux ensemble** :

1. **L'image précédente.**
2. **La restauration** de la sauvegarde prise juste avant la migration, dans une base neuve.

Remettre l'ancienne image sans restaurer échoue au démarrage (schéma plus récent que le code). La marche à suivre : restaurez dans une base neuve ([Sauvegarder et restaurer](./sauvegarde.md#restaurer-sur-une-base-neuve)), pointez `DATABASE_URL` dessus, redéployez l'image N-1. Les runs faits entre la sauvegarde et le retour arrière sont perdus : c'est pourquoi la correction vers l'avant reste préférable dès qu'elle est possible.

## Changements cassants

Chaque release publie des notes de migration. Un changement cassant porte le label `breaking`, une entrée du guide de migration et, côté commit, un pied `BREAKING CHANGE:`. Avant la 1.0, un changement cassant monte la version mineure. Les versions, les canaux (`stable`, `beta`) et la vérification des signatures sont décrits dans [Compatibilité des versions](../reference/compatibilite.md).

## Aucune vérification de version à distance

L'instance **n'interroge aucun serveur** pour savoir si une version plus récente existe : ce serait une donnée qui part vers l'éditeur. Abonnez-vous aux annonces du projet ou surveillez ses releases vous-même. Voir [Télémétrie](../explications/telemetrie.md).
