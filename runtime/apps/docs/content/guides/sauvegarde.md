---
title: "Sauvegarder et restaurer"
description: "Deux objets à garder : la base et la clé maîtresse ; restauration sur une base neuve."
---

# Sauvegarder et restaurer

Une sauvegarde complète tient en **deux objets** : la base PostgreSQL et `MASTER_KEY`. Gardez-les **séparément** : la clé dans un gestionnaire de mots de passe, jamais dans le même coffre que le dump. Sans la clé, les secrets enregistrés sont illisibles ; avec la clé mais sans la base, vous n'avez plus rien à déchiffrer.

Les commandes `runtime …` se lancent dans l'image : `docker exec <conteneur> node /app/apps/cli/dist/index.js doctor`, avec les mêmes variables d'environnement que `server` (`DATABASE_URL`, `MASTER_KEY`). La liste complète est dans la [référence de la ligne de commande](../reference/cli.md).

## Sauvegarder

```bash
pg_dump --format=custom --no-owner --file=runtime-$(date +%F).dump "$DATABASE_URL_DIRECT"
runtime backup declare
```

- À faire **avant chaque mise à jour**. `pg_dump` est cohérent sous charge.
- `DATABASE_URL_DIRECT` est la connexion directe à la base. Si vous n'avez pas de pooler, c'est `DATABASE_URL`.
- `runtime backup declare` note la date de la sauvegarde : `runtime doctor` avertit quand elle date de plus de 7 jours.
- Gardez le dump hors du serveur qui héberge la base, et chiffrez-le comme n'importe quelle donnée : il contient vos jeux de données.
- Ne restaurez que des dumps de confiance.

## Restaurer sur une base neuve

Une restauration crée toujours une **nouvelle base**, souvent sur un autre cluster. Le rôle `runtime_app`, utilisé par l'application pour que la sécurité au niveau des lignes s'applique, est un objet du *cluster* : `pg_dump` ne l'emporte pas, et les droits du dump échoueraient sans lui. Il faut donc, dans l'ordre :

```bash
createdb runtime_restore
DATABASE_URL=postgres://…/runtime_restore runtime restore-prepare
pg_restore --no-owner --clean --if-exists --dbname=runtime_restore runtime-2026-09-30.dump
```

Puis changez `DATABASE_URL` (la `MASTER_KEY` reste **la même**) et démarrez : l'instance est prête sans autre réglage. Vérifiez avec `runtime doctor`. **Une restauration se teste** dans une base jetable, avant le jour où vous en avez besoin.

Si `runtime doctor` signale `app_role_missing` ou `app_role_no_grants`, la restauration a été faite sans `restore-prepare` : recommencez sur une base vide.

## Exporter le catalogue

```bash
runtime export-catalog --out catalogue.json
```

Le fichier contient les API, leurs schémas, leurs stratégies et leurs planifications, **sans secret, sans cookie, sans donnée de run**. Il sert à migrer ou à archiver un catalogue. Il n'existe pas d'option pour y inclure les secrets : on les ressaisit sur l'instance de destination, car un fichier d'export chiffré par une phrase serait un second coffre à protéger. L'import repasse par l'enquête (rapport d'accès compris).

## Si vous perdez MASTER_KEY

Deux cas, selon que vous avez encore l'ancienne clé.

- **Vous avez encore l'ancienne clé** : faites une rotation (`runtime rekey --confirm`, avec la nouvelle clé dans `MASTER_KEY` et l'ancienne dans `MASTER_KEY_PREVIOUS`, après une sauvegarde).
- **La clé est perdue pour de bon** : arrêtez `server` et `worker`, générez une nouvelle clé (`runtime keygen`), posez-la dans `MASTER_KEY`, puis :

```bash
runtime secrets accept-key-loss            # montre ce qui sera fait, ne modifie rien
runtime secrets accept-key-loss --confirm
```

Les secrets sont **conservés** à l'état « À ressaisir » (illisibles), les sessions de site chiffrées sont vidées (les cookies sont à recapturer), les artefacts de run chiffrés sont supprimés, et le témoin de clé est réécrit pour la clé courante. Rien n'est jamais déchiffré ni deviné, et l'ancienne clé n'est plus acceptée ensuite. Ressaisissez les secrets dans les réglages, puis relancez les API concernées : leur statut n'est pas modifié par la commande.

## Vérifier régulièrement

Une sauvegarde qu'on n'a jamais restaurée n'est pas une sauvegarde. Chaque trimestre : restaurez le dump dans une base jetable avec une copie de la clé, lancez `runtime doctor` sur cette base, puis jetez-la.
