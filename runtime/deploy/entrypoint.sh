#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# Choisit le processus à lancer selon RUNTIME_MODE (server | worker | all | migrate, défaut all).
set -uo pipefail

SERVER=/app/apps/server/dist/index.js
WORKER=/app/apps/worker/dist/index.js
CLI=/app/apps/cli/dist/index.js
# Copie de Node à capacités de fichier (cap_setuid,cap_setgid), réservée au groupe pwuser (deploy/Dockerfile).
NODE_WORKER=/usr/local/libexec/node-worker

# Démarrage en root (USER root de l'image) : descente immédiate sur pwuser (1001), sans nouveaux privilèges, AVANT tini,
# pour que tini (PID 1) partage l'uid des rôles et puisse leur relayer SIGTERM (Render ne donne pas CAP_KILL à root).
# Seul un démarrage de rôle worker (worker, all ; sans argument) fait traverser à cap_setuid,cap_setgid tini et ce
# script par l'ensemble ambient ; chaque rôle est lancé ci-dessous sans ambient ni héritables (`role`). Une commande
# passée en argument (pré-déploiement `runtime migrate`, `runtime keygen`) ne reçoit aucune capacité.
if [ "$EUID" = 0 ]; then
  caps=(--inh-caps=-all --ambient-caps=-all)
  if [ "$#" -eq 0 ] && { [ "${RUNTIME_MODE:-all}" = worker ] || [ "${RUNTIME_MODE:-all}" = all ]; }; then
    caps=(--inh-caps=-all,+setuid,+setgid --ambient-caps=-all,+setuid,+setgid)
  fi
  # setpriv par chemin absolu : rien de l'environnement ne choisit ce qu'exécute root (porte assert_image_nonroot).
  exec /usr/bin/setpriv --reuid=1001 --regid=1001 --init-groups --no-new-privs "${caps[@]}" -- /usr/bin/tini -- "$0" "$@"
fi
# Démarré directement sous un uid imposé (`--user`, `runAsUser` : déconseillé, voir docs/deploiement.md) : no-new-privileges
# est posé quand même. Sans lui, tout processus de pwuser, Chromium compris, pourrait exécuter node-worker ou sandbox-launch
# (capacités de fichier) puis repasser root avec toutes les capacités du conteneur. Le worker refuse alors de démarrer en
# production (sonde d'isolation en échec) : fermeture sûre. Linux seulement (hors image, ce script est testé sur macOS).
if [ -r /proc/self/status ] && [ -x /usr/bin/setpriv ] && ! grep -q '^NoNewPrivs:[[:space:]]*1$' /proc/self/status; then
  exec /usr/bin/setpriv --no-new-privs -- "$0" "$@"
fi
# Sans init : tini en PID 1 (signaux, zombies de Chromium).
if [ "$$" = 1 ]; then exec /usr/bin/tini -- "$0" "$@"; fi

# Lance un rôle sans capacité héritée : ni ambient ni héritables. Le worker retrouve cap_setuid,cap_setgid par les
# capacités de fichier de node-worker (permises seulement, hors ambient : ses enfants ordinaires, Chromium compris, n'en
# ont aucune).
role() { exec /usr/bin/setpriv --inh-caps=-all --ambient-caps=-all -- "$@"; }
WORKER_NODE=node
[ -x "$NODE_WORKER" ] && WORKER_NODE=$NODE_WORKER

# Commande passée en argument (pré-déploiement des hébergeurs : `runtime migrate` ; `docker run IMAGE runtime keygen`) :
# exécutée telle quelle, aucun rôle n'est démarré. Une chaîne unique (« runtime migrate ») passe par sh -c, comme le
# fait un champ « commande » de plateforme ; plusieurs arguments sont exécutés sans passer par un shell.
if [ "$#" -gt 0 ]; then
  if [ "$#" -eq 1 ]; then exec sh -c "$1"; fi
  exec "$@"
fi

case "${RUNTIME_MODE:-all}" in
  server) role node "$SERVER" ;;
  worker) role "$WORKER_NODE" --no-node-snapshot "$WORKER" ;; # bac à sable isolated-vm (08 §3)
  migrate) role node "$CLI" migrate ;; # pré-déploiement (14 § 5)
  all)
    (role node "$SERVER") & p1=$!
    (role "$WORKER_NODE" --no-node-snapshot "$WORKER") & p2=$!
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
