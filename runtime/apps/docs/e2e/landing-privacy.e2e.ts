// SPDX-License-Identifier: AGPL-3.0-only
// Gates de la landing « sans inscription, sans tiers, sans cookie » et « CSP » (22b § 2), jouées sur la préproduction (build de
// production servi comme GitHub Pages, sans en-têtes) :
// - assert_landing_no_signup : 0 formulaire, 0 champ de saisie, CSP `form-action 'none'` ;
// - assert_landing_no_third_party_request : 100 % des requêtes vont vers l'origine de la page (liste d'autorisation vide) ;
// - assert_landing_no_third_party_tracker : aucun domaine de traceur demandé ni référencé dans le HTML ;
// - assert_landing_no_cookie : document.cookie vide, aucun Set-Cookie, aucune écriture de stockage avant une action explicite ;
// - assert_landing_csp_strict : la balise CSP précède tout script, 0 violation, aucun attribut style, forme exacte de la politique.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { withBrowser, probePages, type PageProbe } from '../src/landing/probe.ts';
import { HOST_INJECTIONS, TRACKER_DOMAINS } from '../src/landing/trackers.ts';
import { startPagesServer } from './pages-server.ts';
import { allLandingUrls, homeUrl, preprodUrl } from './pages.ts';

let probes: PageProbe[] = [];
test.beforeAll(async () => {
  probes = await withBrowser((browser) => probePages(browser, allLandingUrls()));
});

const label = (probe: PageProbe): string => probe.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '');

test.describe('assert_landing_no_signup', () => {
  test('aucun formulaire ni champ de saisie, et la CSP interdit toute soumission', () => {
    for (const probe of probes) {
      expect(probe.formCount, label(probe)).toBe(0);
      expect(probe.cspMeta ?? '', label(probe)).toContain("form-action 'none'");
      expect(probe.html, label(probe)).not.toMatch(/<form\b|type="(?:email|password)"/);
    }
  });
});

test.describe('assert_landing_no_third_party_request', () => {
  test('chargement, défilement, transcription, pause de la démo, copie de la commande : que l\'origine de la page', () => {
    for (const probe of probes) {
      expect(probe.requests.length, label(probe)).toBeGreaterThan(3);
      expect(probe.thirdPartyRequests, label(probe)).toEqual([]);
    }
  });
});

test.describe('assert_landing_no_third_party_tracker', () => {
  test('aucun domaine de traceur n\'est demandé ni référencé dans le HTML', () => {
    for (const probe of probes) {
      expect(probe.trackerRequests, label(probe)).toEqual([]);
      const referenced = [...TRACKER_DOMAINS, ...HOST_INJECTIONS].filter((needle) => probe.html.includes(needle));
      expect(referenced, `${label(probe)} : traceur référencé dans le code source`).toEqual([]);
    }
  });
});

