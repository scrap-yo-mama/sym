// SPDX-License-Identifier: AGPL-3.0-only
// Captures des écrans de la console hors maquette (tâche 3.21, D-60) : avant / après la refonte, en français clair, 1280 px de large.
// Hors CI : le test ne tourne que si SYM_CAPTURES_DIR est posé (dossier de sortie des PNG), sinon il est ignoré.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './console.fixture.ts';
import { SCREENS } from './screens.ts';

const DIR = process.env.SYM_CAPTURES_DIR;
const IDS = ['login', 'setup', 'setup-next', 'settings-models', 'settings-account-member', 'admin-users', 'admin-audit', 'runs', 'api-sain-runs', 'api-bloquee-overview'];

test.describe('captures des écrans hors maquette (3.21)', () => {
  test.skip(!DIR, 'SYM_CAPTURES_DIR non posé : captures désactivées');
  test.use({ uiLocale: 'fr', uiTheme: 'light', viewport: { width: 1280, height: 900 } });

  for (const id of IDS) {
    test(`capture ${id}`, async ({ consolePage }) => {
      const { page, app, open } = consolePage;
      const screen = SCREENS.find((candidate) => candidate.id === id);
      if (!screen) throw new Error(`écran ${id} introuvable`);
      await open(screen.path, { anonymous: screen.anonymous, routes: screen.routes });
      await expect(page.locator('h1').first()).toBeVisible();
      await app.settled();
      await screen.prepare?.(page, app);
      await page.evaluate(() => document.fonts.ready);
      mkdirSync(DIR as string, { recursive: true });
      await page.screenshot({ path: join(DIR as string, `${id}.png`), fullPage: true });
    });
  }
});
