// SPDX-License-Identifier: AGPL-3.0-only
// Contexte Chromium d'un run (tâche 1.6 ; 08 §3-4 ; 08b §1) : contexte NEUF par run, jamais partagé entre propriétaires,
// sans profil persistant. Première couche : le proxy d'egress de l'essai (`proxy` du contexte, garde SSRF, barreau
// réseau). Seconde couche : `context.route('**')` et `routeWebSocket` (politique de domaines de l'API, violation
// journalisée), `serviceWorkers: 'block'`, aucun téléchargement. Un `APIRequestContext` ne passe PAS par Chromium : il
// reçoit toujours le proxy d'egress (`newEgressRequestContext`), jamais une connexion directe.
import type { APIRequest, APIRequestContext, Browser, BrowserContext, Page } from 'playwright-core';

export type RunContextOptions = {
  /** `BrowserEgress.server` de l'essai (http://127.0.0.1:PORT). */
  readonly egressServer: string;
  /** Domaines de l'API (`allowed_hosts`) : toute autre requête du navigateur est coupée. */
  readonly allowedHosts: readonly string[];
};

export type RunContext = {
  readonly context: BrowserContext;
  readonly page: Page;
  /** Requêtes coupées par la politique de domaines (hôte seulement, jamais l'URL complète). */
  readonly violations: readonly string[];
  close(): Promise<void>;
};

/** Nom d'hôte autorisé : égal à un domaine de l'API (comparaison exacte, minuscules, sans point final). */
export function hostAllowed(url: string, allowedHosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== '') return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return allowedHosts.some((h) => h.toLowerCase() === host);
}

export async function openRunContext(browser: Browser, options: RunContextOptions): Promise<RunContext> {
  const violations: string[] = [];
  const note = (url: string) => {
    let host = '?';
    try {
      host = new URL(url).hostname;
    } catch {
      // URL illisible : seul « ? » est noté.
    }
    if (violations.length < 100) violations.push(host);
  };
  const context = await browser.newContext({
    proxy: { server: options.egressServer },
    serviceWorkers: 'block',
    acceptDownloads: false,
    ignoreHTTPSErrors: false,
    bypassCSP: false,
  });
  try {
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (hostAllowed(url, options.allowedHosts)) await route.continue();
      else {
        note(url);
        await route.abort('blockedbyclient');
      }
    });
    await context.routeWebSocket(/.*/, (ws) => {
      if (hostAllowed(ws.url(), options.allowedHosts)) ws.connectToServer();
      else {
        note(ws.url());
        void ws.close({ code: 1008, reason: 'domain_not_allowed' });
      }
    });
    const page = await context.newPage();
    return { context, page, violations, close: () => context.close().catch(() => undefined) };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Seule façon de créer un `APIRequestContext` hors d'un contexte de navigateur : le proxy d'egress de l'essai est
 * imposé (sans lui, Playwright se connecterait directement depuis Node, hors garde SSRF).
 */
export function newEgressRequestContext(request: APIRequest, egressServer: string): Promise<APIRequestContext> {
  return request.newContext({ proxy: { server: egressServer }, ignoreHTTPSErrors: false });
}
