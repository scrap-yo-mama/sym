// SPDX-License-Identifier: AGPL-3.0-only
// Deux projets : `unit` (sans base) et `integration` (API REST sur un conteneur PostgreSQL par exécution, PG_VERSION, défaut 16).
// Schemathesis (image Docker) a sa propre configuration : `pnpm --filter @sym-browser/gateway test:schemathesis`.
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
