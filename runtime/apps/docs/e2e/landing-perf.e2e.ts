// SPDX-License-Identifier: AGPL-3.0-only
// assert_landing_perf_budget (22b § 2, 22 § 2.8) : budgets de scripts/vitrine/budgets.json mesurés en laboratoire par Chromium, en
// mobile, sur le build de production servi avec compression gzip comme GitHub Pages : première vue, JS en gzip, polices, nombre de
// requêtes, requêtes tierces, LCP, CLS. Lighthouse n'est pas une dépendance du projet : les scores Lighthouse (≥ 95, « à valider »)
// ne sont pas mesurés ici (écart consigné).
import { expect, test } from '@playwright/test';
import { budgets, homeUrl, LANGS_UNDER_TEST } from './pages.ts';

type Metrics = { lcp: number; cls: number };

for (const lang of LANGS_UNDER_TEST) {
  test(`assert_landing_perf_budget : ${lang}, mobile`, async ({ browser }) => {
    const limits = budgets();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    await context.addInitScript(() => {
      const scope = globalThis as unknown as { __metrics: Metrics };
      scope.__metrics = { lcp: 0, cls: 0 };
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) scope.__metrics.lcp = entry.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!entry.hadRecentInput) scope.__metrics.cls += entry.value;
      }).observe({ type: 'layout-shift', buffered: true });
    });
    const page = await context.newPage();
    const responses: { url: string; type: string; transferred: number; body: number }[] = [];
    page.on('requestfinished', async (request) => {
      const sizes = await request.sizes();
      responses.push({ url: request.url(), type: request.resourceType(), transferred: sizes.responseBodySize + sizes.responseHeadersSize, body: sizes.responseBodySize });
    });
    await page.goto(homeUrl(lang), { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    const metrics = await page.evaluate(() => (globalThis as unknown as { __metrics: Metrics }).__metrics);
    const origin = new URL(homeUrl(lang)).origin;

    const total = responses.reduce((sum, r) => sum + r.transferred, 0);
    // JS et polices : octets du corps compressé (les en-têtes comptent dans la première vue seulement).
    const js = responses.filter((r) => r.type === 'script' || /\.js(\?|$)/.test(r.url)).reduce((sum, r) => sum + r.body, 0);
    const fonts = responses.filter((r) => r.type === 'font').map((r) => ({ ...r, transferred: r.body }));
    const fontsBase = fonts.filter((r) => !/jetbrains-mono/.test(r.url)).reduce((sum, r) => sum + r.transferred, 0);
    const report = `première vue ${(total / 1024).toFixed(1)} Ko, JS ${(js / 1024).toFixed(1)} Ko, polices ${(fontsBase / 1024).toFixed(1)} Ko (+ mono ${((fonts.reduce((s, r) => s + r.transferred, 0) - fontsBase) / 1024).toFixed(1)}), ${responses.length} requêtes, LCP ${metrics.lcp.toFixed(0)} ms, CLS ${metrics.cls.toFixed(3)}`;
    console.log(`perf ${lang} : ${report}\n${responses.map((r) => `  ${(r.transferred / 1024).toFixed(1)} Ko ${r.url.replace(origin, '')}`).join('\n')}`);

    expect(total / 1024, report).toBeLessThanOrEqual(limits.firstViewKB);
    expect(js / 1024, report).toBeLessThanOrEqual(limits.jsGzipKB);
    expect(fontsBase / 1024, report).toBeLessThanOrEqual(limits.fontsKB);
    expect(responses.length, report).toBeLessThanOrEqual(limits.requests);
    expect(responses.filter((r) => !r.url.startsWith(origin)).length, report).toBeLessThanOrEqual(limits.thirdPartyRequests);
    expect(metrics.lcp, report).toBeLessThanOrEqual(limits.lcpMs);
    expect(metrics.cls, report).toBeLessThanOrEqual(limits.cls);
    await context.close();
  });
}
