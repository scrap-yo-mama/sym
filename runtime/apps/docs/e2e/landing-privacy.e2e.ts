// SPDX-License-Identifier: AGPL-3.0-only
// Gates de la landing « sans inscription, sans tiers, sans cookie » et « CSP » (22b § 2), jouées sur la préproduction (build de
// production servi comme GitHub Pages, sans en-têtes) :
// - assert_landing_no_signup : 0 formulaire, 0 champ de saisie, CSP `form-action 'none'` ;
// - assert_landing_no_third_party_request : 100 % des requêtes vont vers l'origine de la page (liste d'autorisation vide) ;
// - assert_landing_no_third_party_tracker : aucun domaine de traceur demandé ni référencé dans le HTML ;
// - assert_landing_no_cookie : document.cookie vide, aucun Set-Cookie, aucune écriture de stockage avant une action explicite ;
// - assert_landing_csp_strict : la balise CSP précède tout script, 0 violation, aucun attribut style, forme exacte de la politique.
import { expect, test } from '@playwright/test';
import { withBrowser, probePages, type PageProbe } from '../src/landing/probe.ts';
import { HOST_INJECTIONS, TRACKER_DOMAINS } from '../src/landing/trackers.ts';
import { allLandingUrls, homeUrl } from './pages.ts';

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
