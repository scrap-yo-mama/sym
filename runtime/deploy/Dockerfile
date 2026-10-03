# Image unique, trois modes (RUNTIME_MODE=server|worker|all). Contexte de build : runtime/
#   docker build -f deploy/Dockerfile -t runtime .
# Base épinglée par empreinte de l'index multi-architecture (tâche 0.8 ; Renovate la met à jour). Cible GHCR : linux/amd64 (ici : architecture locale).
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27

# --- Étape 1 : build (même base, donc même Node 24, que l'étape d'exécution)
FROM ${PLAYWRIGHT_IMAGE} AS build
WORKDIR /app
RUN corepack enable
COPY . .
# Le site de doc (@runtime/docs) n'entre pas dans l'image : le construire ici ferait échouer l'image et la release sur un
# lien mort de la doc, sans rien apporter à l'exécution (tâche 4.8).
RUN pnpm install --frozen-lockfile && pnpm -r --filter '!@runtime/docs' build

# --- Étape 1 bis : filtre seccomp de l'enfant du bac à sable (deploy/sandbox-seccomp.c, revue 4.1b). Le compilateur reste
# dans cette étape : seul le binaire entre dans l'image.
FROM ${PLAYWRIGHT_IMAGE} AS seccomp
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev \
 && rm -rf /var/lib/apt/lists/*
COPY deploy/sandbox-seccomp.c /src/sandbox-seccomp.c
RUN gcc -O2 -Wall -Wextra -Werror -o /src/sandbox-seccomp /src/sandbox-seccomp.c

# --- Étape 2 : exécution (démarre en root, descend aussitôt sur pwuser : aucun processus ne reste root)
FROM ${PLAYWRIGHT_IMAGE} AS runtime
# Étiquettes OCI (tâche 4.12, 22 §3.4, assert_image_labels) : dérivées de l'identité publique du dépôt (PUBLIC_REPOSITORY, source
# unique : .github/PUBLIC_REPOSITORY ; la release passe `--build-arg PUBLIC_REPOSITORY=${{ github.repository }}`, la release à blanc
# et le test d'image la valeur lue dans cette source). Le nom MCP est io.github.<propriétaire>/<dépôt>. Jamais de valeur par
# défaut : une construction locale ou compose sans --build-arg ne porte ni source ni nom MCP (étiquettes vides), plutôt
# qu'une identité recopiée en constante. La description est celle relue du registre (un test les compare).
ARG PUBLIC_REPOSITORY
LABEL org.opencontainers.image.source="${PUBLIC_REPOSITORY:+https://github.com/}${PUBLIC_REPOSITORY}" \
      org.opencontainers.image.description="Scrapyomama (SYM): self-hosted, open-source web data runtime. Pre-release: the README says what is delivered." \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      io.modelcontextprotocol.server.name="${PUBLIC_REPOSITORY:+io.github.}${PUBLIC_REPOSITORY}"
ENV NODE_ENV=production
# Version publiée par GET /api/health et /api/version (tâche 4.9) ; posée par la chaîne de release.
ARG RUNTIME_VERSION=0.0.0
ENV RUNTIME_VERSION=${RUNTIME_VERSION}
WORKDIR /app
# Bac à sable (08 §3, INV7) : l'enfant tourne sous un utilisateur DÉDIÉ (sandbox, 1500), distinct de pwuser qui porte
# MASTER_KEY, DATABASE_URL et les clés LLM : il ne peut lire ni /proc/<pid du worker>/environ ni le fichier de clé
# (MASTER_KEY_FILE monté en 0400 pour pwuser). Le worker refuse de démarrer en production sans cela.
# Modèle de privilèges (F-20261001-R01 : Render lance ses conteneurs sous no-new-privileges, sans SETPCAP ni SETFCAP ni
# KILL ; un exec n'y garde de capacités de fichier que celles que l'appelant détient déjà) :
# - le conteneur démarre en root ; entrypoint.sh descend aussitôt sur pwuser (setpriv --reuid=1001 --no-new-privs) AVANT
#   tini, pour que tini (PID 1, pwuser) puisse relayer SIGTERM (un PID 1 root sans CAP_KILL ne le pourrait pas) ;
# - pour le rôle worker seulement, cap_setuid,cap_setgid traversent tini et le shell du point d'entrée par l'ensemble
#   ambient, retiré (setpriv --inh-caps=-all --ambient-caps=-all) au lancement de chaque rôle ;
# - le worker tourne sous node-worker, copie de Node dotée de cap_setuid,cap_setgid PERMISES seulement (=p) et
#   exécutable par le groupe pwuser seulement : ni effectives (un process.setuid(0) du worker échoue, EPERM), ni ambient,
#   ni héritables ; ses enfants ordinaires (Chromium, sh) n'en ont donc aucune. Une copie (et non un lien) : les capacités
#   de fichier sont portées par l'inode, /usr/bin/node reste nu ;
# - sandbox-launch, un setpriv doté de cap_setuid,cap_setgid (=ep) et réservé au groupe pwuser, est exécuté directement par
#   le worker (jamais par un shell intermédiaire, qui les aurait perdues), avec --no-new-privs ; sous no-new-privileges il
#   garde ses capacités par l'intersection avec le permis du worker. L'enfant exécute le Node ordinaire (SANDBOX_NODE),
#   sans capacité ;
# - sandbox-seccomp (root:pwuser 0750, cap_setuid,cap_setgid PERMISES seulement, comme node-worker), exécuté par le worker
#   AVANT sandbox-launch, qu'il exécute à son tour : l'enfant perd unshare, setns et clone(CLONE_NEW*), que le profil
#   seccomp du compose permet au conteneur pour le bac à sable de Chromium, ainsi que ptrace et process_vm_readv/writev
#   (revue 4.1b). Posé sous l'uid du worker, le filtre précède tout processus de l'uid dédié (revue 4.1b (4) : posé après
#   le changement d'uid, il laissait une fenêtre où un processus de l'uid dédié, sans filtre, était attachable) ; ses
#   capacités permises ne servent qu'à les transmettre à sandbox-launch sous no-new-privileges ;
# - /ms-playwright (Chromium, que le worker exécute sous pwuser) : l'image de base le livre en 777 ; rendu non modifiable
#   par un autre que root (go-w), sans quoi un enfant évadé du bac à sable (uid 1500) remplacerait le binaire de Chromium.
#   Firefox et WebKit, inutilisés, sont retirés (aucune copie de leurs fichiers dans cette couche).
# Risque résiduel (D-32, docs/deploiement.md) : un worker compromis par du code natif peut rendre ses capacités
# effectives (capset) puis passer en uid 0 sans capacité ; il peut alors écrire les fichiers de root (0755).
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini libcap2-bin \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && groupadd --system --gid 1500 sandbox \
 && useradd --system --uid 1500 --gid 1500 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin sandbox \
 && install -d -m 0755 /usr/local/libexec \
 && install -o root -g pwuser -m 0750 /usr/bin/setpriv /usr/local/libexec/sandbox-launch \
 && setcap cap_setuid,cap_setgid=ep /usr/local/libexec/sandbox-launch \
 && install -o root -g pwuser -m 0750 /usr/bin/node /usr/local/libexec/node-worker \
 && setcap cap_setuid,cap_setgid=p /usr/local/libexec/node-worker \
 && rm -rf /ms-playwright/firefox-* /ms-playwright/webkit-* \
 && chmod -R go-w,a+rX /ms-playwright

# .pnpmfile.cjs : crochet readPackage (pair OTel retiré de Better Auth), exigé par le lockfile (pnpmfileChecksum).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .pnpmfile.cjs ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/agent/package.json packages/agent/
COPY packages/llm/package.json packages/llm/
COPY packages/client/package.json packages/client/
COPY packages/schemas/package.json packages/schemas/
COPY packages/i18n/package.json packages/i18n/
COPY apps/server/package.json apps/server/
COPY apps/worker/package.json apps/worker/
COPY apps/cli/package.json apps/cli/
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY packages/db/migrations packages/db/migrations
COPY --from=build /app/packages/agent/dist packages/agent/dist
COPY --from=build /app/packages/llm/dist packages/llm/dist
COPY --from=build /app/packages/client/dist packages/client/dist
COPY --from=build /app/packages/schemas/dist packages/schemas/dist
# Catalogues de langues (JSON lus à l'exécution par le serveur et le worker : messages REST, e-mails, bloc de langue du LLM).
COPY --from=build /app/packages/i18n/dist packages/i18n/dist
COPY packages/i18n/locales packages/i18n/locales
COPY --from=build /app/apps/server/dist apps/server/dist
# Console (fix-console-served, F-20261002-09) : fichiers statiques seuls (aucune dépendance d'exécution), servis par le
# serveur depuis apps/web/dist, voisin de apps/server/dist (defaultConsoleDir, apps/server/src/console.ts).
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/apps/cli/dist apps/cli/dist
# Statut « modèle validé » du banc (15 § 11, tâche 2.8), servi en lecture seule par GET /api/settings/llm
# (DEFAULT_VALIDATED_MODELS_FILE, apps/server/src/validated-models.ts : <racine>/eval/validated-models.json).
COPY eval/validated-models.json eval/validated-models.json
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --from=seccomp /src/sandbox-seccomp /usr/local/libexec/sandbox-seccomp
# Commande `runtime` (CLI : migrate, keygen, doctor…) dans le PATH : champ « pré-déploiement » des hébergeurs,
# `docker exec <conteneur> runtime doctor`, `docker run --rm <image> runtime keygen` (tâche 4.1).
# Lancée en root (`docker exec`, shell de l'hébergeur : ils prennent l'USER de l'image, root), elle descend sur pwuser
# sans capacité, comme le point d'entrée.
# Filtre de l'enfant : chown avant setcap (chown efface les capacités de fichier).
RUN chown root:pwuser /usr/local/libexec/sandbox-seccomp \
 && chmod 0750 /usr/local/libexec/sandbox-seccomp \
 && setcap cap_setuid,cap_setgid=p /usr/local/libexec/sandbox-seccomp \
 && chmod 0755 /usr/local/bin/entrypoint.sh \
 && printf '#!/bin/sh\nif [ "$(id -u)" = 0 ]; then exec /usr/bin/setpriv --reuid=1001 --regid=1001 --init-groups --inh-caps=-all --no-new-privs -- node /app/apps/cli/dist/index.js "$@"; fi\nexec node /app/apps/cli/dist/index.js "$@"\n' > /usr/local/bin/runtime \
 && chmod 0755 /usr/local/bin/runtime

# root au démarrage SEULEMENT : entrypoint.sh descend sur pwuser (uid 1001, déjà présent dans l'image Playwright) avant
# toute autre chose ; sous no-new-privileges, c'est le seul moyen de donner au worker les capacités du changement d'uid.
# Démarré directement sous un uid imposé (--user, runAsUser), le point d'entrée pose quand même no-new-privileges : le
# worker refuse alors de démarrer en production (fermeture sûre). Kubernetes : runAsNonRoot: true refuse l'image (D-32).
USER root
ENV RUNTIME_MODE=all PORT=3000 HOST=0.0.0.0 \
    SANDBOX_UID=1500 SANDBOX_GID=1500 SANDBOX_LAUNCHER=/usr/local/libexec/sandbox-launch SANDBOX_NODE=/usr/bin/node \
    SANDBOX_SECCOMP=/usr/local/libexec/sandbox-seccomp
EXPOSE 3000
# entrypoint.sh lance tini (PID 1, sous pwuser) qui relaie les signaux et récolte les zombies Chromium.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
