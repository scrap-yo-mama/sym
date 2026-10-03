// SPDX-License-Identifier: AGPL-3.0-only
// assert_landing_perf_budget (22b § 2, 22 § 2.8), sur le build de production servi avec compression gzip comme GitHub Pages :
// - budgets de scripts/vitrine/budgets.json mesurés par Chromium en mobile, réseau « 4G lente » et processeur ralenti 4 fois (profil
//   mobile de Lighthouse, émulé par le protocole DevTools AVANT le chargement : sur la boucle locale sans bridage, un LCP ne prouve
//   rien) : première vue, JS en gzip, polices, nombre de requêtes, requêtes tierces, LCP, CLS ; le test vérifie d'abord que le
//   bridage s'applique (le premier octet arrive après un aller-retour réseau émulé) ;
// - scores Lighthouse mobile (configuration par défaut : mobile, bridage simulé) : performance, accessibilité et SEO ≥ seuils, et CLS et
//   LCP mesurés par Lighthouse (audits) sous les budgets.
import { expect, test, type Browser } from '@playwright/test';
import { labNetworkConditions, lighthouseFailures, lighthouseMetricFailures, navigationTtfb } from '../src/landing/checks.ts';
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
    // Network.emulateNetworkConditions est obsolète (sans effet sur la latence dans Chromium 153) : règle globale + état du réseau.
    const network = labNetworkConditions(limits.lab);
    await cdp.send('Network.emulateNetworkConditionsByRule', network.byRule);
    await cdp.send('Network.overrideNetworkState', network.state);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: limits.lab.cpuSlowdown });
    const responses: { url: string; type: string; transferred: number; body: number }[] = [];
    page.on('requestfinished', async (request) => {
      const sizes = await request.sizes();
      responses.push({ url: request.url(), type: request.resourceType(), transferred: sizes.responseBodySize + sizes.responseHeadersSize, body: sizes.responseBodySize });
    });
    const documentResponse = await page.goto(homeUrl(lang), { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    const browserTtfb = documentResponse ? documentResponse.request().timing().responseStart : -1;
    const metrics = await page.evaluate(() => (globalThis as unknown as { __metrics: Metrics }).__metrics);
    // Premier octet depuis le début de la navigation (navigationTtfb) : sous bridage, la latence émulée précède requestStart.
    const navigation = { ttfb: navigationTtfb(await page.evaluate(() => {
      const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      return entry ? { startTime: entry.startTime, responseStart: entry.responseStart } : undefined;
    })) };
    // Premier octet vu par le navigateur (Playwright, depuis startTime) : retenu s'il est plus grand que celui de la page.
    navigation.ttfb = Math.max(navigation.ttfb, browserTtfb);
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

// CLS à la source : au remplacement de police (font-display swap), une ligne de plus ou de moins décale tout ce qui suit. La disposition
// est comparée entre les polices web et le repli local affiché avant leur arrivée, de 320 px au bureau, dont 390 px (budget de
// laboratoire) et 412 px (écran mobile de Lighthouse) :
// - l'en-tête précède tout le contenu : sa hauteur et la ligne de chaque lien et de chaque outil sont identiques (à 412 px, la
//   navigation anglaise tenait sur une ligne à un pixel près avec DM Sans et pas avec le repli) ;
// - au-dessus de la ligne de flottaison : le haut de chaque bloc du hero (surtitre, titre, définition, appels à l'action, commande,
//   liens) et de chaque section visible est identique. Un bloc qui grandit sous la ligne de flottaison ne décale rien de visible.
const LAYOUT_WIDTHS = [320, 360, 375, 390, 412, 430, 480, 540, 600, 700, 768, 820, 900, 1024, 1280, 1440];
const LAYOUT_HEIGHT = 823;

type AboveFold = { header: string; blocks: { name: string; top: number }[] };

async function layoutWithFonts(browser: Browser, url: string, width: number, webFonts: boolean): Promise<AboveFold> {
  const context = await browser.newContext({ viewport: { width, height: LAYOUT_HEIGHT }, reducedMotion: 'reduce' });
  if (!webFonts) await context.route('**/*.woff2', (route) => route.abort());
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  const layout = await page.evaluate(async (): Promise<AboveFold> => {
    await document.fonts.ready;
    const box = (el: Element): DOMRect => el.getBoundingClientRect();
    const header = document.querySelector('.lp-header');
    if (!header) return { header: 'en-tête absent', blocks: [] };
    const rows = [...header.querySelectorAll('.lp-brand, .lp-nav li, .lp-tools > *')].map((el) => `${(el.textContent ?? '').trim().slice(0, 12) || el.className}@${Math.round(box(el).top)}`);
    const blocks = [
      ...[...document.querySelectorAll('.lp-hero__text > *')].map((el, index) => ({ name: `hero ${index + 1} (${el.tagName.toLowerCase()}${el.className ? `.${el.className.split(' ')[0]}` : ''})`, top: Math.round(box(el).top) })),
      ...[...document.querySelectorAll('main > section')].map((el) => ({ name: `section #${el.id}`, top: Math.round(box(el).top) })),
    ];
    return { header: `hauteur ${Math.round(box(header).height)} ; ${rows.join(' ')}`, blocks };
  });
  const fonts = await page.evaluate(() => [...document.fonts].filter((font) => font.status === 'loaded').map((font) => font.family).join(','));
  await context.close();
  if (webFonts && !fonts.includes('DM Sans')) throw new Error(`polices web non chargées à ${width} px : ${fonts}`);
  return layout;
}

/** Écarts de disposition entre polices web et repli : en-tête entier, puis blocs dont le haut est visible dans l'une des deux. */
function layoutDifferences(web: AboveFold, fallback: AboveFold, fold: number): string[] {
  const differences = web.header === fallback.header ? [] : [`en-tête\n      polices web : ${web.header}\n      repli       : ${fallback.header}`];
  for (const block of web.blocks) {
    const other = fallback.blocks.find((candidate) => candidate.name === block.name);
    if (!other) differences.push(`${block.name} absent avec le repli`);
    else if ((block.top < fold || other.top < fold) && block.top !== other.top) differences.push(`${block.name} : haut à ${block.top} px avec les polices web, ${other.top} px avec le repli`);
  }
  return differences;
}

for (const lang of LANGS_UNDER_TEST) {
  test(`assert_landing_perf_budget : disposition de l'en-tête et du dessus de la ligne de flottaison indépendante des polices web (CLS), ${lang}`, async ({ browser }) => {
    test.setTimeout(300_000);
    const differences: string[] = [];
    for (const width of LAYOUT_WIDTHS) {
      const web = await layoutWithFonts(browser, homeUrl(lang), width, true);
      const fallback = await layoutWithFonts(browser, homeUrl(lang), width, false);
      const found = layoutDifferences(web, fallback, LAYOUT_HEIGHT);
      if (found.length > 0) differences.push(`${width} px\n    ${found.join('\n    ')}`);
    }
    expect(differences, differences.join('\n')).toEqual([]);
  });
}

test('assert_landing_perf_budget : Lighthouse mobile, performance, accessibilité et SEO au-dessus des seuils', async () => {
  test.setTimeout(300_000);
  const limits = budgets();
  const runs = await runLighthouse(LANGS_UNDER_TEST.map(homeUrl));
  for (const run of runs) {
    const scores = Object.entries(run.categories).map(([id, category]) => `${id} ${Math.round((category?.score ?? 0) * 100)}`).join(', ');
    console.log(`lighthouse ${run.url} (${run.formFactor}, ${run.throttlingMethod}) : ${scores}, CLS ${run.metrics.cls?.toFixed(3) ?? 'non mesuré'}, LCP ${run.metrics.lcpMs?.toFixed(0) ?? 'non mesuré'} ms${run.weakAudits.length > 0 ? `\n  ${run.weakAudits.join('\n  ')}` : ''}`);
    expect(run.runtimeError, run.url).toBeUndefined();
    expect(run.formFactor, run.url).toBe('mobile');
    expect(lighthouseFailures(run.categories, limits.lighthouse), `${run.url} : ${scores}`).toEqual([]);
    // CLS ≤ 0,1 en laboratoire selon Lighthouse lui-même : une performance ≥ 95 tolère un CLS jusqu'à environ 0,15.
    expect(lighthouseMetricFailures(run.metrics, { cls: limits.cls, lcpMs: limits.lcpMs }), `${run.url} : ${run.weakAudits.join(' ; ')}`).toEqual([]);
  }
});
