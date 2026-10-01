// SPDX-License-Identifier: AGPL-3.0-only
// Étage E2 (15 § 2, 07 § 7) : Playwright Test, extension décompressée chargée dans un contexte persistant de Chromium
// (nouveau mode headless), instance réelle (PostgreSQL jetable, serveur en écoute) et sites de fixtures en boucle
// locale. Prérequis : `pnpm build` (extension et serveur) et `pnpm exec playwright install chromium`.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  reporter: process.env.CI ? [['list'], ['blob']] : 'list',
  use: { trace: 'retain-on-failure' },
});
