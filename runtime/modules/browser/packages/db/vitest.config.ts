// SPDX-License-Identifier: AGPL-3.0-only
// Deux projets : `unit` (sans base) et `integration` (un conteneur PostgreSQL par exécution, version PG_VERSION, défaut 16).
// La matrice 16/17/18 est jouée par `pnpm --filter @sym-browser/db test:matrix` (une version après l'autre).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['src/**/*.unit.test.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts'],
          globalSetup: ['test/setup/postgres.global.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
