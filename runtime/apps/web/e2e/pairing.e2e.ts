// SPDX-License-Identifier: AGPL-3.0-only
// Champs de mot de passe lus dans le DOM au submit (F-20261001-UX01), câblage des vues en Chromium : l'autoremplissage du
// navigateur pose une valeur sans événement `input`, la `ref` Vue reste vide. On reproduit ce cas en écrivant `value` dans
// le DOM sans aucun événement, puis on vérifie la requête envoyée. Le champ vide est refusé en local : message en
// `role="alert"`, réannoncé à chaque envoi, relié au champ (`aria-invalid`, `aria-describedby`, WCAG 3.3.1), focus inchangé.
import type { Page } from '@playwright/test';
import { test, expect } from './console.fixture.ts';
import { anonymousRoutes, text } from './fixtures.ts';
import { activeElement } from './keys.ts';

/** Valeur posée comme le ferait l'autoremplissage : propriété `value` du champ, aucun événement `input` ni `change`. */
async function autofill(page: Page, selector: string, value: string): Promise<void> {
  await page.locator(selector).evaluate((element, next) => {
    (element as HTMLInputElement).value = next;
  }, value);
}

for (const locale of ['en', 'fr'] as const) {
  test.describe(`mot de passe lu dans le DOM : ${locale}`, () => {
    test.use({ uiLocale: locale, uiTheme: 'light' });

    test('code d’appairage : un champ autorempli sans événement input part au serveur, puis le champ est vidé', async ({ consolePage }) => {
      const { page, open } = consolePage;
      const bodies: unknown[] = [];
      await open('/settings/extension', {
        routes: {
          'POST /api/extension/pairing-codes': (request) => {
            bodies.push(request.body);
            return { status: 201, body: { code: 'ZZTE-ST01', expiresAt: '2026-10-01T10:10:00.000Z' } };
          },
        },
      });
      await page.getByTestId('pairing-form').waitFor();
      await autofill(page, '#pairing-password', 'zz_test_autorempli');
      await page.locator('form[data-testid="pairing-form"] button[type="submit"]').click();
      await expect(page.getByTestId('pairing-code')).toBeVisible();
      expect(bodies).toEqual([{ currentPassword: 'zz_test_autorempli' }]);
      await expect(page.locator('#pairing-password')).toHaveValue('');
      await expect(page.getByTestId('extension-failure')).toHaveCount(0);
    });

    test('code d’appairage : champ vide, aucune requête ; le message est réannoncé à chaque envoi et relié au champ, le focus ne bouge pas', async ({ consolePage }) => {
      const { page, app, open } = consolePage;
      await open('/settings/extension');
      await page.getByTestId('pairing-form').waitFor();
      const submit = page.locator('form[data-testid="pairing-form"] button[type="submit"]');
      const field = page.locator('#pairing-password');
      await expect(field).not.toHaveAttribute('aria-invalid', /.*/);

      await submit.focus();
      const before = await activeElement(page);
      await page.keyboard.press('Enter');
      const alert = page.getByTestId('extension-failure');
      await expect(alert).toHaveText(text(locale, 'settings.extension.passwordRequired'));
      await expect(alert).toHaveAttribute('role', 'alert');
      await expect(field).toHaveAttribute('aria-invalid', 'true');
      const describedBy = await field.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(text(locale, 'settings.extension.passwordRequired'));

      // Second envoi à vide : le nœud role="alert" est retiré puis réinséré, sans quoi un lecteur d'écran ne redit rien.
      await alert.evaluate((element) => element.setAttribute('data-zz-first', ''));
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-testid="extension-failure"]:not([data-zz-first])')).toHaveText(text(locale, 'settings.extension.passwordRequired'));
      await expect(page.locator('[data-zz-first]')).toHaveCount(0);
      expect(await activeElement(page)).toBe(before);
      expect(app.requests.filter((entry) => entry.startsWith('POST /api/extension/pairing-codes'))).toEqual([]);
    });

    test('connexion : e-mail et mot de passe autoremplis sans événement input partent au serveur', async ({ consolePage }) => {
      const { page, app, open } = consolePage;
      const bodies: unknown[] = [];
      await open('/login', { anonymous: true });
      await page.locator('#login-password').waitFor();
      app.setRoutes({
        ...anonymousRoutes,
        'POST /api/auth/sign-in/email': (request) => {
          bodies.push(request.body);
          return { status: 401, body: { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'zz' } };
        },
      });
      await autofill(page, '#login-email', ' ada@zz-test.example ');
      await autofill(page, '#login-password', 'zz_test_autorempli');
      await page.locator('form button[type="submit"]').click();
      await page.getByTestId('login-error').waitFor();
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({ email: 'ada@zz-test.example', password: 'zz_test_autorempli' });
    });
  });
}
