// SPDX-License-Identifier: AGPL-3.0-only
// Comportement de la landing sur la préproduction : copie de la commande, sélecteur de langue en liens simples (rechargement
// complet, `lang` à jour, aucune redirection automatique), navigation vers la doc (CSP de la page d'arrivée, recherche qui
// fonctionne), repli du 404.
import { expect, test } from '@playwright/test';
import { homeUrl, preprodUrl } from './pages.ts';

test('« Copier la commande » met la commande exacte dans le presse-papiers et l\'annonce', async ({ browser }) => {
  const context = await browser.newContext();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(preprodUrl()).origin });
  const page = await context.newPage();
  await page.goto(homeUrl('en'));
  const shown = await page.locator('.lp-command code').innerText();
  await page.locator('.lp-command .lp-btn').click();
  await expect(page.locator('.lp-command__status')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);
  await context.close();
});

test('aucune redirection automatique par langue : `/` reste en anglais même avec Accept-Language: fr', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'fr-FR' });
  const page = await context.newPage();
  await page.goto(homeUrl('en'));
  expect(new URL(page.url()).pathname).toBe('/sym/');
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
  await context.close();
});

test('le lien de langue recharge la page dans l\'autre langue (lang à jour, hreflang réciproque)', async ({ page }) => {
  await page.goto(homeUrl('en'));
  await page.locator('.lp-header a[hreflang="fr"]').click();
  await page.waitForURL('**/sym/fr/');
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('fr');
  expect(await page.locator('h1').innerText()).toContain('Décris les données');
  await page.locator('.lp-header a[hreflang="en"]').click();
  await page.waitForURL(/\/sym\/$/);
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
});

test('les liens d\'ancre font défiler sans quitter la page', async ({ page }) => {
  await page.goto(homeUrl('en'));
  await page.locator('.lp-nav a[href="#faq"]').click();
  expect(page.url()).toMatch(/#faq$/);
  await page.waitForFunction(() => (document.querySelector('#faq')?.getBoundingClientRect().top ?? 9999) < 200);
});

test('« Doc » charge la page de doc en entier : plus de CSP de la landing, la recherche fonctionne', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') violations.push(message.text());
  });
  await page.goto(homeUrl('en'));
  await page.locator('.lp-nav a', { hasText: 'Docs' }).click();
  await page.waitForURL('**/sym/tutoriels/quickstart');
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('fr-FR');
  expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').count()).toBe(0);
  await page.waitForSelector('#pagefind-search input', { timeout: 15_000 });
  expect(violations).toEqual([]);
});

test('une page absente affiche le 404 du site, sous le chemin de base seulement', async ({ page }) => {
  const response = await page.goto(`${preprodUrl()}/introuvable`);
  expect(response?.status()).toBe(404);
});
