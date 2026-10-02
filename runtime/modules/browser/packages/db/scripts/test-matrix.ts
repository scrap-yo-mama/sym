// SPDX-License-Identifier: AGPL-3.0-only
// Tests d'intégration du schéma sur chaque version de PostgreSQL de PG_VERSIONS (défaut « 16,17,18 »), l'une après l'autre
// (un seul conteneur à la fois). Critère de la tâche 0.2 : migrations up, down, up vertes sur PostgreSQL 16, 17 et 18.
import { spawnSync } from 'node:child_process';

const versions = (process.env.PG_VERSIONS ?? '16,17,18')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

for (const version of versions) {
  console.log(`\n==> @sym-browser/db : intégration sur PostgreSQL ${version}`);
  const result = spawnSync('pnpm', ['vitest', 'run', '--project', 'integration', ...process.argv.slice(2)], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PG_VERSION: version },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error(`\ntest:matrix : échec sur PostgreSQL ${version} (code ${result.status ?? 'signal'}).`);
    process.exit(result.status ?? 1);
  }
}
console.log(`\ntest:matrix : vert sur PostgreSQL ${versions.join(', ')}.`);
