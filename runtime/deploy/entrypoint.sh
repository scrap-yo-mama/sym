#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# Choisit le processus à lancer selon RUNTIME_MODE (server | worker | all | migrate, défaut all).
set -uo pipefail

SERVER=/app/apps/server/dist/index.js
WORKER=/app/apps/worker/dist/index.js
CLI=/app/apps/cli/dist/index.js

# Commande passée en argument (pré-déploiement des hébergeurs : `runtime migrate` ; `docker run IMAGE runtime keygen`) :
# exécutée telle quelle, aucun rôle n'est démarré. Une chaîne unique (« runtime migrate ») passe par sh -c, comme le
# fait un champ « commande » de plateforme ; plusieurs arguments sont exécutés sans passer par un shell.
if [ "$#" -gt 0 ]; then
  if [ "$#" -eq 1 ]; then exec sh -c "$1"; fi
  exec "$@"
fi

case "${RUNTIME_MODE:-all}" in
  server) exec node "$SERVER" ;;
  worker) exec node --no-node-snapshot "$WORKER" ;; # bac à sable isolated-vm (08 §3)
  migrate) exec node "$CLI" migrate ;; # pré-déploiement (14 § 5)
  all)
    node "$SERVER" & p1=$!
    node --no-node-snapshot "$WORKER" & p2=$!
    stopped=0
    trap 'stopped=1; kill -TERM "$p1" "$p2" 2>/dev/null' TERM INT
    wait -n "$p1" "$p2"
    status=$?
    # Un des deux s'est arrêté (ou signal reçu) : on arrête l'autre proprement.
    kill -TERM "$p1" "$p2" 2>/dev/null
    wait "$p1" "$p2" 2>/dev/null
    [ "$stopped" = 1 ] && exit 0
    exit "$status"
    ;;
  *)
    echo "RUNTIME_MODE invalide : '${RUNTIME_MODE}' (attendu : server, worker, all ou migrate)" >&2
    exit 64
    ;;
esac
