// SPDX-License-Identifier: AGPL-3.0-only
// assert_landing_reduced_motion (22b § 2, WCAG 2.2.2) : avec `prefers-reduced-motion: reduce`, aucune animation n'est en cours et
// l'état final de la démo est affiché ; sans la préférence, l'animation joue UNE fois, le bouton de pause l'arrête, la reprise la
// relance et « Rejouer » la repart du début.
import { expect, test } from '@playwright/test';
import { homeUrl, LANGS_UNDER_TEST } from './pages.ts';

for (const lang of LANGS_UNDER_TEST) {
  test(`assert_landing_reduced_motion : mouvement réduit, état final direct (${lang})`, async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto(homeUrl(lang));
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    const opacities = await page.evaluate(() => [...document.querySelectorAll('.lp-msg')].map((el) => getComputedStyle(el).opacity));
    expect(opacities).toHaveLength(8);
    for (const opacity of opacities) expect(opacity).toBe('1');
    await context.close();
  });
}

test('assert_landing_reduced_motion : sans préférence, une seule lecture, pause, reprise et rejeu', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'no-preference' });
  const page = await context.newPage();
  await page.goto(homeUrl('en'));
  const animations = await page.evaluate(() => document.getAnimations().map((a) => ({ iterations: (a.effect as KeyframeEffect).getComputedTiming().iterations, name: (a as CSSAnimation).animationName })));
  expect(animations.length).toBe(8);
  for (const animation of animations) expect(animation.iterations).toBe(1);

  const pause = page.locator('.lp-demo-controls button').first();
  await pause.click();
  expect(await pause.getAttribute('aria-pressed')).toBe('true');
  expect(await page.evaluate(() => document.getAnimations().every((a) => a.playState === 'paused'))).toBe(true);
  await pause.click();
  expect(await pause.getAttribute('aria-pressed')).toBe('false');
  expect(await page.evaluate(() => document.getAnimations().some((a) => a.playState === 'running'))).toBe(true);

  // Laisser finir (9 s de décalage au plus + 0,45 s), puis rejouer : les animations repartent du début.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState === 'finished'), undefined, { timeout: 20_000 });
  expect(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length)).toBe(0);
  await page.locator('.lp-demo-controls button').nth(1).click();
  await page.waitForFunction(() => document.getAnimations().length === 8);
  expect(await page.evaluate(() => document.getAnimations().some((a) => a.playState === 'running' || a.playState === 'paused'))).toBe(true);
  await context.close();
});
