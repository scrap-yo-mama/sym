// SPDX-License-Identifier: AGPL-3.0-only
// assert_landing_a11y_axe_clean (22b § 2, WCAG 2.2 AA) : `/` et `/fr/` en clair et en sombre, puis en contraste forcé : 0 violation
// axe ; parcours au clavier complet ; cibles de 24 px au moins ; focus non masqué par l'en-tête ; zoom 200 % et 320 px sans
// défilement horizontal ; `lang` de chaque page.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { LEGAL_PATHS } from '../src/landing/href.ts';
import { homeUrl, LANGS_UNDER_TEST, preprodUrl } from './pages.ts';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function axeReport(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return results.violations.map((v) => `${v.impact} ${v.id} : ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 4).join(' | ')}`);
}

for (const scheme of ['light', 'dark'] as const) {
  for (const lang of LANGS_UNDER_TEST) {
    test(`assert_landing_a11y_axe_clean : ${lang}, ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({ colorScheme: scheme, reducedMotion: 'reduce' });
      const page = await context.newPage();
      await page.goto(homeUrl(lang));
      expect(await page.evaluate(() => document.documentElement.lang)).toBe(lang);
      expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(scheme === 'dark');
      expect(await axeReport(page)).toEqual([]);
      await context.close();
    });
  }
}

test('assert_landing_a11y_axe_clean : pages juridiques, en clair et en sombre', async ({ browser }) => {
  for (const scheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ colorScheme: scheme });
    const page = await context.newPage();
    for (const lang of LANGS_UNDER_TEST) {
      for (const path of Object.values(LEGAL_PATHS[lang])) {
        await page.goto(`${preprodUrl()}/${path}`);
        expect(await page.evaluate(() => document.documentElement.lang), path).toBe(lang);
        expect(await axeReport(page), `${path} (${scheme})`).toEqual([]);
      }
    }
    await context.close();
  }
});

test('assert_landing_a11y_axe_clean : contraste forcé (forced-colors)', async ({ browser }) => {
  const context = await browser.newContext({ forcedColors: 'active', reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(homeUrl('en'));
  expect(await axeReport(page)).toEqual([]);
  const borders = await page.evaluate(() => [...document.querySelectorAll('.lp-btn')].map((el) => getComputedStyle(el).borderTopWidth));
  expect(borders.length).toBeGreaterThan(3);
  for (const width of borders) expect(parseFloat(width)).toBeGreaterThanOrEqual(1);
  await context.close();
});

for (const lang of LANGS_UNDER_TEST) {
  test(`parcours au clavier, cibles et focus : ${lang}`, async ({ page }) => {
    await page.goto(homeUrl(lang));
    await page.keyboard.press('Tab');
    const first = await page.evaluate(() => ({ text: document.activeElement?.textContent ?? '', href: document.activeElement?.getAttribute('href') }));
    expect(first.href, 'le premier arrêt du clavier est le lien d\'évitement').toBe('#main');
    const box = await page.locator('.lp-skip').boundingBox();
    expect(box && box.y >= 0, 'le lien d\'évitement apparaît à l\'écran au focus').toBe(true);
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('main');

    // Tous les éléments interactifs reçoivent le focus au clavier, dans l'ordre du document, avec un anneau visible.
    const interactive = await page.locator('main a[href], main button, main summary, header a[href], header button, footer a[href], main pre[tabindex="0"]').count();
    expect(interactive).toBeGreaterThan(30);
    await page.locator('.lp-skip').focus();
    const seen = new Set<string>();
    for (let index = 0; index < interactive + 8; index += 1) {
      await page.keyboard.press('Tab');
      const state = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const header = document.querySelector('.lp-header')?.getBoundingClientRect();
        return { id: `${el.tagName}:${el.textContent?.trim().slice(0, 30)}:${el.getAttribute('href') ?? ''}`, outline: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2, hiddenByHeader: !!header && rect.top < header.bottom && rect.bottom > 0 && el.closest('.lp-header') === null && window.scrollY > header.bottom };
      });
      if (!state) break;
      seen.add(state.id);
      expect(state.outline, `anneau de focus sur ${state.id}`).toBe(true);
      expect(state.hiddenByHeader, `focus masqué par l'en-tête : ${state.id}`).toBe(false);
    }
    expect(seen.size).toBeGreaterThan(25);

    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('a[href], button, summary')]
        .filter((el) => el.offsetParent !== null && !el.classList.contains('lp-skip') && !el.classList.contains('lp-visually-hidden'))
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width < 24 || rect.height < 24)
        .map(({ el }) => `${el.tagName}:${el.textContent?.trim().slice(0, 30)}`),
    );
    expect(small, 'cibles de moins de 24 px').toEqual([]);
  });

  test(`zoom 200 % et reflow à 320 px sans défilement horizontal : ${lang}`, async ({ browser }) => {
    for (const width of [640, 320]) {
      const context = await browser.newContext({ viewport: { width, height: 800 } });
      const page = await context.newPage();
      await page.goto(homeUrl(lang));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `défilement horizontal à ${width} px`).toBeLessThanOrEqual(0);
      const wide = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('body *')]
          .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !el.closest('pre, [role="region"]'))
          .slice(0, 5)
          .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)}`),
      );
      expect(wide, `éléments hors écran à ${width} px`).toEqual([]);
      await context.close();
    }
  });
}
