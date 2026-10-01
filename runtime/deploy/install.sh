#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Installation sur une machine Docker (VPS, Coolify, Dokploy) : génère le fichier .env de docker-compose.prod.yml (tâche 4.1,
# 14 § 12) : MASTER_KEY (`runtime keygen`), jeton d'amorçage, mot de passe de la base. Aucune valeur n'est affichée.
#
#   ./install.sh [PUBLIC_URL]        ex. ./install.sh https://runtime.example.org   (défaut : http://localhost:3000)
#   RUNTIME_IMAGE=ghcr.io/…:X.Y.Z ./install.sh   pour viser une autre image que celle du fichier compose
#
# Refuse d'écraser un .env existant : une MASTER_KEY remplacée rend les secrets déjà chiffrés illisibles.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
env_file="$here/.env"
public_url="${1:-http://localhost:3000}"

die() { echo "install.sh : $*" >&2; exit 1; }

case "$public_url" in
  http://?*|https://?*) ;;
  *) die "PUBLIC_URL invalide « $public_url » : une URL http(s), par exemple https://runtime.example.org" ;;
esac
[ ! -e "$env_file" ] || die "$env_file existe déjà : rien n'est écrasé (une MASTER_KEY remplacée rendrait les secrets illisibles). Supprimez-le à la main si l'instance est neuve."
command -v openssl >/dev/null 2>&1 || die "openssl est requis (jeton d'amorçage et mot de passe de la base)."
command -v docker >/dev/null 2>&1 || die "docker est requis : https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "le plugin « docker compose » (v2) est requis."

# Image : celle du fichier compose, sauf RUNTIME_IMAGE. `${RUNTIME_IMAGE:-…}` : on lit la valeur par défaut du fichier.
image="${RUNTIME_IMAGE:-}"
if [ -z "$image" ]; then
  image=$(sed -n 's/^[[:space:]]*image:[[:space:]]*\${RUNTIME_IMAGE:-\([^}]*\)}.*/\1/p' "$here/docker-compose.prod.yml" | head -n 1)
fi
[ -n "$image" ] || die "image introuvable dans docker-compose.prod.yml : posez RUNTIME_IMAGE."

# MASTER_KEY : par la commande de l'image (la même que `runtime keygen`), sinon openssl (32 octets, base64 canonique).
master_key=$(docker run --rm --pull missing "$image" runtime keygen 2>/dev/null | tail -n 1 | tr -d '\r\n') || master_key=""
case "$master_key" in
  ????????????????????????????????????????????) ;; # 44 caractères : 32 octets en base64
  *) master_key=$(openssl rand -base64 32 | tr -d '\r\n') ;;
esac
admin_token=$(openssl rand -base64 32 | tr -d '\r\n')
postgres_password=$(openssl rand -hex 24)

umask 077
{
  echo "# Généré par install.sh le $(date -u +%Y-%m-%dT%H:%M:%SZ). Ne jamais le commiter. Référence des variables : docs/variables-env.md."
  echo "# MASTER_KEY : à copier dans un gestionnaire de mots de passe, séparément des sauvegardes de la base. Perdue, elle rend les secrets illisibles."
  echo "MASTER_KEY=$master_key"
  echo "ADMIN_BOOTSTRAP_TOKEN=$admin_token"
  echo "POSTGRES_PASSWORD=$postgres_password"
  echo "PUBLIC_URL=$public_url"
  # Derrière un proxy inverse (Caddy, Nginx) : TRUST_PROXY=1 et PUBLIC_URL en https.
  case "$public_url" in https://*) echo "TRUST_PROXY=1" ;; *) echo "TRUST_PROXY=0" ;; esac
  [ -z "${RUNTIME_IMAGE:-}" ] || echo "RUNTIME_IMAGE=$RUNTIME_IMAGE"
} > "$env_file"
chmod 600 "$env_file"

cat <<EOF
.env écrit : $env_file (lecture réservée à votre compte).

1. Sauvegardez MASTER_KEY maintenant, hors de cette machine (gestionnaire de mots de passe) :
     grep '^MASTER_KEY=' "$env_file"
2. Démarrez :
     docker compose -f "$here/docker-compose.prod.yml" up -d
3. Ouvrez $public_url : l'assistant de premier démarrage demande le jeton d'amorçage :
     grep '^ADMIN_BOOTSTRAP_TOKEN=' "$env_file"
   Une fois le premier administrateur créé, retirez ADMIN_BOOTSTRAP_TOKEN du .env (runtime doctor le signale).
4. Vérifiez : $here/verify.sh $public_url
EOF
