// SPDX-License-Identifier: AGPL-3.0-only
// Chemins communs des contrôles de la vitrine (tâche 4.12).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `runtime/` (dossier du monorepo). */
export const runtimeDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** Racine du dépôt (parent de `runtime/`) : `.github/`, `LICENSE`, `render.yaml`. */
export const repoRoot = join(runtimeDir, '..');
export const githubDir = join(repoRoot, '.github');
export const vitrineDir = join(runtimeDir, 'scripts', 'vitrine');
export const assetsDir = join(githubDir, 'assets');
