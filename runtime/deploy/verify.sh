#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Vérifie une instance déployée (tâche 4.1) : même contrôle sur Render, compose, Railway ou Heroku. Lecture seule, sans
# identifiant : /api/health, /api/ready (attend jusqu'à WAIT secondes, 120 par défaut), /api/version, point d'entrée MCP.
#
#   ./verify.sh https://runtime.example.org [--require-mcp]
#
# Code de sortie : 0 tout est bon ; 1 /api/ready n'est jamais passé à 200 ou une sonde est fausse ; 2 usage.
# Sans --require-mcp, un point d'entrée MCP absent (404) est signalé sans faire échouer le script (version sans serveur MCP).
set -eu

base="${1:-}"
require_mcp=0
[ "${2:-}" = "--require-mcp" ] && require_mcp=1
case "$base" in
  http://?*|https://?*) ;;
  *) echo "usage : verify.sh URL [--require-mcp]   ex. verify.sh https://runtime.example.org" >&2; exit 2 ;;
esac
base="${base%/}"
wait_seconds="${WAIT:-120}"
command -v curl >/dev/null 2>&1 || { echo "verify.sh : curl est requis." >&2; exit 2; }

status() { curl -sS -o /dev/null -m 10 -w "%{http_code}" "$1" 2>/dev/null || true; }
fail=0
ok() { echo "  ok    $1"; }
ko() { echo "  ECHEC $1"; fail=1; }

echo "Vérification de $base"

waited=0
code=$(status "$base/api/health")
while [ "$code" != "200" ] && [ "$waited" -lt "$wait_seconds" ]; do
  sleep 3
  waited=$((waited + 3))
  code=$(status "$base/api/health")
done
[ "$code" = "200" ] && ok "/api/health = 200 (le processus répond)" || ko "/api/health = $code après ${waited} s (attendu 200)"

code=$(status "$base/api/ready")
while [ "$code" != "200" ] && [ "$waited" -lt "$wait_seconds" ]; do
  sleep 3
  waited=$((waited + 3))
  code=$(status "$base/api/ready")
done
if [ "$code" = "200" ]; then
  ok "/api/ready = 200 (base joignable, schéma à jour, clé valide)"
else
  ko "/api/ready = $code après ${waited} s (503 : base, schéma ou clé ; voir « runtime doctor » dans le guide de déploiement)"
fi

version=$(curl -sS -m 10 "$base/api/version" 2>/dev/null || true)
case "$version" in
  *'"server"'*) ok "/api/version répond" ;;
  *) ko "/api/version ne répond pas comme attendu" ;;
esac

# MCP (HTTP) : sans identifiant, le serveur répond 401 (ou 405/406 à un GET) ; seul un 404 ou une erreur 5xx est anormal.
code=$(status "$base/mcp")
case "$code" in
  200|400|401|403|405|406) ok "/mcp joignable (HTTP $code sans identifiant)" ;;
  404)
    if [ "$require_mcp" = 1 ]; then ko "/mcp = 404 : cette version ne sert pas le MCP"; else echo "  info  /mcp = 404 : cette version ne sert pas encore le MCP (vérification reportée)"; fi ;;
  *) ko "/mcp = $code" ;;
esac

if [ "$fail" = 0 ]; then echo "Instance saine."; else echo "Instance NON saine : voir les échecs ci-dessus." >&2; fi
exit "$fail"
