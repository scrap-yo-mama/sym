// SPDX-License-Identifier: AGPL-3.0-only
// Quickstart de la documentation rejoué de bout en bout (tâche 3.8) : vrai Chromium 153 et PostgreSQL ; utilisateur non root.
// `pnpm --filter @sym-browser/module test:quickstart`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/docs-quickstart.chromium.test.ts'], globalSetup: ['tests/setup/postgres.global.ts'], testTimeout: 300_000, hookTimeout: 240_000, fileParallelism: false },
});
