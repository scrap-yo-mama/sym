// SPDX-License-Identifier: AGPL-3.0-only
// Étage E2E de la landing (22b, job `vitrine`) : Playwright Test sur le build de production du commit, servi comme GitHub Pages le
// sert (sous `/sym/`, sans en-têtes ; préproduction, rien n'est déployé). Aucun site réel, aucune base. Prérequis : `pnpm exec
// playwright install chromium`.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  timeout: 120_000,
  reporter: process.env['CI'] ? [['list'], ['blob']] : 'list',
  use: { trace: 'retain-on-failure' },
});