test.describe('assert_landing_no_cookie', () => {
  test('document.cookie vide, aucun Set-Cookie, aucun stockage écrit avant une action', () => {
    for (const probe of probes) {
      expect(probe.documentCookie, label(probe)).toBe('');
      expect(probe.contextCookies, label(probe)).toEqual([]);
      expect(probe.setCookieHeaders, label(probe)).toEqual([]);
      expect(probe.storageWritesBeforeAction, label(probe)).toEqual([]);
      expect(probe.storageAfterLoad, label(probe)).toEqual([]);
    }
  });

  test('la sonde voit le stockage écrit autrement que par setItem : affectation directe, IndexedDB, Cache, service worker', async () => {
    // Page témoin (hors landing) servie comme la préproduction : elle écrit par toutes les voies que setItem ne voit pas.
    const dir = mkdtempSync(join(tmpdir(), 'zz-probe-storage-'));
    writeFileSync(join(dir, 'sw.js'), '');
    writeFileSync(join(dir, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>zz</title></head><body><p>zz</p><script>
localStorage.zzDirect = '1'; sessionStorage['zzBracket'] = '1'; indexedDB.open('zz-db'); caches.open('zz-cache'); navigator.serviceWorker.register('sw.js');
</script></body></html>`);
    const server = await startPagesServer(dir, '/sym/');
    try {
      const [probe] = await withBrowser((browser) => probePages(browser, [`${server.url}/`]));
      expect(probe?.storageWritesBeforeAction).toEqual([]);
      expect(probe?.storageAfterLoad).toEqual(expect.arrayContaining(['localStorage.zzDirect', 'sessionStorage.zzBracket', 'indexedDB:zz-db', 'caches:zz-cache', `serviceWorker:${server.url}/`]));
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('le choix du thème est la seule écriture de stockage, et seulement après le clic', async () => {
    await withBrowser(async (browser) => {
      const context = await browser.newContext();
      const writes: string[] = [];
      await context.addInitScript(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function patched(key: string, value: string): void {
          (globalThis as unknown as { __writes: string[] }).__writes ??= [];
          (globalThis as unknown as { __writes: string[] }).__writes.push(key);
          original.call(this, key, value);
        };
      });
      const page = await context.newPage();
      await page.goto(homeUrl('en'));
      writes.push(...((await page.evaluate(() => (globalThis as unknown as { __writes?: string[] }).__writes ?? [])) as string[]));
      expect(writes).toEqual([]);
      await page.locator('.lp-theme').click();
      expect(await page.evaluate(() => (globalThis as unknown as { __writes?: string[] }).__writes ?? [])).toEqual(['vitepress-theme-appearance']);
      expect(await page.evaluate(() => localStorage.getItem('vitepress-theme-appearance'))).toBe('dark');
      expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
      await context.close();
    });
  });
});

test.describe('assert_landing_csp_strict', () => {
  test('depuis la doc, le lien du titre recharge la landing en entier : sa CSP s\'applique et elle n\'écrit rien avant une action ; Précédent ramène la doc', async () => {
    await withBrowser(async (browser) => {
      const context = await browser.newContext();
      await context.addInitScript(() => {
        const scope = globalThis as unknown as { __writes: string[] };
        scope.__writes = [];
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function patched(key: string, value: string): void {
          scope.__writes.push(key);
          original.call(this, key, value);
        };
      });
      const page = await context.newPage();
      const violations: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') violations.push(message.text());
      });
      await page.goto(`${preprodUrl()}/tutoriels/quickstart`, { waitUntil: 'networkidle' });
      await page.evaluate(() => {
        (globalThis as unknown as { __docMarker: boolean }).__docMarker = true;
      });
      await Promise.all([page.waitForURL(homeUrl('en')), page.locator('.VPNavBarTitle a').first().click()]);
      await page.waitForLoadState('networkidle');
      // Chargement complet : le marqueur posé sur la page de doc a disparu avec elle.
      expect(await page.evaluate(() => (globalThis as unknown as { __docMarker?: boolean }).__docMarker ?? false)).toBe(false);
      expect(await page.evaluate(() => document.head.firstElementChild?.getAttribute('http-equiv'))).toBe('Content-Security-Policy');
      expect(await page.evaluate(() => (globalThis as unknown as { __writes: string[] }).__writes)).toEqual([]);
      expect(await page.locator('.lp-theme').count()).toBeGreaterThan(0);
      await page.goBack();
      await page.waitForURL(/\/tutoriels\/quickstart$/);
      await page.waitForLoadState('networkidle');
      expect(await page.locator('.VPDoc').count()).toBeGreaterThan(0);
      expect(violations).toEqual([]);
      await context.close();
    });
  });

  test('la balise CSP est la première du head, avant tout script, et sa forme est exacte', () => {
    for (const probe of probes) {
      const head = probe.html.slice(probe.html.indexOf('<head>'));
      expect(head.replace(/^<head>\s*/, '').startsWith('<meta http-equiv="Content-Security-Policy"'), label(probe)).toBe(true);
      expect(probe.html.indexOf('Content-Security-Policy'), label(probe)).toBeLessThan(probe.html.indexOf('<script'));
      expect(probe.html.indexOf('<meta charset'), `${label(probe)} : charset dans les 1024 premiers octets`).toBeLessThan(1024);
      const csp = probe.cspMeta ?? '';
      for (const directive of ["default-src 'none'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'", "connect-src 'self'", "base-uri 'none'", "form-action 'none'"]) expect(csp, label(probe)).toContain(directive);
      expect(csp, label(probe)).toMatch(/script-src 'self'( 'sha256-[A-Za-z0-9+/]{43}=')+;/);
      expect(csp, label(probe)).not.toMatch(/unsafe-inline|unsafe-eval|frame-ancestors/);
    }
  });

  test('0 violation de CSP, aucune erreur de console, aucun attribut style dans le HTML', () => {
    for (const probe of probes) {
      expect(probe.cspViolations, label(probe)).toEqual([]);
      expect(probe.consoleErrors, label(probe)).toEqual([]);
      expect(probe.html, label(probe)).not.toMatch(/\sstyle="/);
    }
  });
});
