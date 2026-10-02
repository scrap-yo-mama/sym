# SPDX-License-Identifier: AGPL-3.0-only
# Image de SYM Browser (cdc/sym-browser 03 § 1 et § 9), cible ghcr.io/scrap-yo-mama/sym-browser. Contexte de build : runtime/
#   docker build -f modules/browser/Dockerfile -t sym-browser:dev .
#   docker run --rm --security-opt seccomp=modules/browser/deploy/seccomp-chromium.json -e MASTER_KEY=… -e DATABASE_URL=… sym-browser:dev
# Le contexte est filtré par modules/browser/Dockerfile.dockerignore : seuls le contrat et les paquets du module entrent.
# Tâche 0.4 : un seul point d'entrée, le rôle vient de SYMB_MODE (all, gateway, node) ; configuration invalide : sortie code 1.
# Variables obligatoires : DATABASE_URL, MASTER_KEY (+ NODE_TOKEN en gateway et node). /healthz et /readyz sur PORT (3000).
# Base épinglée par empreinte (même image et même Playwright 1.63.0 que SYM ; Renovate la met à jour).
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27

# --- Étape 1 : build (même base, donc même Node 24, que l'étape d'exécution)
FROM ${PLAYWRIGHT_IMAGE} AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter "@sym-browser/gateway..." --filter "@sym-browser/node..." \
 && pnpm --filter "@sym-browser/gateway..." --filter "@sym-browser/node..." build

# --- Étape 2 : exécution, non root du premier au dernier processus
FROM ${PLAYWRIGHT_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# tini en PID 1 : relaie SIGTERM (arrêt gracieux, tâche 2.7) et récolte les zombies de Chromium. /ms-playwright est livré
# en 777 par l'image de base : rendu non modifiable par pwuser (un processus compromis ne remplace pas le binaire de
# Chromium) ; Firefox et WebKit, inutilisés, sont retirés.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && rm -rf /ms-playwright/firefox-* /ms-playwright/webkit-* \
 && chmod -R go-w,a+rX /ms-playwright
# .pnpmfile.cjs : crochet readPackage du workspace, exigé par le lockfile (pnpmfileChecksum).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .pnpmfile.cjs ./
COPY packages/contracts/package.json packages/contracts/
COPY modules/browser/packages/core/package.json modules/browser/packages/core/
COPY modules/browser/apps/gateway/package.json modules/browser/apps/gateway/
COPY modules/browser/apps/node/package.json modules/browser/apps/node/
RUN pnpm install --frozen-lockfile --prod --filter "@sym-browser/gateway..." --filter "@sym-browser/node..."
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/modules/browser/packages/core/dist modules/browser/packages/core/dist
COPY --from=build /app/modules/browser/apps/gateway/dist modules/browser/apps/gateway/dist
COPY --from=build /app/modules/browser/apps/node/dist modules/browser/apps/node/dist

# Aucun processus root : pwuser (uid 1001, fourni par l'image Playwright). Le bac à sable de Chromium reste actif ; le
# profil seccomp (deploy/seccomp-chromium.json, repris de SYM) s'applique au lancement du conteneur (--security-opt).
USER pwuser
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "modules/browser/apps/gateway/dist/main.js"]
