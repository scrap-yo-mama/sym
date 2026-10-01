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

# --- Étape 2 : exécution, non-root
FROM ${PLAYWRIGHT_IMAGE} AS runtime
ENV NODE_ENV=production
# Version publiée par GET /api/health et /api/version (tâche 4.9) ; posée par la chaîne de release.
ARG RUNTIME_VERSION=0.0.0
ENV RUNTIME_VERSION=${RUNTIME_VERSION}
WORKDIR /app
# Bac à sable (08 §3, INV7) : l'enfant tourne sous un utilisateur DÉDIÉ (sandbox, 1500), distinct de pwuser qui porte
# MASTER_KEY, DATABASE_URL et les clés LLM : il ne peut lire ni /proc/<pid du worker>/environ ni le fichier de clé
# (MASTER_KEY_FILE monté en 0400 pour pwuser). Le changement d'uid passe par un setpriv (util-linux) doté des SEULES
# capacités cap_setuid,cap_setgid, exécutable par le groupe pwuser uniquement ; il est appelé avec --no-new-privs et
# l'enfant (Node, sans capacités de fichier) n'en garde aucune. Le worker refuse de démarrer en production sans cela.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini libcap2-bin \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && groupadd --system --gid 1500 sandbox \
 && useradd --system --uid 1500 --gid 1500 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin sandbox \
 && install -d -m 0755 /usr/local/libexec \
 && install -o root -g pwuser -m 0750 /usr/bin/setpriv /usr/local/libexec/sandbox-launch \
 && setcap cap_setuid,cap_setgid=ep /usr/local/libexec/sandbox-launch

# .pnpmfile.cjs : crochet readPackage (pair OTel retiré de Better Auth), exigé par le lockfile (pnpmfileChecksum).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .pnpmfile.cjs ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/llm/package.json packages/llm/
COPY packages/client/package.json packages/client/
COPY packages/schemas/package.json packages/schemas/
COPY apps/server/package.json apps/server/
COPY apps/worker/package.json apps/worker/
COPY apps/cli/package.json apps/cli/
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY packages/db/migrations packages/db/migrations
COPY --from=build /app/packages/llm/dist packages/llm/dist
COPY --from=build /app/packages/client/dist packages/client/dist
COPY --from=build /app/packages/schemas/dist packages/schemas/dist
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/apps/cli/dist apps/cli/dist
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
# Commande `runtime` (CLI : migrate, keygen, doctor…) dans le PATH : champ « pré-déploiement » des hébergeurs,
# `docker exec <conteneur> runtime doctor`, `docker run --rm <image> runtime keygen` (tâche 4.1).
RUN chmod 0755 /usr/local/bin/entrypoint.sh \
 && printf '#!/bin/sh\nexec node /app/apps/cli/dist/index.js "$@"\n' > /usr/local/bin/runtime \
 && chmod 0755 /usr/local/bin/runtime

# pwuser (uid 1001) existe déjà dans l'image Playwright.
USER pwuser
ENV RUNTIME_MODE=all PORT=3000 HOST=0.0.0.0 \
    SANDBOX_UID=1500 SANDBOX_GID=1500 SANDBOX_LAUNCHER=/usr/local/libexec/sandbox-launch
EXPOSE 3000
# tini (PID 1) relaie les signaux et récolte les zombies Chromium ; sans lui : docker run --init.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
