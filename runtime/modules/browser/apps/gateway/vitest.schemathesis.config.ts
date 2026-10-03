// SPDX-License-Identifier: AGPL-3.0-only
// Contrat OpenAPI contre les réponses réelles (tâche 2.2) : Schemathesis en image Docker (réseau hôte), PostgreSQL en conteneur.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.schemathesis.test.ts'],
    globalSetup: ['test/setup/postgres.global.ts'],
    testTimeout: 600_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
