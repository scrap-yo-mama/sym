// SPDX-License-Identifier: AGPL-3.0-only
// assert_keyboard_only_path (06 § 1 et § 4.3, gate de recette, tâche 3.9) : le parcours du catalogue à un run se fait au clavier
// seul, sans piège, de la première touche Tab à « Lancer » et à « Nouvelle API ». Aucune souris : seules `page.keyboard.*`
// agissent après le chargement (jamais `click`, `fill` ni `focus()`). Chaque arrêt de Tab a un anneau de focus visible (2.4.7).
import type { Page } from '@playwright/test';
import { test, expect } from './console.fixture.ts';
import { text } from './fixtures.ts';
import { focused, startTabFromTop, type Stop } from './keys.ts';
import { RUN_ID, SCREENS } from './screens.ts';

/**
 * Éléments que Tab doit atteindre sur l'écran courant : liens, boutons, champs, résumés, zones défilantes et `tabindex` ≥ 0 qui sont
 * rendus (pas masqués, pas dans un <details> fermé). Chacun est marqué `data-kbd` pour que le parcours dise lesquels il a manqués.
 */
async function markTabbables(page: Page): Promise<number> {
  return page.evaluate(() => {
    const selector = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
    let count = 0;
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (!el.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true }) || el.closest('[inert]')) continue;
      el.setAttribute('data-kbd', String(count));
      count += 1;
    }
    return count;
  });
}

/** Les marques `data-kbd` des éléments qui ont reçu le focus pendant le parcours. */
const reachedMarks = (page: Page): Promise<string | null> => page.evaluate(() => document.activeElement?.getAttribute('data-kbd') ?? null);

/**
 * Parcourt l'écran avec Tab jusqu'à revenir au premier arrêt ; renvoie les arrêts et la marque `data-kbd` de chacun. Un piège
 * (le focus ne boucle jamais) fait échouer l'appelant.
 */
async function tabAround(page: Page, limit = 250): Promise<{ stops: Stop[]; marks: (string | null)[] }> {
  const stops: Stop[] = [];
  const marks: (string | null)[] = [];
  await page.keyboard.press('Tab');
  const first = await focused(page);
  stops.push(first);
  marks.push(await reachedMarks(page));
  for (let step = 0; step < limit; step += 1) {
    await page.keyboard.press('Tab');
    const next = await focused(page);
    // Fin de boucle : le focus est revenu au premier arrêt, ou est sorti du document (barre du navigateur, `body`).
    if (next.tag === 'body' || (next.id === first.id && next.name === first.name && next.tag === first.tag && next.href === first.href)) return { stops, marks };
    stops.push(next);
    marks.push(await reachedMarks(page));
  }
  throw new Error(`piège au clavier : le focus ne sort pas de la page après ${limit} touches Tab (dernier arrêt : ${stops.at(-1)?.tag} « ${stops.at(-1)?.name} »)`);
}

test.describe('assert_keyboard_only_path : chaque écran', () => {
  // Une langue et un thème par écran suffisent pour la structure ; axe couvre les quatre combinaisons.
  test.use({ uiLocale: 'fr', uiTheme: 'dark' });

  for (const screen of SCREENS) {
    test(`${screen.id} : tout ce qui est interactif s'atteint avec Tab, sans piège, avec un anneau de focus visible`, async ({ consolePage }) => {
      const { page, app, open } = consolePage;
      await open(screen.path, { anonymous: screen.anonymous, routes: screen.routes });
      await expect(page.locator('h1').first()).toBeVisible();
      await app.settled();
      // L'écran est mis dans l'état jugé (enquête en cours, erreur de connexion, aucun résultat, flux coupé, confirmation…) : c'est de
      // la mise en place, pas le parcours. Le parcours au clavier commence ensuite, du haut de la page.
      await screen.prepare?.(page, app);
      await startTabFromTop(page);

      const expected = await markTabbables(page);
      const { stops, marks } = await tabAround(page);

      // Le lien d'évitement est le premier arrêt de chaque écran.
      expect(stops[0]).toMatchObject({ tag: 'a', href: '#main' });
      // Tout ce qui est interactif et rendu est atteint : aucune marque ne manque (le lien d'évitement est la marque 0).
      const reached = new Set(marks);
      const missed = Array.from({ length: expected }, (_, index) => String(index)).filter((mark) => !reached.has(mark));
      expect(missed, `éléments jamais atteints par Tab (marques data-kbd) ; arrêts : ${stops.map((s) => `${s.tag} « ${s.name} »`).join(' → ')}`).toEqual([]);
      for (const stop of stops) {
        expect(stop.ring, `anneau de focus de ${stop.tag} « ${stop.name} » : ${stop.outline}`).toBe(true);
        expect(stop.inViewport, `${stop.tag} « ${stop.name} » dans la fenêtre`).toBe(true);
      }
    });
  }
});

