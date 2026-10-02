// SPDX-License-Identifier: AGPL-3.0-only
// assert_landing_perf_budget (22b § 2, 22 § 2.8), sur le build de production servi avec compression gzip comme GitHub Pages :
// - budgets de scripts/vitrine/budgets.json mesurés par Chromium en mobile, réseau « 4G lente » et processeur ralenti 4 fois (profil
//   mobile de Lighthouse, émulé par le protocole DevTools AVANT le chargement : sur la boucle locale sans bridage, un LCP ne prouve
//   rien) : première vue, JS en gzip, polices, nombre de requêtes, requêtes tierces, LCP, CLS ; le test vérifie d'abord que le
//   bridage s'applique (le premier octet arrive après un aller-retour réseau émulé) ;
// - scores Lighthouse mobile (configuration par défaut : mobile, bridage simulé) : performance, accessibilité et SEO ≥ seuils.
import { expect, test } from '@playwright/test';
import { lighthouseFailures, navigationTtfb } from '../src/landing/checks.ts';
import { runLighthouse } from '../src/landing/lighthouse.ts';
import { budgets, homeUrl, LANGS_UNDER_TEST } from './pages.ts';

type Metrics = { lcp: number; cls: number };

for (const lang of LANGS_UNDER_TEST) {
  test(`assert_landing_perf_budget : ${lang}, mobile, 4G lente et processeur ralenti`, async ({ browser }) => {
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
    // Bridage avant le premier octet : réseau (latence, débits en octets par seconde) et processeur.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: limits.lab.rttMs, downloadThroughput: (limits.lab.downloadKbps * 1024) / 8, uploadThroughput: (limits.lab.uploadKbps * 1024) / 8 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: limits.lab.cpuSlowdown });
    const responses: { url: string; type: string; transferred: number; body: number }[] = [];
    page.on('requestfinished', async (request) => {
      const sizes = await request.sizes();
      responses.push({ url: request.url(), type: request.resourceType(), transferred: sizes.responseBodySize + sizes.responseHeadersSize, body: sizes.responseBodySize });
    });
    await page.goto(homeUrl(lang), { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    const metrics = await page.evaluate(() => (globalThis as unknown as { __metrics: Metrics }).__metrics);
    // Premier octet depuis le début de la navigation (navigationTtfb) : sous bridage, la latence émulée précède requestStart.
    const navigation = { ttfb: navigationTtfb(await page.evaluate(() => {
      const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      return entry ? { startTime: entry.startTime, responseStart: entry.responseStart } : undefined;
    })) };
    const origin = new URL(homeUrl(lang)).origin;

    const total = responses.reduce((sum, r) => sum + r.transferred, 0);
    // JS et polices : octets du corps compressé (les en-têtes comptent dans la première vue seulement).
    const js = responses.filter((r) => r.type === 'script' || /\.js(\?|$)/.test(r.url)).reduce((sum, r) => sum + r.body, 0);
    const fonts = responses.filter((r) => r.type === 'font').map((r) => ({ ...r, transferred: r.body }));
    const fontsBase = fonts.filter((r) => !/jetbrains-mono/.test(r.url)).reduce((sum, r) => sum + r.transferred, 0);
    const report = `premier octet ${navigation.ttfb.toFixed(0)} ms, première vue ${(total / 1024).toFixed(1)} Ko, JS ${(js / 1024).toFixed(1)} Ko, polices ${(fontsBase / 1024).toFixed(1)} Ko (+ mono ${((fonts.reduce((s, r) => s + r.transferred, 0) - fontsBase) / 1024).toFixed(1)}), ${responses.length} requêtes, LCP ${metrics.lcp.toFixed(0)} ms, CLS ${metrics.cls.toFixed(3)}`;
    console.log(`perf ${lang} : ${report}\n${responses.map((r) => `  ${(r.transferred / 1024).toFixed(1)} Ko ${r.url.replace(origin, '')}`).join('\n')}`);

    // Le bridage s'applique : le premier octet du document arrive après un aller-retour réseau émulé (sinon le LCP ne prouve rien).
    expect(navigation.ttfb, `bridage réseau absent : ${report}`).toBeGreaterThanOrEqual(limits.lab.rttMs * 0.9);
    expect(total / 1024, report).toBeLessThanOrEqual(limits.firstViewKB);
    expect(js / 1024, report).toBeLessThanOrEqual(limits.jsGzipKB);
    expect(fontsBase / 1024, report).toBeLessThanOrEqual(limits.fontsKB);
    expect(responses.length, report).toBeLessThanOrEqual(limits.requests);
    expect(responses.filter((r) => !r.url.startsWith(origin)).length, report).toBeLessThanOrEqual(limits.thirdPartyRequests);
    expect(metrics.lcp, report).toBeGreaterThan(0);
    expect(metrics.lcp, report).toBeLessThanOrEqual(limits.lcpMs);
    expect(metrics.cls, report).toBeLessThanOrEqual(limits.cls);
    await context.close();
  });
}

test('assert_landing_perf_budget : Lighthouse mobile, performance, accessibilité et SEO au-dessus des seuils', async () => {
  test.setTimeout(300_000);
  const limits = budgets();
  const runs = await runLighthouse(LANGS_UNDER_TEST.map(homeUrl));
  for (const run of runs) {
    const scores = Object.entries(run.categories).map(([id, category]) => `${id} ${Math.round((category?.score ?? 0) * 100)}`).join(', ');
    console.log(`lighthouse ${run.url} (${run.formFactor}, ${run.throttlingMethod}) : ${scores}${run.weakAudits.length > 0 ? `\n  ${run.weakAudits.join('\n  ')}` : ''}`);
    expect(run.runtimeError, run.url).toBeUndefined();
    expect(run.formFactor, run.url).toBe('mobile');
    expect(lighthouseFailures(run.categories, limits.lighthouse), `${run.url} : ${scores}`).toEqual([]);
  }
});
