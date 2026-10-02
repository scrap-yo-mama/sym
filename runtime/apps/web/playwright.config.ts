// SPDX-License-Identifier: AGPL-3.0-only
// Étage E2E de la console (15 § 2) : Playwright Test sur la console construite, servie en boucle locale (port éphémère) par
// un faux serveur d'API (e2e/harness.ts). Aucun site réel, aucune base : la gate d'accessibilité (06 § 1, tâche 3.9) ne
// dépend que du rendu. Prérequis : `pnpm exec playwright install chromium`.
// Régression visuelle par langue (part de 3.6 confiée à 3.17) : projets `ui-en`, `ui-fr` et `ui-pseudo` sur e2e/visual.e2e.ts ;
// les autres suites forment le projet `console`. Instantanés de référence par plateforme (le rendu du texte diffère d'un
// système à l'autre) ; le mode (comparer, créer, ignorer sur un poste sans références, sauter sous linux hors de l'image
// épinglée) est décidé par e2e/visual-policy.ts. En CI, une plateforme sans ses instantanés fait échouer la configuration ;
// ceux de linux se créent et se comparent dans l'image Playwright épinglée : `pnpm visual:image [--update]`.
import { existsSync, readdirSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
import type { UiLocale } from './e2e/console.fixture.ts';
import { visualMode } from './e2e/visual-policy.ts';

const VISUAL = /visual\.e2e\.ts$/;
const VISUAL_DIR = new URL('./e2e/__visual__/', import.meta.url);
const platformDir = new URL(`./${process.platform}/`, VISUAL_DIR);
const hasBaselines = existsSync(platformDir) && readdirSync(platformDir).length > 0;
// Les workers relisent cette configuration sans les arguments de la ligne de commande : le processus principal leur passe
// l'information par l'environnement, hérité à leur lancement.
const updating = process.argv.some((arg) => arg.startsWith('--update-snapshots') || arg === '-u') || process.env.SYM_VISUAL_UPDATE === '1';
if (updating) process.env.SYM_VISUAL_UPDATE = '1';
const ci = Boolean(process.env.CI);
const mode = visualMode({ platform: process.platform, ci, hasBaselines, updating, inImage: process.env.SYM_VISUAL_IMAGE === '1' });
// Lu par e2e/visual.e2e.ts : sous linux hors de l'image épinglée, la suite visuelle est sautée (avec sa raison), jamais comparée.
process.env.SYM_VISUAL_MODE = mode;

export default defineConfig<{ uiLocale: UiLocale }>({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: ci ? 1 : 0,
  timeout: 120_000,
  reporter: ci ? [['list'], ['blob']] : 'list',
  use: { trace: 'retain-on-failure' },
  snapshotPathTemplate: '{testDir}/__visual__/{platform}/{projectName}/{arg}{ext}',
  // En CI, une référence absente échoue sans être écrite (jamais de comparaison réussie en silence).
  ...(ci && mode === 'compare' ? { updateSnapshots: 'none' as const } : {}),
  projects: [
    { name: 'console', testIgnore: VISUAL },
    ...(['en', 'fr', 'pseudo'] as const).map((uiLocale) => ({
      name: `ui-${uiLocale}`,
      testMatch: VISUAL,
      use: { uiLocale },
      ignoreSnapshots: mode === 'ignore',
    })),
  ],
});
