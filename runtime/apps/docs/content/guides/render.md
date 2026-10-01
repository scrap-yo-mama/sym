---
title: "Déployer sur Render"
description: "Cible de référence : deux services sur la même image, une base PostgreSQL, la migration avant chaque déploiement."
---

# Déployer sur Render

Render est une des deux cibles de référence. L'architecture est celle de [Déployer une instance](./deploiement.md) : deux services sur la même image (`server` et `worker`) et une base PostgreSQL managée, avec la migration lancée avant chaque déploiement.

::: warning Modèle `render.yaml`
Le modèle `render.yaml` et le bouton « Deploy to Render » accompagnent la première release publique. Cette page décrit ce qu'ils poseront ; vous pouvez le faire dès maintenant depuis le tableau de bord ou un blueprint écrit à la main.
:::

## Ce qu'il faut créer

| Ressource | Réglage |
|---|---|
| Base PostgreSQL | version 16, au moins 10 Go ; gardez l'URL **interne** pour les services et l'URL externe pour vos sauvegardes |
| Service web `server` | image du dépôt d'images, `RUNTIME_MODE=server`, chemin de contrôle `/api/ready`, plan standard |
| Service worker `worker` | même image, `RUNTIME_MODE=worker`, plan avec au moins 2 Go de mémoire (Chromium) |
| Commande de pré-déploiement | `node /app/apps/cli/dist/index.js migrate`, sur le service `server` |

## Variables

| Variable | Où | Valeur |
|---|---|---|
| `DATABASE_URL` | server et worker | URL interne de la base, avec `?sslmode=require` si la base l'exige |
| `MASTER_KEY` | server et worker | **la même valeur** dans les deux services : générez-la une fois (`openssl rand -base64 32`), copiez-la dans les deux et **sauvegardez-la ailleurs** |
| `PUBLIC_URL` | server | l'adresse `https://…onrender.com` ou votre domaine, à saisir à la main |
| `ADMIN_BOOTSTRAP_TOKEN` | server | générée ; à retirer après la création du propriétaire |
| `TRUST_PROXY` | server | `1` : Render place un proxy devant le service |
| `PORT` | server | injecté par Render, l'instance le respecte |

Le worker n'ouvre aucun port : Render doit le créer comme **background worker**, pas comme service web.

## Vérifier

1. Une fois le premier déploiement terminé, ouvrez `https://<votre-adresse>/api/ready` : 200 et `"initialized":false`.
2. Créez le propriétaire avec le jeton (voir le [démarrage rapide](../tutoriels/quickstart.md#_4-creer-le-compte-proprietaire), en remplaçant `http://localhost:3100` par votre adresse).
3. `GET /api/ready?detail=1` avec la session du propriétaire montre les workers vivants : un worker est « vivant » s'il a battu il y a moins de 45 secondes.

## Mettre à jour

Changez le tag de l'image (`X.Y.Z`) sur les deux services : la commande de pré-déploiement applique les migrations avant le basculement. Sauvegardez la base avant (voir [Mettre à jour et revenir en arrière](./mise-a-jour.md)).

## Pièges connus

- **Deux `MASTER_KEY` différentes** : le worker refuse de démarrer (« clé différente »). Les deux services doivent partager exactement la même valeur.
- **Plan trop petit pour le worker** : Chromium est tué faute de mémoire ; les runs navigateur échouent. Montez le plan ou réglez `BROWSER_CONCURRENCY=1`.
- **Plan de base de données limité** : un plan d'entrée peut plafonner le nombre de connexions ou la durée de vie des données. Vérifiez ses conditions avant d'y mettre des données durables, et le budget de connexions décrit dans [Déployer une instance](./deploiement.md#pooler-de-connexions).
