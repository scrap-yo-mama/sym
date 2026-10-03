// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 3.6 (cdc/sym-browser 06), livrable « E2E des 6 écrans ; parcours clavier seul ; axe 0 violation sérieuse » ; 04d D12.
// Console construite (dist/), client HTTP de production, servie avec la CSP stricte par e2e/harness.ts, devant le faux serveur
// (simulation de l'API 2.2, du SSE 2.5, du comptage 2.6 et de la vue en direct 3.2 : WebSocket réel, entrées comptées côté
// serveur). Six écrans : sessions, détail, nœuds, clés et quotas, profils, consommation.
//   - axe (WCAG 2.0 à 2.2, A et AA) sur chaque écran, en fr et en en, en clair et en sombre : 0 violation (toutes gravités) ;
//   - un parcours au clavier seul par écran (Tab, Maj+Tab, Entrée, Espace, flèches, Échap ; aucun clic) ;
//   - aucune erreur dans la console du navigateur (CSP comprise) ; la simulation n'entre pas dans dist/.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DIST, startConsole, type Harness } from './harness.ts';
import { MOCK_CONSOLE_MARKER } from '../src/testing/mock-console.ts';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const ADMIN = { email: 'admin@example.test', password: 'douze-caracteres-au-moins' };

let harness: Harness | undefined;
test.afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** Console ouverte et connectée (connexion au clavier), puis page demandée ; erreurs du navigateur collectées. */
async function openSignedIn(page: Page, path: string): Promise<string[]> {
  harness = await startConsole({ bootstrapToken: 'symb_boot_e2e_0123456789', admin: ADMIN });
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${harness.url}${path}`);
  await page.locator('#login-email').focus();
  await page.keyboard.type(ADMIN.email);
  await page.keyboard.press('Tab');
  await page.keyboard.type(ADMIN.password);
  await page.keyboard.press('Enter');
  await expect(page.locator('h1')).not.toHaveText(/Connexion|Sign in/);
  return errors;
}

async function axe(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return results.violations.map((v) => `${v.impact ?? '?'} ${v.id} : ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 4).join(' | ')}`);
}

const focused = (page: Page, selector: string) => page.locator(selector).evaluate((el) => el === document.activeElement);

/** Avance au clavier (Tab, ou Maj+Tab) jusqu'à l'élément visé ; échoue s'il n'est pas atteint en 80 pressions. */
async function tabTo(page: Page, selector: string, backwards = false): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    await page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab');
    if (await focused(page, selector)) return;
  }
  throw new Error(`${selector} non atteint au clavier`);
}

/** Champ de saisie : focus au clavier, contenu remplacé. */
async function typeInto(page: Page, selector: string, value: string): Promise<void> {
  await tabTo(page, selector);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type(value);
}

/** Liste déroulante native : focus au clavier puis touches fléchées jusqu'à la valeur voulue. */
async function chooseOption(page: Page, selector: string, value: string): Promise<void> {
  await tabTo(page, selector);
  // Liste fermée : les flèches ne bouclent pas ; on descend jusqu'à la fin, puis on remonte.
  for (const key of ['ArrowDown', 'ArrowUp']) {
    for (let i = 0; i < 30; i += 1) {
      if ((await page.locator(selector).inputValue()) === value) return;
      await page.keyboard.press(key);
    }
  }
  if ((await page.locator(selector).inputValue()) === value) return;
  // Chromium sur macOS : les flèches ouvrent la liste native, hors d'atteinte des touches simulées ; la recherche par
  // première lettre (répétée, elle passe d'une option à la suivante de même initiale) reste au clavier.
  const label = ((await page.locator(selector).locator(`option[value="${value}"]`).textContent()) ?? '').trim();
  const initial = label.charAt(0).toLowerCase();
  if (initial !== '') {
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press(initial);
      if ((await page.locator(selector).inputValue()) === value) return;
    }
  }
  throw new Error(`${selector} : option ${value} non atteinte`);
}

const SCREENS = [
  { path: '/sessions', fr: 'Sessions', en: 'Sessions' },
  { path: '/sessions/ses_live', fr: 'Session ses_live', en: 'Session ses_live' },
  { path: '/nodes', fr: 'Nœuds et capacité', en: 'Nodes and capacity' },
  { path: '/keys', fr: 'Clés et quotas', en: 'Keys and quotas' },
  { path: '/profiles', fr: 'Profils', en: 'Profiles' },
  { path: '/usage', fr: 'Consommation', en: 'Usage' },
] as const;

for (const colorScheme of ['light', 'dark'] as const) {
  for (const { locale, lang } of [
    { locale: 'fr-FR', lang: 'fr' },
    { locale: 'en-US', lang: 'en' },
  ] as const) {
    test.describe(`axe : ${colorScheme}, ${lang}`, () => {
      test.use({ colorScheme, locale });
      test('les 6 écrans : 0 violation, textes de la langue choisie', async ({ page }) => {
        const errors = await openSignedIn(page, '/sessions');
        for (const screen of SCREENS) {
          await page.goto(`${harness!.url}${screen.path}`);
          await expect(page.locator('h1')).toHaveText(screen[lang]);
          // Contenu chargé (tableau, cartes ou message) avant l'analyse.
          await expect(page.locator('[data-loaded]')).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.lang)).toBe(lang);
          expect(await axe(page), `violations axe sur ${screen.path}`).toEqual([]);
        }
        expect(errors).toEqual([]);
      });
    });
  }
}

test.describe('parcours au clavier seul (fr)', () => {
  test.use({ locale: 'fr-FR' });

  test('sessions : onglet « Passées », filtre par état, page suivante, ouverture d’une session', async ({ page }) => {
    const errors = await openSignedIn(page, '/sessions');
    await expect(page.locator('h1')).toHaveText('Sessions');
    await tabTo(page, '#tab-current');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#tab-past')).toBeFocused();
    await expect(page.locator('#tab-past')).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/tab=past/);
    await chooseOption(page, '#filter-state', 'failed');
    await tabTo(page, '#filter-apply');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/state=failed/);
    // Assertion réessayée : l'URL change avant que le tableau filtré remplace l'ancien (lecture unique instable).
    await expect(page.locator('tbody [data-status]:not([data-status="failed"])')).toHaveCount(0);
    await expect(page.locator('tbody [data-status="failed"]').first()).toBeVisible();

    await chooseOption(page, '#filter-state', '');
    await tabTo(page, '#filter-apply');
    await page.keyboard.press('Enter');
    const before = await page.locator('tbody tr').count();
    await tabTo(page, '#sessions-more');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('tbody tr').count()).toBeGreaterThan(before);

    await tabTo(page, 'a[href="/sessions/ses_recorded"]', true);
    await page.keyboard.press('Enter');
    await expect(page.locator('h1')).toHaveText('Session ses_recorded');
    await expect(page.locator('h1')).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('détail : vue en direct en lecture seule (0 entrée), « Prendre la main » puis Échap, prolonger, libérer', async ({ page }) => {
    const errors = await openSignedIn(page, '/sessions/ses_live');
    await expect(page.locator('h1')).toHaveText('Session ses_live');
    const viewer = page.locator('#live-viewer');
    await expect(viewer.locator('img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
    await expect(page.locator('#live-mode')).toHaveText('Lecture seule');
    await expect(page.locator('#live-meta')).toContainText('https://fixture.test/');

    // Lecture seule : rien n'est transmis, même avec le focus sur la vue.
    await tabTo(page, '#take-control');
    await page.keyboard.type('abc');
    expect(harness!.liveStats('ses_live')).toEqual({ forwarded: 0, dropped: 0 });

    await page.keyboard.press('Enter');
    await expect(page.locator('#live-mode')).toHaveText('Tu as la main : Échap la rend');
    await expect(viewer).toBeFocused();
    await page.keyboard.type('ok');
    await expect.poll(() => harness!.liveStats('ses_live').forwarded).toBeGreaterThanOrEqual(2);
    // Tab reste dans la vue tant que tu as la main (clavier capté) ; Échap la rend.
    await page.keyboard.press('Tab');
    await expect(viewer).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#live-mode')).toHaveText('Lecture seule');
    await expect(page.locator('#take-control')).toBeFocused();
    const forwarded = harness!.liveStats('ses_live').forwarded;
    await page.keyboard.type('zz');
    expect(harness!.liveStats('ses_live').forwarded).toBe(forwarded);

    await typeInto(page, '#extend-seconds', '300');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Session prolongée' })).toBeVisible();

    await tabTo(page, '#release');
    await page.keyboard.press('Enter');
    await expect(page.locator('#release-confirm')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-session-status]')).toHaveAttribute('data-status', 'ended');
    // Événement de fin annoncé dans la frise (région aria-live).
    await expect(page.locator('#session-events')).toContainText('Terminée');
    await expect(page.locator('#live-viewer')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('nœuds : alerte de capacité, drainage d’un nœud prêt', async ({ page }) => {
    const errors = await openSignedIn(page, '/nodes');
    await expect(page.getByRole('alert')).toContainText('moins de 15 %');
    await tabTo(page, 'button[data-drain="node-a"]');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-node="node-a"] [data-status]')).toHaveAttribute('data-status', 'draining');
    await expect(page.locator('[data-node="node-a"] button[data-drain]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('clés : création (clé affichée une seule fois, focus sur elle), révocation', async ({ page }) => {
    const errors = await openSignedIn(page, '/keys');
    await chooseOption(page, '#key-tenant', 't_acme');
    await typeInto(page, '#key-name', 'clé e2e');
    await tabTo(page, 'input[name="key-scopes"][value="sessions:read"]');
    await page.keyboard.press('Space');
    await tabTo(page, 'input[name="key-scopes"][value="sessions:write"]');
    await page.keyboard.press('Space');
    await tabTo(page, '#key-create');
    await page.keyboard.press('Enter');
    const secret = page.locator('#key-secret');
    await expect(secret).toBeVisible();
    await expect(secret).toHaveText(/^symb_live_[A-Za-z0-9_-]{24,}$/);
    await expect(page.locator('#key-secret-panel')).toBeFocused();
    expect(await axe(page), 'violations axe avec la clé affichée').toEqual([]);
    const value = (await secret.textContent()) ?? '';
    await tabTo(page, '#key-secret-done');
    await page.keyboard.press('Enter');
    await expect(secret).toHaveCount(0);
    expect(await page.content()).not.toContain(value);
    await expect(page.locator('tbody')).toContainText('clé e2e');

    const row = page.locator('tbody tr', { hasText: 'clé e2e' });
    const revoke = row.locator('button[data-revoke]');
    await tabTo(page, `button[data-revoke="${await revoke.getAttribute('data-revoke')}"]`);
    await page.keyboard.press('Enter');
    await expect(row).toContainText('Révoquée');
    expect(errors).toEqual([]);
  });

  test('profils : test d’un proxy (IP de sortie, puis échec annoncé), export et import storageState', async ({ page }) => {
    const errors = await openSignedIn(page, '/profiles');
    await tabTo(page, 'button[data-test-proxy="px_isp"]');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-proxy="px_isp"]')).toContainText(/IP de sortie\s*:?\s*\d+\.\d+\.\d+\.\d+/);
    await tabTo(page, 'button[data-test-proxy="px_dc"]');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-proxy="px_dc"] [role="alert"]')).toContainText('injoignable');

    await tabTo(page, 'button[data-export="prof_shop"]', true);
    const download = page.waitForEvent('download');
    await page.keyboard.press('Enter');
    const file = await download;
    expect(file.suggestedFilename()).toBe('prof_shop.storage-state.json');

    await chooseOption(page, '#import-profile', 'prof_shop');
    await typeInto(page, '#import-state', '{"cookies":[],"origins":[]}');
    await tabTo(page, '#import-submit');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'importé' })).toBeVisible();
    await expect(page.locator('[data-profile="prof_shop"]')).toContainText('v4');
    // Seul message attendu : le 502 du proxy injoignable, journalisé par Chromium (réponse d'API voulue par le test).
    expect(errors.filter((e) => !/status of 502/.test(e))).toEqual([]);
  });

  test('consommation : période, tableau par clé, lien CSV, réconciliation', async ({ page }) => {
    const errors = await openSignedIn(page, '/usage');
    await expect(page.locator('#usage-drift')).toContainText(/\d+ s/);
    // Mois précédent (UTC) : choisi dans le sélecteur de période (les champs de date dépendent de la langue du navigateur).
    const now = new Date();
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
    const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
    await chooseOption(page, '#usage-preset', 'previous-month');
    await expect(page.locator('#usage-from')).toHaveValue(first);
    await expect(page.locator('#usage-to')).toHaveValue(last);
    await tabTo(page, '#usage-apply');
    await page.keyboard.press('Enter');
    await expect(page.locator('#usage-csv')).toHaveAttribute('href', `/v1/usage.csv?from=${first}&to=${last}&groupBy=key`);
    await expect(page.locator('#usage-by-key tbody tr').first()).toBeVisible();
    await tabTo(page, '#usage-csv');
    await tabTo(page, '#usage-reconcile');
    await page.keyboard.press('Enter');
    await expect(page.locator('#usage-drift')).toContainText('Aucun écart');
    expect(errors).toEqual([]);
  });
});

test('la simulation des écrans n’est pas dans la console construite', async () => {
  const assets = join(DIST, 'assets');
  for (const file of (await readdir(assets)).filter((f) => f.endsWith('.js'))) {
    expect(await readFile(join(assets, file), 'utf8'), file).not.toContain(MOCK_CONSOLE_MARKER);
  }
});
