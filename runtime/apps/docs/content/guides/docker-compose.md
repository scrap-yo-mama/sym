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

Le worker a besoin, à côté du fichier Compose, du profil seccomp de Chromium (voir plus bas). Prenez celui de la version que vous déployez (remplacez `main` par son tag) :

```bash
curl -fsSLO https://raw.githubusercontent.com/scrap-yo-mama/sym/main/runtime/deploy/seccomp-chromium.json
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
      # Lancée en root par Docker (USER de l'image) : descente sur pwuser, sans capacité ni nouveaux privilèges.
      test: ["CMD", "/usr/bin/setpriv", "--reuid=1001", "--regid=1001", "--init-groups", "--inh-caps=-all", "--no-new-privs", "--", "node", "-e", "fetch('http://127.0.0.1:3000/api/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval: 10s
      timeout: 3s
      retries: 10

  worker:
    image: ${RUNTIME_IMAGE}
    restart: unless-stopped
    mem_limit: 3g
    shm_size: 512m
    # Bac à sable de Chromium : espaces de noms utilisateur, refusés par le profil seccomp par défaut de Docker.
    security_opt:
      - seccomp=./seccomp-chromium.json
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

- **`mem_limit` et `shm_size`** pour le worker : un plafond de mémoire clair, dont le worker déduit le nombre d'exécutions navigateur simultanées (avec `mem_limit: 3g`, il en lance une), et une marge de mémoire partagée. **Pas de `ipc: host`** : Chromium reçoit `--disable-dev-shm-usage`, l'espace IPC de la machine n'a pas à être partagé avec un conteneur qui ouvre des sites tiers.
- **`security_opt: seccomp=./seccomp-chromium.json`** pour le worker : copiez `deploy/seccomp-chromium.json` du dépôt à côté du fichier Compose. Chromium tourne avec son bac à sable, jamais en `--no-sandbox` ; ce bac à sable crée des espaces de noms utilisateur, que le profil seccomp par défaut de Docker refuse : sans le fichier, chaque exécution navigateur s'arrête sur « No usable sandbox! », et le worker le signale dès son démarrage (`alert: chromium_sandbox_unavailable`). Le fichier est le profil par défaut de Docker plus la règle de Playwright pour les espaces de noms utilisateur (`clone`, `setns`, `unshare`) ; n'utilisez ni `seccomp=unconfined` ni `--no-sandbox`. L'enfant du bac à sable des scripts, lui, n'en profite pas (filtre propre, posé par l'image).
- **Hôte Ubuntu 23.10 ou plus récent** : ces versions restreignent par AppArmor les espaces de noms utilisateur non privilégiés (`kernel.apparmor_restrict_unprivileged_userns=1` par défaut). Notre CI lève cette restriction sur son runner (`sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`) : le profil seccomp seul est donc **non vérifié** sur un hôte Ubuntu aux réglages par défaut. Si le worker journalise « No usable sandbox! » au lancement de Chromium, vérifiez ce réglage (`sysctl kernel.apparmor_restrict_unprivileged_userns`) ; le passer à `0` vaut pour tout l'hôte, décidez-le en connaissance de cause.
- **Sonde de santé du server** : Docker la lance en root (l'image démarre en root et descend aussitôt sur `pwuser`) ; elle descend elle-même sur `pwuser` par `setpriv`. Faites de même pour toute commande que vous ajoutez. Ne posez ni `user:` ni `cap_drop` de `SETUID` ou `SETGID` sur le worker : il refuserait de démarrer.
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

Ces plateformes importent le fichier ci-dessus. Placez `deploy/seccomp-chromium.json` dans le même dossier que le fichier Compose : sans lui, le conteneur `worker` ne peut pas être créé (voir `security_opt` ci-dessus). Posez les variables du `.env` dans leur interface (pas dans le dépôt), laissez-les gérer le TLS et supprimez le service `caddy` de la copie. Réglez `TRUST_PROXY` à `1`.

## Mettre à jour

Changez `RUNTIME_IMAGE` pour la version suivante, puis `docker compose --env-file .env up -d`. Compose rejoue `migrate` avant `server` et `worker`. **Sauvegardez avant**, et lisez [Mettre à jour et revenir en arrière](./mise-a-jour.md).
