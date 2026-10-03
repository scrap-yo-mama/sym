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

// CLS au remplacement de police (font-display swap) : le pire cas pour l'utilisateur est une police web qui arrive APRÈS le premier rendu
// avec le repli local. Le test retient les polices web (woff2) jusqu'à ce que la page soit peinte avec le repli, les relâche une à une,
// et additionne les décalages de mise en page (PerformanceObserver layout-shift, hors interaction) de tout le chargement : c'est la
// mesure du CLS, qui ne compte que ce qui bouge DANS la fenêtre, pondéré par la surface et la distance, et non une égalité au pixel des
// positions, qui dépend des métriques de la police locale de l'exécuteur (Liberation Sans sous Linux : une ligne de plus ou de moins
// dans un paragraphe du hero, sans décalage notable). De 320 px au bureau, dont 390 px (budget de laboratoire) et 412 px (écran mobile
// de Lighthouse), en et fr ; seuil : le CLS du budget (budgets().cls), à CHAQUE largeur. Un en-tête qui change de hauteur au
// remplacement (la navigation anglaise passait à la ligne avec le repli à 412 px : CLS 0,345 sous Lighthouse) décale tout <main> et
// dépasse le seuil (jusqu'à 0,78 mesuré sur la feuille de style d'avant la grille de l'en-tête).
const LAYOUT_WIDTHS = [320, 360, 375, 390, 412, 430, 480, 540, 600, 700, 768, 820, 900, 1024, 1280, 1440];
const LAYOUT_HEIGHT = 823;

type Shift = { value: number; at: number; sources: string[] };
type FontSwap = { cls: number; beforeSwap: number; shifts: Shift[] };

async function shiftsWhenFontsArriveLate(browser: Browser, url: string, width: number): Promise<FontSwap> {
  const context = await browser.newContext({ viewport: { width, height: LAYOUT_HEIGHT }, reducedMotion: 'reduce' });
  // Polices web retenues : chaque requête attend que le test la relâche ; après la libération générale, elles passent directement.
  const held: (() => void)[] = [];
  let released = false;
  await context.route('**/*.woff2', async (route) => {
    if (!released) await new Promise<void>((resolve) => held.push(resolve));
    await route.continue();
  });
  await context.addInitScript(() => {
    const scope = globalThis as unknown as { __shifts: Shift[] };
    scope.__shifts = [];
    const name = (node: Node | null): string => {
      if (!node) return '?';
      const el = node instanceof Element ? node : node.parentElement;
      if (!el) return node.nodeName;
      return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.classList.length > 0 ? `.${[...el.classList].join('.')}` : ''}`;
    };
    type LayoutShiftSource = { node: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as { value: number; startTime: number; hadRecentInput: boolean; sources: LayoutShiftSource[] }[]) {
        if (entry.hadRecentInput) continue;
        scope.__shifts.push({
          value: entry.value,
          at: Math.round(entry.startTime),
          sources: entry.sources.map((source) => `${name(source.node)} ${Math.round(source.previousRect.top)}→${Math.round(source.currentRect.top)} px (h ${Math.round(source.previousRect.height)}→${Math.round(source.currentRect.height)})`),
        });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  const page = await context.newPage();
  const twoFrames = (): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Premier rendu avec le repli : les polices web sont demandées et retenues, la page est peinte, aucune n'est chargée.
  await expect.poll(() => held.length, { message: `aucune police web demandée à ${width} px` }).toBeGreaterThan(0);
  await twoFrames();
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => ({
    painted: performance.getEntriesByType('paint').some((entry) => entry.name === 'first-contentful-paint'),
    webFonts: [...document.fonts].filter((font) => font.status === 'loaded' && !font.family.includes('Repli')).map((font) => font.family),
    shifts: (globalThis as unknown as { __shifts: Shift[] }).__shifts.length,
  }));
  if (!before.painted || before.webFonts.length > 0) throw new Error(`repli non peint seul à ${width} px : ${JSON.stringify(before)}`);
  // Les polices arrivent l'une après l'autre (comme sur un réseau lent), puis toutes celles demandées ensuite.
  for (const resume of held.splice(0)) {
    resume();
    await page.waitForTimeout(150);
  }
  released = true;
  for (const resume of held.splice(0)) resume();
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((font) => font.status === 'loaded').map((font) => font.family).join(',');
  });
  await twoFrames();
  await page.waitForTimeout(300);
  const shifts = await page.evaluate(() => (globalThis as unknown as { __shifts: Shift[] }).__shifts);
  await context.close();
  if (!loaded.includes('DM Sans')) throw new Error(`polices web non chargées à ${width} px : ${loaded}`);
  const sum = (list: Shift[]): number => list.reduce((total, shift) => total + shift.value, 0);
  return { cls: sum(shifts), beforeSwap: sum(shifts.slice(0, before.shifts)), shifts };
}

for (const lang of LANGS_UNDER_TEST) {
  test(`assert_landing_perf_budget : remplacement des polices web arrivées après le repli sans décalage visible (CLS), ${lang}`, async ({ browser }) => {
    test.setTimeout(300_000);
    const limit = budgets().cls;
    const failures: string[] = [];
    const report: string[] = [];
    for (const width of LAYOUT_WIDTHS) {
      const swap = await shiftsWhenFontsArriveLate(browser, homeUrl(lang), width);
      const detail = swap.shifts.map((shift) => `      ${shift.value.toFixed(4)} à ${shift.at} ms : ${shift.sources.join(' ; ')}`).join('\n');
      report.push(`${width} px : CLS ${swap.cls.toFixed(4)} (avant les polices web ${swap.beforeSwap.toFixed(4)})`);
      if (swap.cls > limit) failures.push(`${width} px : CLS ${swap.cls.toFixed(4)} > ${limit}\n${detail}`);
    }
    console.log(`remplacement des polices ${lang} (seuil ${limit}) :\n  ${report.join('\n  ')}`);
    expect(failures, failures.join('\n')).toEqual([]);
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
