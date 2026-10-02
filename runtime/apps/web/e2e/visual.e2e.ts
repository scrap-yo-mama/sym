// SPDX-License-Identifier: AGPL-3.0-only
// Régression visuelle par langue (part de 3.6 confiée à 3.17, 21b § 6 : Catalogue et Nouvelle API ; Démarrage reste à 3.16 et
// 3.6). Projets Playwright `ui-en`, `ui-fr` et `ui-pseudo` (playwright.config.ts) : chaque écran, en clair et en sombre, est
// comparé à son instantané de référence (`assert_visual_regression_by_locale`). En pseudo-locale (e2e/pseudo.ts), aucun texte de
// l'interface ne reste en clair (`assert_no_hardcoded_strings_pseudo`) et aucun texte ne déborde de son conteneur ni de la page
// (`assert_no_text_overflow_pseudo`). Horloge figée : les dates relatives (« il y a 2 j ») ne bougent pas d'un jour à l'autre.
// Les instantanés vivent par plateforme dans e2e/__visual__/<plateforme>/ (mode décidé par e2e/visual-policy.ts) : un poste
// local sans instantanés de référence ne compare pas (ignoreSnapshots), la CI échoue ; ils se créent par
// `pnpm test:e2e --update-snapshots` sur cette plateforme, puis se relisent. Ceux de linux ne se créent et ne se comparent que
// dans l'image Playwright épinglée (`pnpm visual:image [--update]`) : ailleurs sous linux, la suite est sautée avec sa raison.
import { test, expect, type Theme } from './console.fixture.ts';
import { PSEUDO_CLOSE, PSEUDO_OPEN } from './pseudo.ts';
import { SCREENS } from './screens.ts';

test.skip(process.env.SYM_VISUAL_MODE === 'excluded', 'instantanés linux : comparés seulement dans l’image Playwright épinglée (pnpm visual:image)');

const VISUAL_SCREENS = ['catalog', 'catalog-all', 'new-api-gate'] as const;
const THEMES: Theme[] = ['light', 'dark'];
/** Instant figé des captures : les dates des fixtures (2026-10-01) restent « d'hier ». */
const FROZEN_AT = new Date('2026-10-02T09:00:00.000Z');

for (const theme of THEMES) {
  test.describe(`assert_visual_regression_by_locale : ${theme}`, () => {
    test.use({ uiTheme: theme, viewport: { width: 1280, height: 900 } });

    for (const id of VISUAL_SCREENS) {
      const screen = SCREENS.find((entry) => entry.id === id);
      if (!screen) throw new Error(`écran inconnu : ${id}`);

      test(id, async ({ consolePage }, testInfo) => {
        const { page, app, errors, open } = consolePage;
        await page.clock.setFixedTime(FROZEN_AT);
        await open(screen.path, { anonymous: screen.anonymous, routes: screen.routes });
        await expect(page.locator('h1').first()).toBeAttached();
        await app.settled();
        await screen.prepare?.(page, app);
        await app.settled();
        await page.evaluate(() => document.fonts.ready);

        if (testInfo.project.name === 'ui-pseudo') {
          // assert_no_hardcoded_strings_pseudo : tout texte visible de l'interface vient du catalogue (donc porte les marques
          // ⟦ ⟧). Ne sont pas de l'interface : les données servies (noms, descriptions, domaines, exemples, montants, dates), la
          // marque (« scrapyomama », « SYM ») et ce qui n'a pas de lettre.
          const plain = await page.evaluate(
            ([open, close]) => {
              const DATA = '[translate="no"], code, pre, time, [data-testid="catalog-row"] th, [data-testid="schema-field"] > span:first-child, [data-testid="schema-description"], .sym-signature__text, [data-brand], [data-testid="trial-cost"], [data-testid="gate-budget-value"]';
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              const out: string[] = [];
              for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const parent = node.parentElement;
                const value = (node.textContent ?? '').trim();
                if (!parent || value === '' || !/\p{L}{2,}/u.test(value)) continue;
                if (parent.closest(DATA) || parent.closest('[aria-hidden="true"], .sr-only, script, style, svg')) continue;
                const box = parent.getBoundingClientRect();
                if (box.width === 0 || box.height === 0) continue;
                // Le texte est dans un message pseudo-localisé si lui ou son élément porte les marques.
                const host = parent.textContent ?? '';
                if (value.includes(open) || value.includes(close) || (host.includes(open) && host.includes(close))) continue;
                out.push(`${parent.tagName.toLowerCase()}: ${value.slice(0, 60)}`);
              }
              return out;
            },
            [PSEUDO_OPEN, PSEUDO_CLOSE] as const,
          );
          expect(plain, `assert_no_hardcoded_strings_pseudo (${id}) : textes restés en clair`).toEqual([]);

          // assert_no_text_overflow_pseudo : le texte allongé tient dans son conteneur et la page ne défile pas en largeur.
          const overflow = await page.evaluate(() => {
            const cut = [...document.querySelectorAll<HTMLElement>('body *')]
              .filter((el) => {
                if (el.closest('[data-reflow-exempt], table, pre, [role="log"], .sr-only, svg')) return false;
                const style = getComputedStyle(el);
                const clips = style.overflowX === 'hidden' || style.overflowX === 'clip' || style.textOverflow === 'ellipsis';
                return clips && el.scrollWidth > el.clientWidth + 1 && (el.textContent ?? '').trim() !== '';
              })
              .slice(0, 5)
              .map((el) => `${el.tagName.toLowerCase()}[${el.getAttribute('data-testid') ?? ''}] ${(el.textContent ?? '').trim().slice(0, 40)}`);
            return { cut, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
          });
          expect(overflow.cut, `assert_no_text_overflow_pseudo (${id}) : texte coupé`).toEqual([]);
          expect(overflow.scrollWidth, `assert_no_text_overflow_pseudo (${id}) : défilement horizontal`).toBeLessThanOrEqual(overflow.clientWidth);
        }

        await expect(page).toHaveScreenshot(`${id}-${theme}.png`, { fullPage: true, animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.002 });
        const unexpected = screen.expectsNetworkError ? [] : errors;
        expect(unexpected, 'erreurs de la console du navigateur').toEqual([]);
      });
    }
  });
}
