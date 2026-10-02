// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 3.5 (cdc/sym-browser 06), critère « axe 0 violation sérieuse sur la page de connexion » ; 04d § 5.4 et D13.
// Console construite (dist/), servie avec la CSP de production par e2e/harness.ts, dans Chromium (Playwright 1.63) :
//   - axe (WCAG 2.0 à 2.2, A et AA) sur /login, sur son erreur et sur l'étape du code TOTP, puis sur /setup : en fr et en en,
//     en clair et en sombre. La gate vise 0 violation, quel que soit l'impact (le critère n'exige que 0 sérieuse ou critique) ;
//   - parcours au clavier seul : connexion refusée puis acceptée ; premier démarrage avec un mauvais jeton puis le bon (D13) ;
//   - langue choisie dans l'en-tête, mémorisée ; aucune erreur dans la console du navigateur (CSP comprise).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DIST, startConsole, type Harness } from './harness.ts';
import { MOCK_AUTH_MARKER, MOCK_TOTP_CODE, type MockAuthOptions } from '../src/testing/mock-auth.ts';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const TOKEN = 'symb_boot_e2e_0123456789';
const ADMIN = { email: 'admin@example.test', password: 'douze-caracteres-au-moins' };

let harness: Harness | undefined;
test.afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** Ouvre la console sur `path` ; les erreurs de la console du navigateur sont collectées. */
async function open(page: Page, path: string, options: MockAuthOptions): Promise<string[]> {
  harness = await startConsole(options);
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${harness.url}${path}`);
  await expect(page.locator('h1')).toBeVisible();
  return errors;
}

async function axe(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return results.violations.map((v) => `${v.impact ?? '?'} ${v.id} : ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 4).join(' | ')}`);
}

/** Avance au clavier (Tab) jusqu'à l'élément visé : échoue s'il n'est pas atteint en 15 pressions. */
async function tabTo(page: Page, selector: string): Promise<void> {
  for (let i = 0; i < 15; i += 1) {
    await page.keyboard.press('Tab');
    if (await page.locator(selector).evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error(`${selector} non atteint au clavier`);
}

const LOCALES = [
  { locale: 'fr-FR', lang: 'fr', title: 'Connexion à la console', setup: 'Premier démarrage' },
  { locale: 'en-US', lang: 'en', title: 'Sign in to the console', setup: 'First start' },
] as const;

for (const colorScheme of ['light', 'dark'] as const) {
  for (const { locale, lang, title, setup } of LOCALES) {
    test.describe(`axe : ${colorScheme}, ${lang}`, () => {
      test.use({ colorScheme, locale });

      test('page de connexion : 0 violation', async ({ page }) => {
        const errors = await open(page, '/login', { bootstrapToken: TOKEN, admin: ADMIN });
        await expect(page.locator('h1')).toHaveText(title);
        expect(await page.evaluate(() => document.documentElement.lang)).toBe(lang);
        expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(colorScheme === 'dark');
        expect(await axe(page), 'violations axe sur /login').toEqual([]);
        expect(errors).toEqual([]);
      });

      test('page de connexion, erreur affichée : 0 violation', async ({ page }) => {
        const errors = await open(page, '/login', { bootstrapToken: TOKEN, admin: ADMIN });
        await page.locator('#login-email').fill(ADMIN.email);
        await page.locator('#login-password').fill('mauvais-mot-de-passe');
        await page.locator('form button[type="submit"]').click();
        await expect(page.getByRole('alert')).toBeVisible();
        expect(await axe(page), 'violations axe sur /login (erreur)').toEqual([]);
        expect(errors.filter((e) => !/status of 401/.test(e))).toEqual([]);
      });

      test('étape du code TOTP : 0 violation', async ({ page }) => {
        const errors = await open(page, '/login', { bootstrapToken: TOKEN, admin: { ...ADMIN, totp: true } });
        await page.locator('#login-email').fill(ADMIN.email);
        await page.locator('#login-password').fill(ADMIN.password);
        await page.locator('form button[type="submit"]').click();
        await expect(page.locator('#login-code')).toBeVisible();
        expect(await axe(page), 'violations axe sur /login (TOTP)').toEqual([]);
        expect(errors).toEqual([]);
      });

      test('premier démarrage : 0 violation', async ({ page }) => {
        const errors = await open(page, '/', { bootstrapToken: TOKEN });
        await expect(page).toHaveURL(/\/setup$/);
        await expect(page.locator('h1')).toHaveText(setup);
        expect(await axe(page), 'violations axe sur /setup').toEqual([]);
        expect(errors).toEqual([]);
      });
    });
  }
}

test.describe('parcours au clavier seul (fr)', () => {
  test.use({ locale: 'fr-FR' });

  test('connexion refusée (message annoncé, mot de passe vidé), puis acceptée ; déconnexion', async ({ page }) => {
    const errors = await open(page, '/sessions', { bootstrapToken: TOKEN, admin: ADMIN });
    await expect(page).toHaveURL(/\/login\?redirect=/);
    // Premier arrêt du clavier : le lien d'évitement.
    await page.keyboard.press('Tab');
    await expect(page.locator('a[href="#main"]')).toBeFocused();

    await tabTo(page, '#login-email');
    await page.keyboard.type(ADMIN.email);
    await page.keyboard.press('Tab');
    await expect(page.locator('#login-password')).toBeFocused();
    await page.keyboard.type('mauvais-mot-de-passe');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toHaveText('E-mail ou mot de passe incorrect.');
    await expect(page.locator('#login-password')).toHaveValue('');
    await expect(page.locator('#login-password')).toBeFocused();

    await page.keyboard.type(ADMIN.password);
    await page.keyboard.press('Enter');
    await expect(page.locator('h1')).toHaveText('Accueil');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText(`Connecté en tant que ${ADMIN.email}`)).toBeVisible();

    await tabTo(page, 'header button');
    await page.keyboard.press('Enter');
    await expect(page.locator('h1')).toHaveText('Connexion à la console');
    expect(errors.filter((e) => !/status of 401/.test(e))).toEqual([]);
  });

  test('2FA : code TOTP au clavier', async ({ page }) => {
    await open(page, '/login', { bootstrapToken: TOKEN, admin: { ...ADMIN, totp: true } });
    await tabTo(page, '#login-email');
    await page.keyboard.type(ADMIN.email);
    await page.keyboard.press('Tab');
    await page.keyboard.type(ADMIN.password);
    await page.keyboard.press('Enter');
    await expect(page.locator('#login-code')).toBeFocused();
    await page.keyboard.type(MOCK_TOTP_CODE);
    await page.keyboard.press('Enter');
    await expect(page.locator('h1')).toHaveText('Accueil');
  });

  test('premier démarrage (D13) : mauvais jeton, message et 0 compte ; bon jeton, admin créé puis connexion', async ({ page }) => {
    await open(page, '/', { bootstrapToken: TOKEN });
    await expect(page).toHaveURL(/\/setup$/);
    await tabTo(page, '#setup-token');
    await page.keyboard.type('symb_boot_mauvais');
    await page.keyboard.press('Tab');
    await page.keyboard.type(ADMIN.email);
    await page.keyboard.press('Tab');
    await expect(page.locator('#setup-password')).toBeFocused();
    await page.keyboard.type(ADMIN.password);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toContainText('Aucun compte n’a été créé');
    expect(harness?.requests.filter((r) => r === 'POST /v1/console/setup')).toHaveLength(1);
    // Rien n'est créé : la console reste sur /setup, même après rechargement.
    await page.reload();
    await expect(page).toHaveURL(/\/setup$/);

    await page.locator('#setup-token').fill(TOKEN);
    await page.locator('#setup-email').fill(ADMIN.email);
    await page.locator('#setup-password').fill(ADMIN.password);
    await page.locator('#setup-password').press('Enter');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('status')).toContainText('Ton compte admin est créé');
    await page.locator('#login-email').fill(ADMIN.email);
    await page.locator('#login-password').fill(ADMIN.password);
    await page.locator('#login-password').press('Enter');
    await expect(page.locator('h1')).toHaveText('Accueil');
  });
});

test('langue choisie dans l’en-tête, mémorisée dans le navigateur', async ({ page }) => {
  await open(page, '/login', { bootstrapToken: TOKEN, admin: ADMIN });
  await expect(page.locator('h1')).toHaveText('Sign in to the console');
  await page.locator('#console-locale').selectOption('fr');
  await expect(page.locator('h1')).toHaveText('Connexion à la console');
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('fr');
  await page.reload();
  await expect(page.locator('h1')).toHaveText('Connexion à la console');
});

test('la simulation d’AuthApi n’est pas dans la console construite (production : client HTTP seul)', async () => {
  const assets = join(DIST, 'assets');
  const scripts = (await readdir(assets)).filter((f) => f.endsWith('.js'));
  expect(scripts.length).toBeGreaterThan(0);
  for (const file of scripts) expect(await readFile(join(assets, file), 'utf8'), file).not.toContain(MOCK_AUTH_MARKER);
  const html = await readFile(join(DIST, 'index.html'), 'utf8');
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  expect(html).not.toMatch(/<style/);
});
