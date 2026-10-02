// SPDX-License-Identifier: AGPL-3.0-only
// Sonde de la landing (22b § 2 et § 5) : charge chaque page dans Chromium, joue le parcours d'un visiteur (défilement, ouverture
// de la transcription, pause de la démo, copie de la commande) et relève ce que le navigateur a vu : requêtes, cookies, stockage,
// violations de CSP, erreurs de console. Une seule implémentation pour les tests E2E (préproduction : build servi comme GitHub
// Pages, sans déploiement), la sonde de production hebdomadaire et le contrôle avant le GO (scripts/vitrine/landing-probe.ts).
// Aucune écriture, aucun envoi : la sonde ne fait que lire une page.
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { HOST_INJECTIONS, TRACKER_DOMAINS } from './trackers.ts';

export type PageProbe = {
  url: string;
  /** Requêtes réseau de la page, toutes ressources comprises (hors `data:` et `blob:`). */
  requests: string[];
  /** Requêtes vers une autre origine que celle de la page. */
  thirdPartyRequests: string[];
  /** Requêtes vers un domaine de la liste des traceurs ou un chemin injecté par un hébergeur. */
  trackerRequests: string[];
  documentCookie: string;
  contextCookies: string[];
  /** En-têtes `Set-Cookie` reçus. */
  setCookieHeaders: string[];
  /** Écritures de stockage local ou de session, avec la clé : doivent être vides avant une action explicite. */
  storageWritesBeforeAction: string[];
  /**
   * Ce que le navigateur garde après le chargement, avant le premier geste, quelle que soit la façon d'écrire : clés du stockage local
   * et de session (une affectation directe `localStorage.k = v` échappe à setItem), bases IndexedDB, caches de l'API Cache,
   * service workers enregistrés. Doit être vide.
   */
  storageAfterLoad: string[];
  cspViolations: string[];
  consoleErrors: string[];
  /** Balise CSP vue dans le DOM, pour le contrôle de forme. */
  cspMeta: string | null;
  formCount: number;
  /** HTML source de la page (réponse du serveur), pour chercher un traceur référencé. */
  html: string;
};

export type ProbeOptions = { headless?: boolean; viewport?: { width: number; height: number }; reducedMotion?: 'reduce' | 'no-preference' };

type Scope = { __zzStorage?: (entry: string) => void; __zzViolation?: (entry: string) => void; localStorage: Storage; sessionStorage: Storage; document: Document };

async function instrument(context: BrowserContext, sinks: { storage: string[]; violations: string[] }): Promise<void> {
  await context.exposeBinding('__zzStorage', (_source, entry: string) => void sinks.storage.push(entry));
  await context.exposeBinding('__zzViolation', (_source, entry: string) => void sinks.violations.push(entry));
  await context.addInitScript(() => {
    const scope = globalThis as unknown as Scope;
    for (const name of ['localStorage', 'sessionStorage'] as const) {
      const storage = scope[name];
      const proto = Object.getPrototypeOf(storage) as Storage;
      const original = proto.setItem;
      proto.setItem = function patched(this: Storage, key: string, value: string): void {
        scope.__zzStorage?.(`${this === scope.localStorage ? 'localStorage' : 'sessionStorage'}.setItem(${key})`);
        original.call(this, key, value);
      };
    }
    scope.document.addEventListener('securitypolicyviolation', (event: Event) => {
      const e = event as unknown as { violatedDirective: string; blockedURI: string; sample: string };
      scope.__zzViolation?.(`${e.violatedDirective} : ${e.blockedURI || e.sample || 'inline'}`);
    });
  });
}

/** Inventaire du stockage de la page, toutes API confondues (stockage local et de session, IndexedDB, Cache, service workers). */
async function snapshotStorage(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const found: string[] = [];
    for (const name of ['localStorage', 'sessionStorage'] as const) {
      try {
        for (const key of Object.keys(window[name])) found.push(`${name}.${key}`);
      } catch {
        found.push(`${name} : illisible`);
      }
    }
    if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') for (const db of await indexedDB.databases()) found.push(`indexedDB:${db.name ?? '?'}`);
    if (typeof caches !== 'undefined') for (const key of await caches.keys()) found.push(`caches:${key}`);
    if (typeof navigator.serviceWorker !== 'undefined') for (const registration of await navigator.serviceWorker.getRegistrations()) found.push(`serviceWorker:${registration.scope}`);
    return found;
  });
}

const isTracker = (url: string): boolean => TRACKER_DOMAINS.some((domain) => url.includes(domain)) || HOST_INJECTIONS.some((path) => url.includes(path));

/** Parcours d'un visiteur : défilement, transcription, pause de la démo, copie de la commande. Chaque geste est facultatif sur une page juridique. */
async function visit(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = 600;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    window.scrollTo(0, 0);
  });
  const summary = page.locator('.lp-transcript summary');
  if ((await summary.count()) > 0) await summary.click();
  const pause = page.locator('.lp-demo-controls button').first();
  if ((await pause.count()) > 0) await pause.click();
  const copy = page.locator('.lp-command .lp-btn');
  if ((await copy.count()) > 0) await copy.click();
}

export async function probePages(browser: Browser, urls: readonly string[], options: ProbeOptions = {}): Promise<PageProbe[]> {
  const results: PageProbe[] = [];
  for (const url of urls) {
    const origin = new URL(url).origin;
    const context = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 900 }, reducedMotion: options.reducedMotion ?? 'no-preference', permissions: [] });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin }).catch(() => undefined);
    const sinks = { storage: [] as string[], violations: [] as string[] };
    await instrument(context, sinks);
    const requests: string[] = [];
    const setCookies: string[] = [];
    const consoleErrors: string[] = [];
    context.on('request', (request) => {
      if (!/^(data|blob):/.test(request.url())) requests.push(request.url());
    });
    context.on('response', async (response) => {
      const header = await response.headerValue('set-cookie').catch(() => null);
      if (header) setCookies.push(`${response.url()} : ${header}`);
    });
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    const response = await page.goto(url, { waitUntil: 'networkidle' });
    const html = (await response?.text()) ?? '';
    // Aucune écriture de stockage n'a eu lieu avant le premier geste : on la relève ici, puis on joue le parcours.
    const storageWritesBeforeAction = [...sinks.storage];
    const storageAfterLoad = await snapshotStorage(page);
    const loaded = {
      documentCookie: await page.evaluate(() => document.cookie),
      formCount: await page.locator('form, input').count(),
      cspMeta: await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? null),
    };
    await visit(page);
    await page.waitForLoadState('networkidle');
    results.push({
      url,
      requests,
      thirdPartyRequests: requests.filter((request) => new URL(request).origin !== origin),
      trackerRequests: requests.filter(isTracker),
      documentCookie: loaded.documentCookie,
      contextCookies: (await context.cookies()).map((cookie) => cookie.name),
      setCookieHeaders: setCookies,
      storageWritesBeforeAction,
      storageAfterLoad,
      cspViolations: sinks.violations,
      consoleErrors,
      cspMeta: loaded.cspMeta,
      formCount: loaded.formCount,
      html,
    });
    await context.close();
  }
  return results;
}

export async function withBrowser<T>(run: (browser: Browser) => Promise<T>, options: ProbeOptions = {}): Promise<T> {
  const browser = await chromium.launch({ headless: options.headless ?? true });
  try {
    return await run(browser);
  } finally {
    await browser.close();
  }
}
