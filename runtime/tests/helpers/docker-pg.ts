// SPDX-License-Identifier: AGPL-3.0-only
// pg_dump / pg_restore de la version testée, exécutés DANS le conteneur PostgreSQL (docker exec) : le client de l'hôte
// peut être d'une autre version que le serveur de la matrice 16, 17, 18. Le dump circule en mémoire, sans fichier.
import { spawnSync } from 'node:child_process';

const MAX_BUFFER = 512 * 1024 * 1024;

/** URL d'une base VUE DEPUIS le conteneur (utilisateur, mot de passe et port par défaut de Testcontainers). */
const inContainerUrl = (database: string) => `postgres://test:test@localhost:5432/${database}`;

export function dumpDatabase(containerId: string, database: string): Buffer {
  const r = spawnSync('docker', ['exec', containerId, 'pg_dump', '--format=custom', '--no-owner', inContainerUrl(database)], { maxBuffer: MAX_BUFFER });
  if (r.status !== 0) throw new Error(`pg_dump a échoué (${r.status}) : ${r.stderr?.toString()}`);
  return r.stdout;
}

export type RestoreResult = { status: number; stderr: string };

/** `pg_restore` selon la commande documentée (14 § 8) : --no-owner --clean --if-exists. Ne lève pas : l'appelant juge. */
export function restoreDatabase(containerId: string, database: string, dump: Buffer, options: { clean?: boolean } = {}): RestoreResult {
  const args = ['exec', '-i', containerId, 'pg_restore', '--no-owner', ...(options.clean === false ? [] : ['--clean', '--if-exists']), `--dbname=${inContainerUrl(database)}`];
  const r = spawnSync('docker', args, { input: dump, maxBuffer: MAX_BUFFER });
  return { status: r.status ?? -1, stderr: r.stderr?.toString() ?? '' };
}
