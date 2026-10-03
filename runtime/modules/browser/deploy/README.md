<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Déployer SYM Browser

SYM Browser tient dans une seule image, `ghcr.io/scrap-yo-mama/sym-browser` (linux/amd64 et linux/arm64). La variable `SYMB_MODE` choisit le rôle du conteneur : `all` (passerelle et nœud dans un seul process), `gateway` ou `node`. Il n'a besoin que de trois choses : sa base PostgreSQL (16 à 18), sa `MASTER_KEY` et son stockage d'objets (`disk` par défaut, ou `s3`). Il ne dépend d'aucun service de SYM.

| Fichier | Pour quoi |
|---|---|
| `compose.yaml` | Une machine, mode `all`, avec PostgreSQL |
| `compose.nodes.yaml` | Une passerelle et des nœuds séparés (node-2 ajouté à chaud) |
| `compose.standalone.yaml` | Preuve d'autonomie : instance seule, réseau sans sortie |
| `render.sym-browser.yaml` | Blueprint Render « SYM Browser seul » : passerelle web, nœud privé, PostgreSQL |
| `.env.example` | Les secrets à fournir, sans valeur |
| `seccomp-chromium.json` | Profil seccomp de Chromium (copie exacte de celui de SYM) |

Sources : `cdc/sym-browser/03-architecture.md` §4, `04b-specs-pool-noeuds.md` §9 à §11, `04f-specs-connexion-cdp.md` §8, `04g-specs-fournisseurs-sym.md` §6.

## Secrets

Tu crées chaque secret une fois, puis tu le gardes hors de la machine (gestionnaire de mots de passe). Aucun n'est fourni par défaut, et aucun ne doit apparaître dans un dépôt ou un journal.

| Variable | Commande | Rôle |
|---|---|---|
| `MASTER_KEY` | `pnpm --filter @sym-browser/core keygen` ou `openssl rand -base64 32` | Chiffre les secrets au repos et signe les jetons. Si tu la perds, tu perds les secrets chiffrés |
| `SYMB_BOOTSTRAP_API_KEY` | `pnpm --filter @sym-browser/core apikey` | Première clé d'API (client `sym`, scopes `sessions:write` et `sessions:read`), créée seulement si la table des clés est vide |
| `NODE_TOKEN` | `openssl rand -base64 32` | Secret partagé entre la passerelle et les nœuds (inutile en mode `all`) |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` | Base du Compose |

Sans clone du dépôt, l'image fournit les mêmes commandes : `docker run --rm --entrypoint node ghcr.io/scrap-yo-mama/sym-browser:1 modules/browser/packages/core/dist/bin.js keygen` (ou `apikey`).

## Installation sur une VM

Ces étapes valent pour Ubuntu 24.04 ou Debian 12, avec 2 Go de RAM au moins par nœud (un slot avec les constantes provisoires de capacité).

1. Installe Docker Engine et le plugin Compose (paquets officiels de Docker), puis ajoute ton utilisateur au groupe `docker`.
2. Récupère le dossier `deploy/` (clone du dépôt public, ou les fichiers seuls) et place-toi dedans.
3. Lance `cp .env.example .env && chmod 600 .env`, puis remplis les secrets (voir la section précédente).
4. Lance `docker compose up -d`, puis `docker compose ps` : `sym-browser` passe `healthy` quand `/readyz` répond 200 (base à jour, nœud enregistré, Chromium lancé).
5. Mets un reverse proxy TLS devant `127.0.0.1:3000` : Caddy (`browser.example.com { reverse_proxy 127.0.0.1:3000 }`), Traefik ou nginx. Le proxy doit transmettre les WebSocket. N'ouvre que 443 dans le pare-feu.
6. Vérifie depuis ton poste : `curl https://browser.example.com/readyz`.

La mesure de l'installation à froid (à partir de l'image, jusqu'à `/readyz` 200) est écrite par le test e2e dans `deploy/mesures/installation-a-froid.json`.

## Docker Compose : mode all

`compose.yaml` lance PostgreSQL et un conteneur `sym-browser` qui fait passerelle et nœud.

- Seul le point d'entrée HTTP est publié, sur `127.0.0.1:3000` par défaut (`SYMB_BIND`). La base n'est pas publiée.
- Confinement de Chromium : `seccomp=seccomp-chromium.json`, `no-new-privileges`, `cap_drop: [ALL]` puis `cap_add: [SYS_CHROOT]`. Le bac à sable de Chromium fait un `chroot` dans son propre espace de noms utilisateur. Sans `SYS_CHROOT` dans l'ensemble limitant, il s'arrête avec `Check failed: sys_chroot` (constaté le 2026-10-02). Le processus tourne sous `pwuser` et n'a aucune capacité effective.
- `/dev/shm` passe à 1 Go (`shm_size`) et les données vont dans le volume `sym-browser-data` (`/data`).
- `stop_grace_period: 300s` couvre la grâce de drainage (`SHUTDOWN_GRACE_SECONDS`, 270 s).

## Plusieurs nœuds

`compose.nodes.yaml` lance une passerelle (`SYMB_MODE=gateway`, sans Chromium et sans capacité) et `node-1`. Pour ajouter `node-2` sans couper la passerelle :

```sh
docker compose -f compose.nodes.yaml up -d
docker compose -f compose.nodes.yaml --profile scale up -d node-2
```

Au démarrage, un nœud s'enregistre de lui-même dans la table `nodes`, puis bat toutes les 5 s. La passerelle l'utilise dès qu'il passe `ready`. Il n'y a aucun redémarrage à faire et aucune liste de nœuds à tenir.

