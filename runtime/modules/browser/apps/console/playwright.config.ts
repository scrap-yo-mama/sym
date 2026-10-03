// SPDX-License-Identifier: AGPL-3.0-only
// E2E de la console (tâche 3.5) : Playwright Test sur la console construite (`pnpm --filter @sym-browser/console build`),
// servie en boucle locale par e2e/harness.ts. Prérequis : `pnpm exec playwright install chromium` (Chromium 153).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: 'list',
  use: { browserName: 'chromium', trace: 'retain-on-failure' },
});