test.describe('assert_keyboard_only_path : du catalogue à un run', () => {
  for (const locale of ['en', 'fr'] as const) {
    test.describe(locale, () => {
      test.use({ uiLocale: locale, uiTheme: 'light' });

      test('filtres, lignes, Nouvelle API et Lancer au clavier seul', async ({ consolePage }) => {
        const { page, app, open, errors } = consolePage;
        const launched: unknown[] = [];
        await open('/apis', {
          routes: {
            'POST /api/apis/:slug/runs': (request) => {
              launched.push(request.body);
              return { status: 202, body: { run_id: RUN_ID, state: 'queued' } };
            },
          },
        });
        await expect(page.getByTestId('catalog-row').first()).toBeVisible();
        await app.settled();
        const names = (stops: Stop[]): string[] => stops.map((stop) => stop.name);

        // 1. Lien d'évitement : Entrée envoie le focus sur <main>, le contenu de la page vient ensuite.
        await page.keyboard.press('Tab');
        expect(await focused(page)).toMatchObject({ tag: 'a', href: '#main' });
        await page.keyboard.press('Enter');
        expect(await page.evaluate(() => document.activeElement?.id)).toBe('main');

        // 2. Filtres : la recherche se tape, un filtre (liste native) se règle avec les flèches ou la saisie, et relit le serveur.
        const stops: Stop[] = [];
        for (let step = 0; step < 12; step += 1) {
          await page.keyboard.press('Tab');
          const stop = await focused(page);
          stops.push(stop);
          if (stop.id === 'catalog-search') break;
        }
        expect(stops.at(-1)?.id, `arrêts : ${names(stops).join(' → ')}`).toBe('catalog-search');
        await page.keyboard.type('livres');
        await expect.poll(() => app.requests.some((entry) => entry.includes('q=livres'))).toBe(true);

        await page.keyboard.press('Tab');
        expect((await focused(page)).id).toBe('catalog-status');
        await page.keyboard.press('Tab');
        expect((await focused(page)).id).toBe('catalog-execution');
        await page.keyboard.press('Tab');
        expect((await focused(page)).id).toBe('catalog-network');

        // 3. Suspendre le suivi (2.2.2) : bouton au clavier, état annoncé par la région `status`.
        await page.keyboard.press('Tab');
        const toggle = await focused(page);
        expect(toggle.tag).toBe('button');
        await page.keyboard.press('Space');
        await expect(page.getByTestId('catalog-live')).toHaveText(text(locale, 'catalog.follow.suspended'));
        await page.keyboard.press('Space');
        await expect(page.getByTestId('catalog-live')).toHaveText('');

        // 4. Lignes : Tab atteint le lien de chaque API ; Entrée ouvre la fiche, et le focus arrive sur son <h1> (06 § 1).
        let row: Stop | undefined;
        for (let step = 0; step < 40 && row?.href !== '/apis/zz-sain'; step += 1) {
          await page.keyboard.press('Tab');
          row = await focused(page);
        }
        expect(row?.href).toBe('/apis/zz-sain');
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\/apis\/zz-sain$/);
        await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('H1');

        // 5. Lancer : le champ requis se remplit au clavier, Tab atteint le bouton Lancer, Entrée sur le bouton envoie ; la réponse
        //    annonce le run (région `status`).
        const fields = await page.evaluate(() => [...document.querySelectorAll('#launch input, #launch select, #launch button')].map((el) => el.id || el.getAttribute('data-testid')));
        expect(fields).toContain('launch-max_pages');
        for (let step = 0; step < 80 && (await focused(page)).id !== 'launch-max_pages'; step += 1) await page.keyboard.press('Tab');
        expect((await focused(page)).id).toBe('launch-max_pages');
        await page.keyboard.type('2');
        const launchLabel = text(locale, 'actions.launch');
        let submit = await focused(page);
        for (let step = 0; step < 10 && !(submit.tag === 'button' && submit.name === launchLabel); step += 1) {
          await page.keyboard.press('Tab');
          submit = await focused(page);
        }
        expect(submit, 'Tab atteint le bouton Lancer').toMatchObject({ tag: 'button', name: launchLabel });
        expect(launched, 'rien n’est lancé avant Entrée sur le bouton').toHaveLength(0);
        await page.keyboard.press('Enter');
        await expect(page.getByTestId('launch-started')).toBeVisible();
        expect(launched).toHaveLength(1);
        expect(launched[0]).toMatchObject({ input: { max_pages: 2 } });
        // La page ne vole pas le focus : il reste sur le bouton, dans le formulaire.
        expect(await page.evaluate(() => document.activeElement?.closest('#launch') !== null)).toBe(true);

        // 6. Retour au catalogue par la navigation (Maj+Tab jusqu'au lien « Catalogue », puis Entrée) ; « Nouvelle API » : bouton de
        //    l'en-tête de la page, atteint par Tab, ouvert par Entrée. Aucune action du navigateur (pas de retour arrière).
        const catalogLabel = text(locale, 'nav.catalog');
        let nav = await focused(page);
        for (let step = 0; step < 80 && !(nav.tag === 'a' && nav.href === '/apis' && nav.name === catalogLabel); step += 1) {
          await page.keyboard.press('Shift+Tab');
          nav = await focused(page);
        }
        expect(nav, 'Maj+Tab atteint le lien Catalogue de la navigation').toMatchObject({ tag: 'a', href: '/apis', name: catalogLabel });
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\/apis$/);
        await expect(page.getByTestId('catalog-row').first()).toBeVisible();
        await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('H1');
        let link = await focused(page);
        for (let step = 0; step < 60 && !(link.tag === 'a' && link.href === '/apis/new'); step += 1) {
          await page.keyboard.press('Tab');
          link = await focused(page);
        }
        expect(link).toMatchObject({ tag: 'a', href: '/apis/new' });
        expect(await page.evaluate(() => document.activeElement?.closest('main') !== null), 'le bouton de l’en-tête de page, pas le lien de la navigation').toBe(true);
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\/apis\/new$/);
        await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('H1');

        expect(errors).toEqual([]);
      });
    });
  }
});

