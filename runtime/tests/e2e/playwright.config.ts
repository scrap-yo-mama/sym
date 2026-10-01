// SPDX-License-Identifier: AGPL-3.0-only
// Étage E2E de la console contre une instance réelle (15 § 2, tâche 3.8) : Playwright Test, PostgreSQL jetable (Testcontainers),
// serveur réel en écoute, console construite (apps/web/dist) servie en même origine que l'API par un relais local. Aucun site réel.
// Prérequis : `pnpm build` (console et serveur) et `pnpm exec playwright install chromium`.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  reporter: process.env.CI ? [['list'], ['blob']] : 'list',
  use: { trace: 'retain-on-failure' },
});
