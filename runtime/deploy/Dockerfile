# Image unique, trois modes (RUNTIME_MODE=server|worker|all). Contexte de build : runtime/
#   docker build -f deploy/Dockerfile -t runtime .
# Base épinglée par empreinte de l'index multi-architecture (tâche 0.8 ; Renovate la met à jour). Cible GHCR : linux/amd64 (ici : architecture locale).
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27

# --- Étape 1 : build (même base, donc même Node 24, que l'étape d'exécution)
FROM ${PLAYWRIGHT_IMAGE} AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r build

# --- Étape 2 : exécution, non-root
FROM ${PLAYWRIGHT_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
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
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# pwuser (uid 1001) existe déjà dans l'image Playwright.
USER pwuser
ENV RUNTIME_MODE=all PORT=3000 HOST=0.0.0.0
EXPOSE 3000
# tini (PID 1) relaie les signaux et récolte les zombies Chromium ; sans lui : docker run --init.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
