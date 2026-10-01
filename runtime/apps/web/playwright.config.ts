// SPDX-License-Identifier: AGPL-3.0-only
// Étage E2E de la console (15 § 2) : Playwright Test sur la console construite, servie en boucle locale (port éphémère) par
// un faux serveur d'API (e2e/harness.ts). Aucun site réel, aucune base : la gate d'accessibilité (06 § 1, tâche 3.9) ne
// dépend que du rendu. Prérequis : `pnpm exec playwright install chromium`.
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
