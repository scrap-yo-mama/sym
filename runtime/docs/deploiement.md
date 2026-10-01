<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Déployer une instance

Une instance se compose de trois choses : une **base PostgreSQL**, un **server** (REST, MCP, passerelle) et un **worker**
(enquêtes, navigateur). Les deux derniers sont la **même image**, `ghcr.io/mrsoyer/scrapyomama-runtime:X.Y.Z`, lancée avec
`RUNTIME_MODE=server` ou `RUNTIME_MODE=worker`. Il n'y a pas de tag `latest` : tous les modèles épinglent une version.

| Cible | Statut | Quand la choisir |
|---|---|---|
| [**Render**](#render) | cible de référence | Pas de serveur à administrer ; base, TLS et clé générés pour vous |
| [**Docker Compose**](#docker-compose-vps-coolify-dokploy) | cible de référence | Un VPS, Coolify ou Dokploy ; vous gardez la main sur la machine |
| [Railway](#railway) | best-effort | Même principe que Render ; plan Hobby requis |
| [Heroku](#heroku) | best-effort | Seulement si vous y êtes déjà ; worker de gamme Performance (cher) |

« Best-effort » veut dire : le modèle est fourni et décrit, mais son échec ne bloque pas une version. Le
[statut de vérification](#statut-de-vérification) dit ce qui a été testé et comment.

## Avant de commencer

1. **`MASTER_KEY`** chiffre tous les secrets de l'instance (clés LLM, cookies de site, proxys). C'est **32 octets en
   base64** (44 caractères), jamais une phrase. Le modèle la génère pour vous, ou `runtime keygen`. **Copiez-la hors de la
   plateforme** (gestionnaire de mots de passe), séparément de vos sauvegardes de base : perdue, elle rend les secrets
   illisibles, sans recours.
2. **L'image doit être publique.** Un paquet GHCR est privé à sa première publication ; l'hébergeur ne peut alors pas le
   tirer. Contrôle sans identifiant : `deploy/check-image-public.sh` (voir [Dépannage](#dépannage)).
3. **`PUBLIC_URL`** : l'adresse publique de l'instance, en HTTPS (extension, MCP, cookies `Secure`).
4. Une **base PostgreSQL 15 ou plus** (16 recommandé), d'au moins **10 Go**, dont l'utilisateur peut exécuter `CREATE ROLE`
   (la migration 0003 crée le rôle `runtime_app`). Sinon : `runtime restore-prepare` une fois avec un compte privilégié.
   Derrière un pooler en mode transaction, posez aussi `DATABASE_URL_DIRECT` (connexion directe).
5. Dimensionnement de départ : **worker de 2 Go pour 1 run navigateur**, 4 Go pour 2 (`BROWSER_CONCURRENCY` se déduit de
   la mémoire). Ces chiffres sont à confirmer par la recette (tâche 4.4).

Toutes les variables sont dans [variables-env.md](variables-env.md) (générée depuis le code).

## Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/mrsoyer/scrapyomama-runtime)

Bouton **à valider au GO** : il ne fonctionne qu'une fois le dépôt public, et aucun déploiement réel n'a encore été fait
(voir [statut de vérification](#statut-de-vérification)).

1. Créez le Blueprint : le bouton ci-dessus, ou *New > Blueprint* sur ce dépôt. Render lit `render.yaml` à la **racine**
   du dépôt, là où il se trouve (source unique ; `deploy/` n'en garde pas de copie).
2. Render demande **une seule valeur**, `PUBLIC_URL`. L'adresse `.onrender.com` n'est connue qu'après la création, et Render
   ajoute un suffixe si le nom est pris : saisissez `https://scrapyomama-runtime.onrender.com`, puis, au premier déploiement,
   comparez avec l'adresse réelle du service web et corrigez `PUBLIC_URL` (onglet *Environment*) si elle diffère.
3. Render crée la base (privée), le groupe de variables `scrapyomama-runtime-secrets` (qui porte `MASTER_KEY`, générée), le
   web et le worker. Le web lance `runtime migrate` **avant** de démarrer (pré-déploiement), puis Render attend
   `/api/ready` = 200.
4. **Copiez `MASTER_KEY`** : *Environment Groups > scrapyomama-runtime-secrets*. Lisez aussi `ADMIN_BOOTSTRAP_TOKEN`
   (onglet *Environment* du web).
5. [Créez le premier administrateur](#premier-démarrage), puis [vérifiez](#vérifier-une-instance). Dans cet ordre : avant
   l'assistant, toute route autre que les sondes répond 503 `not_initialized`.

Mettre à jour : sauvegardez la base (`pg_dump`), changez le tag de l'image dans **les deux** services, déployez
(`autoDeployTrigger: 'off'` : rien ne se redéploie tout seul). Détail : [exploitation.md](exploitation.md).

## Docker Compose (VPS, Coolify, Dokploy)

Il faut Docker avec le plugin Compose v2 et 4 Go de mémoire au moins (worker 4 Go de plafond, serveur 512 Mo, base 1 Go).

```bash
cd deploy
./install.sh https://runtime.example.org   # écrit .env (0600) : MASTER_KEY, jeton d'amorçage, mot de passe de la base
docker compose -f docker-compose.prod.yml up -d
# premier administrateur (section « Premier démarrage ») : POST https://runtime.example.org/api/setup
./verify.sh https://runtime.example.org
```

`install.sh` refuse d'écraser un `.env` existant. Il ne **montre aucune valeur** : récupérez la clé et le jeton par
`grep '^MASTER_KEY=' .env` et `grep '^ADMIN_BOOTSTRAP_TOKEN=' .env`, et **copiez `MASTER_KEY` hors de la machine**.

- Le port n'est publié que sur **127.0.0.1:3000** : l'instance n'a pas de TLS intégré. Placez un proxy inverse devant,
  avec `TRUST_PROXY=1` (déjà posé par `install.sh` pour une URL `https://`) et `PUBLIC_URL` en HTTPS.
  `BIND_ADDRESS=0.0.0.0` publie le port en clair : à éviter.
- Caddy (TLS automatique) :
  ```
  runtime.example.org {
    reverse_proxy 127.0.0.1:3000
  }
  ```
- Nginx : `proxy_pass http://127.0.0.1:3000;` avec `proxy_set_header Host $host;`, `X-Forwarded-For $proxy_add_x_forwarded_for`,
  `X-Forwarded-Proto $scheme`, `proxy_http_version 1.1`, `Upgrade $http_upgrade`, `Connection "upgrade"` et un
  `proxy_read_timeout` d'au moins 120 s (passerelle WSS de l'extension).
- Les services : `postgres` (volume `pgdata`), `migrate` (applique les migrations puis s'arrête), `server`, `worker`. `server`
  et `worker` attendent que `migrate` ait réussi. Journaux : `docker compose -f docker-compose.prod.yml logs -f server`.
- **Pas de `ipc: host`** : Chromium reçoit `--disable-dev-shm-usage`, donc l'espace IPC de la machine n'est pas partagé avec un
  conteneur qui ouvre des sites tiers. `no-new-privileges` est **admis** (c'est le régime de Render, voir
  [Modèle de privilèges](#modèle-de-privilèges-de-limage)) ; **pas de `cap_drop` de `SETUID` ou `SETGID` ni de `user:`** sur
  le worker : sans démarrage en root avec ces deux capacités, le bac à sable ne peut pas changer d'utilisateur et le worker
  refuse de démarrer en production.
- Coolify et Dokploy : importez `docker-compose.prod.yml`, définissez `MASTER_KEY`, `PUBLIC_URL`, `ADMIN_BOOTSTRAP_TOKEN`,
  `POSTGRES_PASSWORD` dans l'interface (mêmes valeurs que `install.sh` génère), laissez le proxy de la plateforme faire le TLS.

Mettre à jour : `pg_dump`, changez `RUNTIME_IMAGE` (ou le tag du fichier), `docker compose … up -d`.

## Railway

**Best-effort.** Railway n'importe pas de fichier : `deploy/railway/template.yaml` décrit, service par service, ce que l'on
saisit (plan Hobby requis) :

1. Projet vide, puis ajoutez *PostgreSQL* (base Railway).
2. Service `server` : *Docker Image* `ghcr.io/mrsoyer/scrapyomama-runtime:X.Y.Z`, variables du modèle, *Pre-deploy command*
   `runtime migrate`, *Healthcheck Path* `/api/ready`, domaine public généré.
3. Service `worker` : la même image, **sans** domaine, `MASTER_KEY=${{server.MASTER_KEY}}` (jamais sa propre clé).
4. `MASTER_KEY` : `${{secret(42, "<alphabet base64>")}}${{secret(1, "AEIMQUYcgkosw048")}}=`. Ne pas utiliser la forme
   `secret(43, …)` + `=` de la documentation Railway : elle produit une valeur invalide trois fois sur quatre (le dernier
   caractère d'une valeur de 32 octets est contraint). En cas de doute : `runtime keygen`.
5. Le health check de Railway arrive avec l'hôte `healthcheck.railway.app` : `/api/ready` répond sans condition d'hôte.

## Heroku

**Best-effort, non garanti** (Heroku est en maintenance depuis février 2026 ; le worker Chromium demande une gamme
Performance, plusieurs centaines de dollars par mois). Le dossier `deploy/heroku/` se déploie **seul** :

```bash
cd deploy/heroku && git init && git add . && git commit -m "deploy"
heroku create mon-instance --stack container
heroku config:set MASTER_KEY="$(docker run --rm ghcr.io/mrsoyer/scrapyomama-runtime:X.Y.Z runtime keygen)" \
  ADMIN_BOOTSTRAP_TOKEN="$(openssl rand -base64 32)" PUBLIC_URL=https://mon-instance.herokuapp.com
git push heroku HEAD:main
heroku ps:scale web=1 worker=1 && heroku ps:resize worker=performance-m
```

`heroku.yml` construit deux images minces (`Dockerfile.web`, `Dockerfile.worker`) qui reprennent l'image GHCR, démarre
les deux processus par une section `run` explicite (l'image a un ENTRYPOINT mais pas de CMD), lance
`runtime migrate` en release phase et pose `PGSSLMODE=no-verify` (Heroku Postgres impose TLS avec un certificat que le client
ne vérifie pas). `essential-0` n'offre que 20 connexions : le budget de connexions est à la limite, aucune place pour un second
`server`. Le bouton « Deploy to Heroku » (`app.json`) n'est pas garanti.

## Premier démarrage

Tant qu'aucun administrateur n'existe, le serveur n'ouvre rien d'autre que les sondes et l'assistant, protégé par
`ADMIN_BOOTSTRAP_TOKEN` (32 caractères au moins ; ni stocké ni réaffiché). L'assistant est l'appel `POST /api/setup` :

```bash
curl -X POST "$PUBLIC_URL/api/setup" -H 'content-type: application/json' \
  -d '{"token":"<ADMIN_BOOTSTRAP_TOKEN>","email":"vous@example.org","password":"<mot de passe long>"}'
```

Réponse 201 : l'owner est créé et le rappel de sauvegarde de `MASTER_KEY` s'affiche. Ensuite l'assistant répond **404 pour
toujours** : **retirez `ADMIN_BOOTSTRAP_TOKEN`** de l'environnement (`runtime doctor` le signale). Cinq jetons faux depuis la même
IP bloquent l'assistant pendant 15 minutes (derrière un proxy, vérifiez `TRUST_PROXY`).

## Vérifier une instance

```bash
deploy/verify.sh https://runtime.example.org                       # health, ready (attend jusqu'à 120 s), version, MCP exigé
deploy/verify.sh https://runtime.example.org --allow-missing-mcp   # version antérieure au serveur MCP seulement
```

`/api/ready` = 200 signifie : base joignable, schéma à jour, empreinte de clé valide. 503 liste les contrôles en échec.
Le diagnostic complet se lance dans le conteneur (Render : *Shell* du web ; compose : `docker compose exec server runtime doctor`) :
code de sortie 0 tout va bien, 1 avertissement, 2 erreur. `runtime doctor` ne contacte que la base.

Le point d'entrée MCP est `PUBLIC_URL/mcp` (clé d'API en `Authorization: Bearer`). `verify.sh` l'**exige** : un `/mcp` à
404 fait échouer la vérification. `--allow-missing-mcp` tolère ce 404, seulement pour une version qui ne sert pas encore
le MCP (antérieure à la tâche 3.2). Lancé avant le [premier démarrage](#premier-démarrage), `verify.sh` voit `/mcp`
répondre 503 `not_initialized` (le garde bloque toute route connue tant qu'aucun administrateur n’existe) : il le compte
joignable et rappelle de terminer l'assistant ; tout autre 503 reste un échec.

## Dépannage

| Symptôme | Cause probable | Que faire |
|---|---|---|
| L'hébergeur ne tire pas l'image (« denied », « unauthorized ») | Paquet GHCR encore privé | `deploy/check-image-public.sh` ; *Package settings > Change package visibility > Public* (une fois) |
| `/api/ready` = 503, `schema: false` | `runtime migrate` n'a pas tourné | Render : le pré-déploiement du web ; compose : `docker compose logs migrate` ; à la main : `runtime migrate`. Le serveur sort seul du mode dégradé après la migration |
| `/api/ready` = 503, `key_check: false` | `MASTER_KEY` différente de celle de la base | Remettre la clé d'origine. Ne jamais en générer une neuve sur une base qui contient déjà des secrets |
| Refus au démarrage « MASTER_KEY invalide » | Clé de 31 octets, phrase, espace ou saut de ligne | `runtime keygen` ; sur Railway, voir la forme de `secret()` ci-dessus |
| « connexion de session requise » | Base derrière un pooler en mode transaction | Poser `DATABASE_URL_DIRECT` (connexion directe) |
| Migration 0003 : `permission denied to create role` | L'utilisateur de la base n'a pas `CREATEROLE` | Créer le rôle une fois : `DATABASE_URL=<compte privilégié> runtime restore-prepare` |
| Le worker refuse de démarrer (« bac à sable ») | `SETUID` ou `SETGID` retirées (`cap_drop`), uid imposé au conteneur (`user:`, `--user`), ou plateforme qui ne démarre pas l'image en root | Retirer l'option ; sur une plateforme qui l'impose, utiliser une machine Docker classique ([modèle de privilèges](#modèle-de-privilèges-de-limage)) |
| Toutes les requêtes semblent venir de la même IP, limites partagées | `TRUST_PROXY` absent derrière un proxy | `TRUST_PROXY=1` (un saut), jamais `true` sans proxy |
| Extension ou cookies refusés | `PUBLIC_URL` différente de l'adresse réelle, ou en HTTP | Corriger `PUBLIC_URL` (HTTPS), redémarrer |

## Modèle de privilèges de l'image

L'image démarre en **root** (`USER root`) et son point d'entrée (`deploy/entrypoint.sh`) descend **aussitôt** sur `pwuser`
(uid 1001), sans nouveaux privilèges (`/usr/bin/setpriv --no-new-privs`) : aucun processus de l'application ne reste
root, pas même tini (PID 1), qui partage ainsi l'uid des rôles et peut leur relayer `SIGTERM`. Ce démarrage en root est
nécessaire : Render lance ses conteneurs sous `no-new-privileges`, régime où un programme ne garde de ses capacités de
fichier que celles que son appelant détient déjà ; un conteneur démarré directement sous `pwuser` n'en détient aucune, et
le bac à sable ne pourrait pas changer d'utilisateur (constat F-20261001-R01, décision D-32).

| Processus | Utilisateur | Capacités |
|---|---|---|
| `server`, `runtime migrate`, commande passée au conteneur, `runtime …` lancée en root par `docker exec` ou le shell de l'hébergeur, sonde de santé du compose | pwuser | aucune |
| `worker` (`/usr/local/libexec/node-worker`, copie de Node réservée au groupe pwuser) | pwuser | `cap_setuid,cap_setgid` **permises** seulement : ni effectives (un `process.setuid(0)` du worker échoue), ni ambient, ni héritables ; ses enfants (Chromium, shells) n'en ont aucune |
| Lanceur du bac à sable (`sandbox-launch`, exécuté directement par le worker) | pwuser puis `sandbox` | les mêmes, effectives, le temps de changer d'utilisateur |
| Enfant du bac à sable (Node ordinaire, `SANDBOX_NODE`) | `sandbox` (1500) | aucune ; `/proc/1/environ` et l'environnement du worker lui sont refusés |
| tini, et le shell du point d'entrée en `RUNTIME_MODE=all` | pwuser | `cap_setuid,cap_setgid` (ambient) quand le rôle worker démarre ; ils n'exécutent aucun code tiers et retirent ces capacités au lancement de chaque rôle |

Tous ces processus tournent sous `no-new-privileges`, même quand le conteneur est démarré sous un uid imposé. Chromium
(`/ms-playwright`) et le reste de l'image ne sont modifiables que par root : un enfant évadé du bac à sable (uid 1500) ne
peut pas remplacer le binaire que le worker lance ensuite sous `pwuser`. À la fin de chaque run, quand aucun autre run
n'est actif, le worker tue tous les processus de l'uid dédié : un processus détaché par un enfant ne survit pas pour
observer les runs suivants.

Conséquences pour l'hébergeur :

- Ne retirez pas `SETUID` ni `SETGID` (`cap_drop`) et n'imposez pas d'uid (`user:`, `--user`, `runAsUser`) au worker ;
  `no-new-privileges` est admis. Sous un uid imposé, le point d'entrée pose quand même `no-new-privileges` et le worker
  refuse de démarrer en production (fermeture sûre : sans cela, un processus de `pwuser` pourrait repasser root par les
  capacités de fichier). Kubernetes : `runAsNonRoot: true` refuse l'image (`USER root`) ; laissez-le à `false` pour ce
  conteneur. Un scanner d'image signale `USER root` : c'est attendu, la descente est vérifiée par `pnpm test:image`.
- **`docker exec <conteneur> sh` sans `-u` ouvre un shell root** (il prend l'USER de l'image, root, avec les capacités du
  conteneur). Pour administrer : `docker exec -u pwuser …`, ou la commande `runtime …`, qui descend d'elle-même. Une sonde
  de santé en forme commande (`CMD`) tourne aussi en root : celle du compose descend par `setpriv`, faites de même pour
  les vôtres.
- Le worker s'exécutant sous un binaire à capacités de fichier, Node y ignore `NODE_OPTIONS` et `NODE_EXTRA_CA_CERTS`,
  OpenSSL `SSL_CERT_FILE`, `SSL_CERT_DIR` et `OPENSSL_CONF` (mode d'exécution sécurisé du noyau, `AT_SECURE`), alors que le
  server les honore ; le worker l'écrit au démarrage. Voir [variables-env.md](variables-env.md).

### Risque résiduel : worker compromis

Le worker détient `cap_setuid,cap_setgid` en permis. Un worker compromis **par du code natif** (pas par un script du bac
à sable, qui tourne sous l'uid 1500 sans capacité) peut les rendre effectives (`capset`), puis passer en **uid 0**. Sous
`no-new-privileges` il n'a alors aucune capacité, mais, propriétaire des fichiers de root, il peut lire `/etc/shadow` et
écrire `/usr/local/bin/entrypoint.sh`, `/usr/bin/node` (le Node des futurs enfants), `/app`. En Docker classique avec
`restart: unless-stopped`, la couche inscriptible survit au redémarrage : le point d'entrée piégé s'exécute alors en vrai
root, avec les capacités par défaut du conteneur, et compromet aussi le rôle server. Un worker compromis lit déjà
`MASTER_KEY`, `DATABASE_URL` et les clés LLM : ce risque ajoute la **persistance** et la compromission du server au
redémarrage.

Comparaison avec la conception antérieure (USER pwuser, avant F-20261001-R01) : en Docker classique, sans
`no-new-privileges`, n'importe quel processus de `pwuser` (worker ou Chromium compromis) faisait
`sandbox-launch --reuid=0 -- sh` et obtenait root avec toutes les capacités par défaut. Le modèle actuel est donc plus
étroit : Chromium et les autres enfants n'ont plus aucune capacité, un `process.setuid(0)` en JavaScript échoue, et l'uid 0
atteint par du code natif n'a aucune capacité.

Atténuation recommandée en compose : `read_only: true` sur `server` et `worker`, avec `tmpfs: [/tmp]` (profil de
Chromium, fichiers temporaires) ; plus rien de ce qu'écrirait l'uid 0 ne survit au redémarrage. Non posé par défaut :
à éprouver sur votre hôte (voir `docker-compose.prod.yml`).

## Statut de vérification

Tâche 4.1 **livrée avec réserves** (au 2026-10-01). La recette 27 (installation à froid par un tiers) reste à jouer, et le
dimensionnement de tous les chiffres ci-dessus (server 512 Mo sur Render comme dans le compose, worker 2 Go par run
navigateur) est **à confirmer par la recette 4.4** : aucun n'a été mesuré.

| Cible | Vérifié | Comment | Reste |
|---|---|---|---|
| Docker Compose | `/api/ready` = 200 sur une base vierge, assistant (`POST /api/setup` 201 puis 404), `runtime doctor`, bac à sable isolé, arrêt propre | Image construite en local, `install.sh` puis `up -d`, sur la machine de développement (Docker Desktop) | Réserve MCP et réserve console (ci-dessous) |
| Render | `render.yaml` conforme aux invariants (tests statiques) et au schéma officiel de Render au 2026-10-01 (schéma `render.com/schema/render.yaml.json`, sha256 57aa0a1ff9c3, ajv 2020-12) ; bac à sable sous le régime du conteneur Render (`NoNewPrivs: 1`, capacités CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID, SYS_CHROOT relevées sur Render le 2026-10-01, constat F-20261001-R01) : worker, `RUNTIME_MODE=all`, `runtime migrate`, arrêt propre | Tests statiques ; le régime de Render est reproduit sur l'image construite (`pnpm test:image`, joué par `pnpm ci:local`) | Déploiement réel (GO) : bouton « Deploy to Render » (dépôt public), `CREATE ROLE` sur la base gérée, MCP |
| Railway | Valeur générée de `MASTER_KEY` valide à chaque tirage, variables au catalogue | Tests statiques | Projet réel (compte, plan Hobby) |
| Heroku | Syntaxe des Dockerfile, release phase `runtime migrate`, `run` explicite (web, worker) | Tests statiques ; le point d'entrée est exercé hors image | Déploiement réel ; démarrage des dynos et release phase avec l'ENTRYPOINT de l'image (entrypoint.sh, qui lance tini ; sans CMD) non observés sur Heroku ; `CREATE ROLE` sur Heroku Postgres ; uid du dyno (le bac à sable exige un démarrage en root ; sous un uid imposé, le worker refuse de démarrer) |

**Réserve MCP.** Le critère « MCP joignable » n'est pas atteint : le serveur MCP (tâche 3.2) n'est pas encore fusionné et
`/mcp` répond 404. La dépendance de 4.1 envers 3.2 a été levée par la décision D-28 (vérification MCP déployée reportée
en recette). À la fusion de 3.2, rejouer sur le compose `deploy/verify.sh <URL>` **sans option** : il exige `/mcp` et
échoue sur un 404.

**Réserve console.** Le critère « l'assistant s'affiche » (14 § 13) n'est pas atteint : l'image ne contient pas la console
(`apps/web/dist` n'est pas copié) et le server ne la sert pas (`@fastify/static`, prévu par 03, n'est pas câblé). Seul
l'appel `POST /api/setup` est vérifié. La vue `/setup` relève de la tâche 3.8 (UI comptes, assistant de premier démarrage) ;
le service de la console par le server dans l'image n'est attribué à aucune ligne de 10-taches et doit être rattaché
(3.8 ou 4.2) avant la recette.

**Écarts au CDC assumés.** 14 § 12 demande `init` et `ipc: host` dans le compose ; aucun des deux n'est posé. `init` :
l'image lance déjà tini (par son point d'entrée), un second init est redondant. `ipc: host` : Chromium reçoit
`--disable-dev-shm-usage` (et `shm_size` garde une marge), donc partager l'espace IPC de la machine avec un conteneur qui
ouvre des sites tiers n'apporte rien et affaiblit l'isolation. Le CDC est à mettre à jour en ce sens.

**Rejouer la conformité au schéma Render.** Le schéma n'est pas versionné dans le dépôt (Render ne publie pas de licence) :

```bash
curl -sSo /tmp/render.schema.json https://render.com/schema/render.yaml.json
RENDER_SCHEMA=/tmp/render.schema.json pnpm vitest run tests/deploy-templates.unit.test.ts
```
