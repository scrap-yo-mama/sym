---
title: "Railway, Heroku et autres hébergeurs"
description: "Best-effort : ce qui est attendu de n'importe quel hébergeur de conteneurs et ses pièges connus."
---

# Railway, Heroku et autres hébergeurs

Ces cibles sont en **best-effort** : le projet garde un modèle pour chacune, mais un échec de leur déploiement n'empêche jamais une release et leur état est consigné sans bloquer. Les cibles de référence sont [Render](./render.md) et [Docker Compose](./docker-compose.md).

La recette est la même partout : lisez d'abord [Déployer une instance](./deploiement.md). Il vous faut une image, une base, deux processus (`server` et `worker`) qui partagent **la même** `MASTER_KEY`, une commande de pré-déploiement `migrate`, et `GET /api/ready` comme chemin de santé.

## Railway

- **Deux services** sur la même image : l'un avec `RUNTIME_MODE=server`, l'autre avec `RUNTIME_MODE=worker`, plus la base PostgreSQL.
- **`MASTER_KEY`** : Railway peut générer une valeur aléatoire pour vous. Vérifiez qu'elle représente exactement 32 octets en base64 ; sinon le serveur refuse de démarrer et affiche la commande de génération (`runtime keygen`). Le worker doit recevoir la même valeur que le serveur, par référence de variable plutôt que par recopie.
- **Pré-déploiement** : commande `node /app/apps/cli/dist/index.js migrate` sur le service `server`.
- **Santé** : chemin `/api/ready`.
- **Plan** : le plan gratuit ne suffit pas pour un worker avec navigateur ; prévoyez un plan payant.
- **Proxy** : `TRUST_PROXY=1`.

## Heroku

- **Conteneurs** : déploiement par `heroku.yml` (pile `container`), un process `web` en mode `server` et un process `worker`. La phase de release lance `migrate`.
- **Gamme du worker** : Chromium demande de la mémoire ; prenez une gamme Performance pour le worker.
- **Connexions** : une base d'entrée (Essential-0, 20 connexions) est **à la limite** du budget d'un serveur et d'un worker avec les réglages par défaut, sans place pour un second serveur. Baissez `DB_POOL_MAX` et `WORKER_CONCURRENCY`, ou prenez un plan de base plus large.
- **Proxy** : `TRUST_PROXY=1`.
- **Bouton de déploiement** : non garanti.

## Un autre hébergeur de conteneurs

Fly.io, Northflank, un cluster Kubernetes, un PaaS maison : tout hébergeur qui exécute une image en non-root, injecte des variables et offre PostgreSQL convient. Des guides dédiés sont prévus plus tard. Ce que vous devez vérifier :

| Point | À contrôler |
|---|---|
| Image | `linux/amd64`, utilisateur non-root, démarrage par `RUNTIME_MODE` |
| Base | PostgreSQL 15 ou plus ; si pooler en mode transaction, `DATABASE_URL_DIRECT` posée |
| Mémoire du worker | 2 Go au moins ; Chromium a besoin de mémoire partagée suffisante |
| Migration | exécutée avant `server` et `worker`, sous un verrou (deux lancements simultanés sont sans danger) |
| Santé | `GET /api/ready` ; `GET /api/health` pour la vivacité |
| Arrêt | l'instance traite `SIGTERM` : plus de nouveau job, fin des runs en cours, sinon remise en file, avec un délai de 30 secondes (`SHUTDOWN_TIMEOUT_SECONDS`) |
| TLS et adresse | terminés par la plateforme ; `PUBLIC_URL` en HTTPS ; `TRUST_PROXY` réglé |

## Si le déploiement échoue

1. Lisez le journal du service : un refus de démarrer cite toujours la variable en cause, sans jamais afficher de valeur secrète.
2. Un `server` qui répond 200 sur `/api/health` mais 503 sur `/api/ready` n'a pas fini sa migration ou n'atteint pas la base : voyez le corps de la réponse (`database`, `schema`, `key_check`).
3. Lancez `runtime doctor` depuis un conteneur (voir [Diagnostiquer une instance](./diagnostic.md)).
