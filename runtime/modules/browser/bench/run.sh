#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Lance le banc de capacité (tâche 0.6) dans l'image Playwright de production, avec des limites de conteneur fixées.
#   modules/browser/bench/run.sh <profil> <mémoire> <cpus> <variante> [options de measure.ts]
#   ex. : modules/browser/bench/run.sh std 2g 1 shell --reps 30
# Profils retenus : std = 2g / 1 CPU (Render Standard), large = 3g / 2 CPU (le plus grand que permette la VM Docker de 3,8 Gio).
# Depuis runtime/. Résultat : modules/browser/bench/results/<date>-<profil>-<variante>.json
set -eu
PROFILE=${1:?profil}; MEMORY=${2:?mémoire}; CPUS=${3:?cpus}; VARIANT=${4:?variante shell|chromium}; shift 4
MODULE="$(cd "$(dirname "$0")/.." && pwd -P)"
PW="$(cd "$MODULE/../../node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core" && pwd -P)"
IMAGE=${BENCH_IMAGE:-mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27}
STAMP=$(date -u +%Y-%m-%dT%H%M%SZ)
OUT="$STAMP-$PROFILE-$VARIANT.json"
mkdir -p "$MODULE/bench/results"
# BENCH_TMP_HOST=<dossier> : /tmp du conteneur sur disque hôte (utile quand le disque de la VM Docker est plein, ENOSPC).
TMP_MOUNT=""
if [ -n "${BENCH_TMP_HOST:-}" ]; then mkdir -p "$BENCH_TMP_HOST" && chmod 777 "$BENCH_TMP_HOST"; TMP_MOUNT="-v $BENCH_TMP_HOST:/tmp"; fi
# --init : tini en PID 1 comme en production ; seccomp et utilisateur non root comme le Dockerfile du module.
# --shm-size : 64 Mo par défaut fait planter Chromium ; /dev/shm compte dans la mémoire du cgroup (shmem), donc dans les mesures.
docker run --rm --init --user pwuser \
  --memory="$MEMORY" --memory-swap="$MEMORY" --cpus="$CPUS" --shm-size=512m \
  --security-opt "seccomp=$MODULE/deploy/seccomp-chromium.json" \
  $TMP_MOUNT -v "$MODULE/bench:/bench:ro" -v "$PW:/pw:ro" -v "$MODULE/bench/results:/out" \
  -e BENCH_PLAYWRIGHT_CORE=/pw \
  "$IMAGE" node /bench/measure.ts --label "$PROFILE" --variant "$VARIANT" --out "/out/$OUT" "$@"
