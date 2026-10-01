// SPDX-License-Identifier: AGPL-3.0-only
// Rejoue le tutoriel « Démarrage rapide » du site de doc sur une instance vierge (tâche 4.8, 16 § 4) : c'est le script local
// équivalent du job `docs` de la CI. PostgreSQL jetable (Testcontainers), processus de l'image, aucune connexion hors machine.
// Version de PostgreSQL : la première de PG_VERSIONS (défaut 16). Prérequis : `pnpm build`.
import { spawnSync } from 'node:child_process';

const version = (process.env['PG_VERSIONS'] ?? process.env['PG_VERSION'] ?? '16').split(',')[0]?.trim() || '16';
console.log(`==> quickstart rejoué sur PostgreSQL ${version}`);
const result = spawnSync('pnpm', ['vitest', 'run', '--project', 'integration', 'tests/quickstart.integration.test.ts'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PG_VERSION: version },
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
