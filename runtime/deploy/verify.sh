#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Vérifie une instance déployée (tâche 4.1) : même contrôle sur Render, compose, Railway ou Heroku. Lecture seule, sans
# identifiant : /api/health, /api/ready (attend jusqu'à WAIT secondes, 120 par défaut), /api/version, point d'entrée MCP.
#
#   ./verify.sh https://runtime.example.org [--allow-missing-mcp]
#
# Code de sortie : 0 tout est bon ; 1 /api/ready n'est jamais passé à 200 ou une sonde est fausse ; 2 usage.
# Le point d'entrée MCP est EXIGÉ (critère « MCP joignable » de la tâche 4.1) : un /mcp à 404 fait échouer le script.
# Avant le premier démarrage, /mcp répond 503 not_initialized : compté joignable (la route existe), avec un rappel.
# --allow-missing-mcp : seulement pour une version antérieure au serveur MCP (tâche 3.2) ; le 404 est alors signalé sans échec.
# --require-mcp : ancienne option, acceptée et sans effet (c'est le comportement par défaut).
set -eu

usage() { echo "usage : verify.sh URL [--allow-missing-mcp]   ex. verify.sh https://runtime.example.org" >&2; exit 2; }
base="${1:-}"
require_mcp=1
[ "$#" -gt 0 ] && shift
for option in "$@"; do
  case "$option" in
    --allow-missing-mcp) require_mcp=0 ;;
    --require-mcp) require_mcp=1 ;;
    *) echo "verify.sh : option inconnue « $option »" >&2; usage ;;
  esac
done
case "$base" in
  http://?*|https://?*) ;;
  *) usage ;;
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
# Exception : avant le premier démarrage, le garde répond 503 not_initialized à toute route connue (hors sondes et
# assistant) ; un chemin inconnu répondrait 404. Ce 503-là prouve que /mcp est servi : joignable, instance non initialisée.
mcp_body=$(curl -sS -m 10 -w "\n%{http_code}" "$base/mcp" 2>/dev/null || true)
code=$(printf "%s\n" "$mcp_body" | tail -n 1)
case "$code" in
  200|400|401|403|405|406) ok "/mcp joignable (HTTP $code sans identifiant)" ;;
  503)
    case "$mcp_body" in
      *'"not_initialized"'*) ok "/mcp joignable (HTTP 503 not_initialized : terminez le premier démarrage, POST /api/setup)" ;;
      *) ko "/mcp = 503" ;;
    esac ;;
  404)
    if [ "$require_mcp" = 1 ]; then
      ko "/mcp = 404 : cette version ne sert pas le MCP (--allow-missing-mcp pour une version antérieure au serveur MCP)"
    else
      echo "  info  /mcp = 404 : cette version ne sert pas le MCP (toléré par --allow-missing-mcp)"
    fi ;;
  *) ko "/mcp = $code" ;;
esac

if [ "$fail" = 0 ]; then echo "Instance saine."; else echo "Instance NON saine : voir les échecs ci-dessus." >&2; fi
exit "$fail"
