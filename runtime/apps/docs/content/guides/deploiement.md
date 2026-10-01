---
title: "Déployer une instance"
description: "Choisir l'hébergement, préparer les variables et la clé maîtresse, vérifier que l'instance répond."
---

# Déployer une instance

Une instance Scrapyomama Runtime, c'est une **image unique**, une **base PostgreSQL** que vous fournissez, et trois valeurs à régler : l'adresse publique, la clé maîtresse et le jeton du premier démarrage. Cette page donne la liste de contrôle commune à tous les hébergeurs. Les pages suivantes la déclinent pour chaque cible.

::: warning Modèles de déploiement
Les modèles prêts à l'emploi (`render.yaml`, `docker-compose.prod.yml`, modèle Railway, `heroku.yml`) accompagnent la première release publique. En attendant, chaque guide décrit la configuration à reproduire à la main : elle reste valable quand le modèle existera, il ne fera que la poser pour vous.
:::

## Choisir une cible

| Cible | Statut | À choisir si |
|---|---|---|
| [Render](./render.md) | Cible de référence | vous voulez un service géré, une base managée et un déploiement sans machine à administrer |
| [Docker Compose](./docker-compose.md) | Cible de référence | vous avez un VPS, Coolify ou Dokploy, ou vous voulez tout garder chez vous |
| [Railway, Heroku et autres](./autres-hebergeurs.md) | Best-effort | vous y avez déjà vos projets ; l'échec d'un de ces modèles ne bloque jamais une release |

## Ce que tout hébergeur doit fournir

1. **Une image** en `linux/amd64`, démarrée sans uid imposé : elle démarre en root et descend aussitôt sur un utilisateur non-root, aucun processus de l'application ne reste root (le worker garde seulement, en permis, les deux capacités qui font changer d'utilisateur le bac à sable ; `no-new-privileges` est admis). Une commande lancée par `docker exec` sans `-u`, ou une sonde de santé en forme commande, tourne en root : utilisez `-u pwuser` ou la commande `runtime`, qui descend d'elle-même. Le mode se choisit par `RUNTIME_MODE` : `server` (REST, console, passerelle du tunnel), `worker` (enquête, exécuteurs, navigateur), `all` (les deux dans un conteneur, pour un petit budget ou un premier essai), `migrate` (applique les migrations puis s'arrête). Sans valeur, le mode est `all`.
2. **PostgreSQL 15 ou plus** (16 recommandé, la CI couvre 16, 17 et 18), avec au moins 10 Go. Une version inférieure à 15 est refusée avec un message qui nomme la version trouvée.
3. **De la mémoire pour le navigateur du worker** : Chromium est dans l'image. Comptez 2 Go au minimum pour un worker (une exécution navigateur à la fois), 4 Go pour deux. Le nombre d'exécutions navigateur simultanées se déduit de la limite mémoire du conteneur ; `BROWSER_CONCURRENCY` la fixe à la main.
4. **Un proxy inverse qui fait le TLS** : l'instance n'embarque pas de TLS. Derrière un proxy, réglez `TRUST_PROXY` (voir plus bas).
5. **Un chemin de contrôle de santé** : `GET /api/ready` (200 quand tout va bien, 503 avec la liste des contrôles en échec sinon). `GET /api/health` est la sonde de vivacité : elle ne touche pas la base et répond même pendant une migration.

## Les variables à régler

La liste complète est dans la [référence des variables](../reference/variables-environnement.md). Pour un premier déploiement, cinq suffisent.

| Variable | Valeur | Remarque |
|---|---|---|
| `DATABASE_URL` | URL de la base | `sslmode` se règle dans l'URL, par exemple `?sslmode=require` chez un hébergeur de base managée |
| `MASTER_KEY` | `openssl rand -base64 32` | 32 octets en base64 (44 caractères), sans phrase secrète. **À sauvegarder hors de la plateforme.** `MASTER_KEY_FILE` accepté |
| `PUBLIC_URL` | `https://runtime.example.org` | l'adresse que vos utilisateurs, l'extension et votre IA utilisent ; sert aux cookies `Secure` et au contrôle d'`Origin` |
| `ADMIN_BOOTSTRAP_TOKEN` | `openssl rand -base64 32` | 32 caractères au moins ; exigé tant qu'aucun propriétaire n'existe. `_FILE` accepté |
| `TRUST_PROXY` | `1` derrière un proxy | un saut ; ou la liste des adresses du proxy. Ne posez jamais `true` sans proxy devant : un client choisirait lui-même son adresse |

