---
title: "Déployer avec Docker Compose"
description: "Un VPS ou Coolify : PostgreSQL, migration, serveur et worker, TLS par un proxy inverse."
---

# Déployer avec Docker Compose

Compose est la deuxième cible de référence : un VPS, une machine à vous, ou une plateforme qui importe un fichier Compose (Coolify, Dokploy). L'architecture est celle de [Déployer une instance](./deploiement.md) : PostgreSQL, un service `migrate` qui s'exécute d'abord, puis `server` et `worker`, plus un proxy inverse pour le TLS.

::: warning Modèle `docker-compose.prod.yml`
Le fichier de production et son script `install.sh` accompagnent la première release publique. Le fichier `docker-compose.yml` du dépôt est celui du **développement** (identifiants de base codés en clair, port exposé en HTTP) : ne l'exposez pas sur Internet. L'exemple ci-dessous est le même assemblage, durci pour un serveur.
:::

## Préparer le dossier

```bash
mkdir scrapyomama && cd scrapyomama
umask 077
{
  echo "RUNTIME_IMAGE=runtime:local"
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
  echo "MASTER_KEY=$(openssl rand -base64 32)"
  echo "ADMIN_BOOTSTRAP_TOKEN=$(openssl rand -base64 32)"
  echo "PUBLIC_HOST=runtime.example.org"
} > .env
```

`RUNTIME_IMAGE` désigne l'image : `runtime:local` si vous l'avez construite depuis le dépôt (`docker build -f deploy/Dockerfile -t runtime:local .` depuis `runtime/`), ou, une fois publiée, une version épinglée `…:X.Y.Z` (jamais `latest`). Le fichier `.env` contient `MASTER_KEY` : droits `0600`, hors de tout dépôt, et **copie de la clé dans votre gestionnaire de mots de passe**.

## Le fichier Compose

```yaml
services:
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: runtime
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: runtime
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U runtime -d runtime"]
      interval: 5s
      timeout: 5s
      retries: 10

  migrate:
    image: ${RUNTIME_IMAGE}
    environment:
      RUNTIME_MODE: migrate
      DATABASE_URL: postgres://runtime:${POSTGRES_PASSWORD}@postgres:5432/runtime
    depends_on:
      postgres:
        condition: service_healthy

  server:
    image: ${RUNTIME_IMAGE}
    restart: unless-stopped
    environment:
      RUNTIME_MODE: server
      DATABASE_URL: postgres://runtime:${POSTGRES_PASSWORD}@postgres:5432/runtime
      PUBLIC_URL: https://${PUBLIC_HOST}
      MASTER_KEY: ${MASTER_KEY}
      ADMIN_BOOTSTRAP_TOKEN: ${ADMIN_BOOTSTRAP_TOKEN}
      TRUST_PROXY: "1"
    depends_on:
      postgres:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval: 10s
      timeout: 3s
      retries: 10

  worker:
    image: ${RUNTIME_IMAGE}
    restart: unless-stopped
    ipc: host
    mem_limit: 3g
    environment:
      RUNTIME_MODE: worker
      DATABASE_URL: postgres://runtime:${POSTGRES_PASSWORD}@postgres:5432/runtime
      MASTER_KEY: ${MASTER_KEY}
    depends_on:
      postgres:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    command: caddy reverse-proxy --from ${PUBLIC_HOST} --to server:3000
    volumes:
      - caddydata:/data
    depends_on:
      server:
        condition: service_healthy

volumes:
  pgdata:
  caddydata:
```

Points à connaître :

- **`ipc: host` et `mem_limit`** pour le worker : Chromium a besoin de mémoire partagée et d'un plafond de mémoire clair, dont le worker déduit le nombre d'exécutions navigateur simultanées. Avec `mem_limit: 3g`, il en lance une.
- **Pas de port exposé pour `server`** : seul le proxy inverse est joignable de l'extérieur. Avec `TRUST_PROXY: "1"`, l'instance lit l'adresse du client dans l'en-tête que Caddy pose ; sans proxy devant, laissez `TRUST_PROXY` à sa valeur par défaut.
- **`migrate` n'est pas relancé** par `restart` : c'est un service ponctuel dont dépendent `server` et `worker`.
- **PostgreSQL** : épinglez l'image par empreinte en production, et gardez la sauvegarde hors de ce serveur ([Sauvegarder et restaurer](./sauvegarde.md)).
- **TLS** : Caddy obtient et renouvelle le certificat de `PUBLIC_HOST`, qui doit pointer vers la machine. Nginx ou Traefik conviennent aussi, tant qu'ils transmettent `Host` et `X-Forwarded-For`.

## Démarrer et vérifier

```bash
docker compose --env-file .env up -d
docker compose ps
curl -fsS https://runtime.example.org/api/ready
```

La réponse contient `"initialized":false` tant que le propriétaire n'est pas créé : suivez [Comptes, rôles et clés d'API](./comptes.md). Retirez ensuite `ADMIN_BOOTSTRAP_TOKEN` du fichier `.env` et recréez le service `server` (`docker compose up -d server`).

## Coolify, Dokploy

Ces plateformes importent le fichier ci-dessus. Posez les variables du `.env` dans leur interface (pas dans le dépôt), laissez-les gérer le TLS et supprimez le service `caddy` de la copie. Réglez `TRUST_PROXY` à `1`.

## Mettre à jour

Changez `RUNTIME_IMAGE` pour la version suivante, puis `docker compose --env-file .env up -d`. Compose rejoue `migrate` avant `server` et `worker`. **Sauvegardez avant**, et lisez [Mettre à jour et revenir en arrière](./mise-a-jour.md).
