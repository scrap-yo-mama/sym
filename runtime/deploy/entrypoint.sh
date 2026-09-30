#!/bin/bash
# Choisit le processus à lancer selon RUNTIME_MODE (server | worker | all, défaut all).
set -uo pipefail

SERVER=/app/apps/server/dist/index.js
WORKER=/app/apps/worker/dist/index.js

case "${RUNTIME_MODE:-all}" in
  server) exec node "$SERVER" ;;
  worker) exec node "$WORKER" ;;
  all)
    node "$SERVER" & p1=$!
    node "$WORKER" & p2=$!
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
    echo "RUNTIME_MODE invalide : '${RUNTIME_MODE}' (attendu : server, worker ou all)" >&2
    exit 64
    ;;
esac