test.describe('assert_keyboard_only_path : confirmation en ligne', () => {
  for (const locale of ['en', 'fr'] as const) {
    test.describe(locale, () => {
      test.use({ uiLocale: locale, uiTheme: 'light' });

      test(`${locale} : ouverte au clavier, Échap l'annule et le focus revient au bouton qui l'a ouverte (2.4.3)`, async ({ consolePage }) => {
        const { page, app, open } = consolePage;
        await open('/apis/zz-sain/strategy');
        await expect(page.locator('h1').first()).toBeVisible();
        await app.settled();
  
        // Tab jusqu'au premier « Revenir à cette version » ; Entrée ouvre la confirmation, le focus arrive sur Annuler (choix prudent).
        const opener = text(locale, 'strategy.revert');
        let stop = await focused(page);
        for (let step = 0; step < 80 && !(stop.tag === 'button' && stop.name === opener); step += 1) {
          await page.keyboard.press('Tab');
          stop = await focused(page);
        }
        expect(stop).toMatchObject({ tag: 'button', name: opener });
        const openerRow = await page.evaluate(() => document.activeElement?.closest('tr')?.textContent?.replace(/\s+/g, ' ').trim());
        await page.keyboard.press('Enter');
        await expect(page.getByTestId('confirm-panel')).toBeVisible();
        expect(await focused(page)).toMatchObject({ tag: 'button', name: text(locale, 'ui.cancel') });
  
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('confirm-panel')).toHaveCount(0);
        const back = await focused(page);
        expect(back, 'le focus revient au bouton d’ouverture, pas à <body>').toMatchObject({ tag: 'button', name: opener });
        expect(await page.evaluate(() => document.activeElement?.closest('tr')?.textContent?.replace(/\s+/g, ' ').trim())).toBe(openerRow);
      });
    });
  }
});
