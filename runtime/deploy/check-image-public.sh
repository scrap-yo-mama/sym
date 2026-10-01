#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Piège GHCR (tâche 4.1, 14 § 12) : un paquet GHCR est PRIVÉ à sa première publication. Render, Railway, Heroku et les machines
# Docker des utilisateurs ne peuvent alors pas tirer l'image, et l'erreur ressemble à un défaut de l'instance. Ce contrôle tire
# le manifeste SANS identifiant, comme le ferait un tiers.
#
#   ./check-image-public.sh [ghcr.io/propriétaire/dépôt:X.Y.Z]   (défaut : l'image du fichier docker-compose.prod.yml)
#
# Code de sortie : 0 l'image est publique ; 1 elle ne l'est pas (ou n'existe pas) ; 2 usage. Ne dépend d'aucune session Docker.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
ref="${1:-}"
if [ -z "$ref" ]; then
  ref=$(sed -n 's/^[[:space:]]*image:[[:space:]]*\${RUNTIME_IMAGE:-\([^}]*\)}.*/\1/p' "$here/docker-compose.prod.yml" | head -n 1)
fi
case "$ref" in
  ghcr.io/*:*) ;;
  *) echo "usage : check-image-public.sh ghcr.io/propriétaire/dépôt:X.Y.Z" >&2; exit 2 ;;
esac
command -v curl >/dev/null 2>&1 || { echo "check-image-public.sh : curl est requis." >&2; exit 2; }

path="${ref#ghcr.io/}"
repository="${path%:*}"
tag="${path##*:}"
case "$tag" in latest) echo "Le tag « latest » n'existe pas : les modèles épinglent X.Y.Z (16 § 3)." >&2; exit 2 ;; esac

token=$(curl -sS -m 20 "https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull" 2>/dev/null | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p') || token=""
if [ -z "$token" ]; then
  echo "ECHEC : GHCR ne délivre pas de jeton anonyme pour ${repository} (paquet inexistant ou privé)." >&2
  echo "  Réglages du paquet > « Change package visibility » > Public (une seule fois, après la première publication)." >&2
  exit 1
fi
code=$(curl -sS -o /dev/null -m 20 -w '%{http_code}' \
  -H "Authorization: Bearer ${token}" \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
  "https://ghcr.io/v2/${repository}/manifests/${tag}" 2>/dev/null || true)
if [ "$code" = "200" ]; then
  echo "ok : ${ref} se tire sans identifiant."
  exit 0
fi
echo "ECHEC : ${ref} répond HTTP ${code:-000} à un tirage anonyme (étiquette absente, ou paquet encore privé)." >&2
echo "  Réglages du paquet > « Change package visibility » > Public (une seule fois, après la première publication)." >&2
exit 1