Pour un nœud sur une autre machine (VM à forte RAM, autre hébergeur) :

- Même image, `SYMB_MODE=node`, mêmes `DATABASE_URL`, `MASTER_KEY` et `NODE_TOKEN`.
- `NODE_ID` (stable entre redémarrages) et `NODE_PUBLIC_URL` (URL privée joignable par la passerelle) propres à ce nœud.
- Le nœud ne doit être joignable que par la passerelle : réseau privé, VPN (WireGuard) ou pare-feu par adresse source. Il n'accepte que `Authorization: Bearer <NODE_TOKEN>`.

La passerelle déclare `down` un nœud muet depuis 15 s, et ses sessions passent `failed` (raison `node_lost`).

## Render : SYM Browser seul

`render.sym-browser.yaml` décrit une passerelle (service web, TLS de Render, santé sur `/readyz`), un nœud (service privé Standard 2 Go, `maxShutdownDelaySeconds: 300`) et une base PostgreSQL 16 sans accès depuis Internet.

- Render génère `MASTER_KEY` et `NODE_TOKEN` dans le groupe `sym-browser-secrets`. La valeur générée fait 256 bits en base64, exactement le format attendu. Sauvegarde `MASTER_KEY` hors de Render.
- `SYMB_BOOTSTRAP_API_KEY` est demandée au déploiement (`sync: false`).
- Le nœud annonce son adresse privée par `fromService … property: hostport`. SYM Browser complète `hôte:port` en `http://hôte:port`.
- Pour ajouter un nœud, duplique le service `sym-browser-node` avec un nom et un `NODE_ID` propres. Garde une instance par service : la passerelle route chaque session vers l'URL privée de son nœud.
- À valider sur Render réel (recette, étape 24, après GO) : la référence `fromService` du nœud vers lui-même, et le profil seccomp de Render, qui n'est pas réglable. Si le bac à sable de Chromium ne démarre pas, `/readyz` du nœud reste 503 avec `chromium: échec du lancement`.

Le bouton « Deploy to Render » (`https://render.com/deploy?repo=https://github.com/scrap-yo-mama/sym-browser`) pointera sur ce blueprint, renommé `render.yaml`, une fois le dépôt public publié (tâches 5.7 et 5.8, après GO).

## Topologies : avec SYM ou isolée

La même image et le même protocole servent les deux cas : seule la configuration change.

| Topologie | Mise en œuvre |
|---|---|
| **Avec SYM** (non isolé) | Conteneur séparé sur le même hôte ou le même projet, sur le réseau privé, sans port publié (supprime `ports:` du service). `MASTER_KEY` propre, jamais celle de SYM. Une clé d'échange générée une fois, lue par SYM Browser en `SYMB_BOOTSTRAP_API_KEY` et par SYM en `BROWSER_API_KEY`. SYM joint `BROWSER_URL=http://sym-browser:3000`. Base logique et rôle propres, éventuellement sur le serveur PostgreSQL de SYM. Les gabarits SYM + SYM Browser par défaut viennent avec la tâche 6.6 |
| **Isolé** | Son propre serveur ou hébergeur (`compose.yaml` derrière TLS, ou blueprint Render). Son propre PostgreSQL. Les clients (SYM compris) passent par l'URL publique TLS et une clé d'API |

`compose.standalone.yaml` vérifie l'autonomie : l'instance tourne seule sur un réseau Docker `internal`, sans sortie vers Internet ni variable de SYM, et devient prête. Ses seules connexions vont vers sa base (`assert_standalone_instance`).

## Image multi-arch

La CI construit l'image pour linux/amd64 et linux/arm64 d'un seul coup. L'étape JavaScript tourne sur la plateforme hôte ; l'étape d'exécution se construit par plateforme, ce qui demande QEMU (binfmt) sur une machine amd64.

```sh
# depuis runtime/ : archive OCI locale, rien n'est publié
node modules/browser/scripts/image-build.ts --version 1.0.0 --out /tmp/sym-browser-1.0.0.oci.tar
```

La publication sur GHCR (`--push`) exige le GO explicite de l'utilisateur (`SYMB_PUBLISH_GO=oui`). Elle se fait par la chaîne de release, avec signature, SBOM et provenance (tâches 5.4 et 5.7). Étiquettes : `x.y.z`, `x.y` et `x`. Les gabarits suivent la majeure (`:1`). `SYMB_IMAGE` force une autre image (build local).

## Arrêt et mise à jour

- `docker compose stop` envoie SIGTERM. Le nœud passe `draining` (la passerelle l'écarte, `/readyz` répond 503), termine ses sessions dans la grâce, ferme ses Chromium, écrit `down` et sort avec le code 0. La fin des sessions avec la raison `node_shutdown` arrive avec la tâche 2.7 : son point d'accroche est `drainSessions` dans `apps/gateway/src/runtime/runtime.ts`.
- Pour mettre à jour : `docker compose pull && docker compose up -d`. La passerelle applique les migrations sous verrou au démarrage, et un nœud attend qu'elles soient appliquées avant de se déclarer prêt. Avec plusieurs nœuds, mets-les à jour un par un : les autres continuent de servir.
- Pour sauvegarder : `docker compose exec postgres pg_dump -U symb symb > sauvegarde.sql`, plus le volume de données. Garde `MASTER_KEY` à part, car sans elle une sauvegarde est illisible.