Une variable obligatoire manquante ou mal formée empêche le démarrage, avec un message qui nomme la variable et, pour une clé, la commande de génération. `MASTER_KEY`, `ADMIN_BOOTSTRAP_TOKEN` et `METRICS_TOKEN` acceptent aussi le suffixe `_FILE` (secrets Docker) ; poser la variable et son `_FILE` est refusé.

::: tip La clé maîtresse
`MASTER_KEY` est la seule chose que vous ne pourrez pas reconstruire. Sauvegardez-la dans un gestionnaire de mots de passe, à part de vos sauvegardes de base. Voir [Sauvegarder et restaurer](./sauvegarde.md).
:::

## Pooler de connexions

Si la base est derrière un pooler en mode **transaction** (PgBouncer, pooler d'un hébergeur de base), l'instance refuse de démarrer tant que `DATABASE_URL_DIRECT` n'est pas posée : la file de jobs, les verrous consultatifs et les migrations exigent une connexion de session. Le message est « connexion de session requise ». Avec `DATABASE_URL_DIRECT` (connexion directe), l'application utilise le pooler pour ses requêtes et la connexion directe pour le reste.

Le budget de connexions se calcule ainsi : `total = Σ serveurs (pool + 1) + Σ workers (pool + file de jobs + 1) + 3`. `runtime doctor` le compare à `max_connections` : avertissement au-delà de 80 %, erreur au-delà de 100 % (seuils à valider). `DB_POOL_MAX` (5 par défaut) règle la taille de chaque pool, et `WORKER_CONCURRENCY` ne peut pas la dépasser.

## Migrer avant de démarrer

Le worker ne migre jamais et le serveur ne migre pas tout seul dans les modèles : la migration est une étape explicite, avant chaque déploiement.

- Hébergeur avec commande de pré-déploiement : lancez `node /app/apps/cli/dist/index.js migrate` (ou démarrez l'image avec `RUNTIME_MODE=migrate`).
- Compose : le service `migrate` s'exécute avant `server` et `worker`.

`migrate` est idempotent et pris sous un verrou : deux exécutions simultanées appliquent chaque migration une seule fois. Un serveur démarré sur une base pas encore migrée entre en **mode dégradé** : `/api/health` répond 200, `/api/ready` répond 503 (`schema: false`) et toute autre route répond 503, jusqu'à ce que `migrate` ait passé ; il n'a pas besoin d'être redémarré.

## Premier démarrage et vérification

1. Déployez, puis ouvrez `GET /api/ready` : 200 avec `"initialized":false`.
2. Créez le compte propriétaire avec l'assistant de premier démarrage et le jeton (voir le [démarrage rapide](../tutoriels/quickstart.md#_4-creer-le-compte-proprietaire) et [Comptes, rôles et clés d'API](./comptes.md)).
3. Sauvegardez `MASTER_KEY` si ce n'est pas déjà fait, puis lancez `runtime doctor` (voir [Diagnostiquer une instance](./diagnostic.md)).
4. Retirez `ADMIN_BOOTSTRAP_TOKEN` de l'environnement : il n'a plus d'usage.

## Ce qu'il ne faut pas faire

- Ne publiez pas l'instance sans propriétaire créé : tant que l'assistant est ouvert, quiconque connaît le jeton peut s'en servir. Sans propriétaire, toutes les routes refusent de servir sauf les sondes et l'assistant.
- N'épinglez jamais `latest` : épinglez `X.Y.Z`, ou mieux l'empreinte `@sha256:…`. Il n'existe pas de tag `latest`.
- Ne placez pas `/metrics` sur Internet sans jeton : la route n'existe pas tant que `METRICS_TOKEN` n'est pas posé.
