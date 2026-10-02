// SPDX-License-Identifier: AGPL-3.0-only
// Étage E2E de la console (15 § 2) : Playwright Test sur la console construite, servie en boucle locale (port éphémère) par
// un faux serveur d'API (e2e/harness.ts). Aucun site réel, aucune base : la gate d'accessibilité (06 § 1, tâche 3.9) ne
// dépend que du rendu. Prérequis : `pnpm exec playwright install chromium`.
// Régression visuelle par langue (part de 3.6 confiée à 3.17) : projets `ui-en`, `ui-fr` et `ui-pseudo` sur e2e/visual.e2e.ts ;
// les autres suites forment le projet `console`. Instantanés de référence par plateforme (le rendu du texte diffère d'un
// système à l'autre) : une plateforme qui n'a pas encore les siens ne compare pas, `--update-snapshots` les crée.
import { existsSync, readdirSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
import type { UiLocale } from './e2e/console.fixture.ts';

const VISUAL = /visual\.e2e\.ts$/;
const VISUAL_DIR = new URL('./e2e/__visual__/', import.meta.url);
const platformDir = new URL(`./${process.platform}/`, VISUAL_DIR);
const hasBaselines = existsSync(platformDir) && readdirSync(platformDir).length > 0;
// Les workers relisent cette configuration sans les arguments de la ligne de commande : le processus principal leur passe
// l'information par l'environnement, hérité à leur lancement.
const updating = process.argv.some((arg) => arg.startsWith('--update-snapshots') || arg === '-u') || process.env.SYM_VISUAL_UPDATE === '1';
if (updating) process.env.SYM_VISUAL_UPDATE = '1';

export default defineConfig<{ uiLocale: UiLocale }>({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  reporter: process.env.CI ? [['list'], ['blob']] : 'list',
  use: { trace: 'retain-on-failure' },
  snapshotPathTemplate: '{testDir}/__visual__/{platform}/{projectName}/{arg}{ext}',
  projects: [
    { name: 'console', testIgnore: VISUAL },
    ...(['en', 'fr', 'pseudo'] as const).map((uiLocale) => ({
      name: `ui-${uiLocale}`,
      testMatch: VISUAL,
      use: { uiLocale },
      ignoreSnapshots: !hasBaselines && !updating,
    })),
  ],
});
