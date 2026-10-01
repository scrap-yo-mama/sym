// SPDX-License-Identifier: AGPL-3.0-only
// Contexte Chromium d'un run (tâche 1.6 ; 08 §3-4 ; 08b §1) : contexte NEUF par run, jamais partagé entre propriétaires,
// sans profil persistant. Première couche : le proxy d'egress de l'essai (`proxy` du contexte, garde SSRF, barreau
// réseau). Seconde couche : `context.route('**')` et `routeWebSocket` (politique de domaines de l'API, violation
// journalisée), `serviceWorkers: 'block'`, aucun téléchargement, aucune fenêtre surgissante (fermée aussitôt : un code
// injecté n'y survit pas à une navigation de la page du run). Un `APIRequestContext` ne passe PAS par Chromium : il
// reçoit toujours le proxy d'egress (`newEgressRequestContext`), jamais une connexion directe.
// Requêtes de la stratégie (`trackStrategyRequests`) : seule leur coupure par le verrou de domaines est une faute de
// stratégie ; les sous-ressources tierces du site coupées ne changent jamais la classe d'un échec.
// Contrôle optionnel des requêtes autorisées (`admit`, E3 en script) : cadence par domaine (1.9), plafond
// `max_requests_per_run`, actions d'écriture (`allow_write_actions`) ; un refus coupe la requête sans connexion.
import type { APIRequest, APIRequestContext, Browser, BrowserContext, Page, Request } from 'playwright-core';

export type RunContextOptions = {
  /** `BrowserEgress.server` de l'essai (http://127.0.0.1:PORT). */
  readonly egressServer: string;
  /** Domaines de l'API (`allowed_hosts`) : toute autre requête du navigateur est coupée. */
  readonly allowedHosts: readonly string[];
  /**
   * Requête coupée par la politique de domaines (hôte seulement ; la requête Chromium quand il y en a une, absente pour
   * un WebSocket) : E3 en script tue alors l'enfant du bac à sable si la requête lui est imputable.
   */
  readonly onViolation?: (host: string, request?: Request) => void;
  /** Requête d'un domaine autorisé : `false` la coupe (cadence refusée, plafond atteint, action d'écriture). */
  readonly admit?: (request: Request) => Promise<boolean>;
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
  const note = (url: string, request?: Request) => {
    let host = '?';
    try {
      host = new URL(url).hostname;
    } catch {
      // URL illisible : seul « ? » est noté.
    }
    if (violations.length < 100) violations.push(host);
    options.onViolation?.(host, request);
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
      if (hostAllowed(url, options.allowedHosts)) {
        const admitted = options.admit === undefined ? true : await options.admit(route.request()).catch(() => false);
        if (admitted) await route.continue();
        else await route.abort('blockedbyclient');
      } else {
        note(url, route.request());
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
    context.on('page', (other) => {
      if (other !== page) void other.close().catch(() => undefined);
    });
    return { context, page, violations, close: () => context.close().catch(() => undefined) };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

/** Navigation du cadre principal de `page` (requête de document). */
export const isMainNavigation =
  (page: Page) =>
  (request: Request): boolean =>
    request.isNavigationRequest() && request.frame() === page.mainFrame();

/** Requête initiale d'une chaîne de redirections. */
export function chainRoot(request: Request): Request {
  let current = request;
  for (let hop = 0; hop < 50; hop++) {
    const previous = current.redirectedFrom();
    if (previous === null) return current;
    current = previous;
  }
  return current;
}

/**
 * Requêtes de la stratégie elle-même (navigation qu'elle demande, `fetch` qu'elle lance dans la page), suivies à travers
 * leurs sauts de redirection. Seule une de ces requêtes (ou l'un de ses sauts) dirigée hors des domaines de l'API est
 * une faute de stratégie (`domain_not_allowed`, 04 §7) ; une sous-ressource du site coupée (pixel, mesure d'audience,
 * CDN, redirection d'une image vers un tiers) n'en est jamais une et ne change pas la classe d'un échec.
 */
export type StrategyRequests = {
  /** Pendant `fn`, toute requête initiale (hors saut de redirection) qui satisfait `match` est une requête de la stratégie. */
  during<T>(match: (request: Request) => boolean, fn: () => Promise<T>): Promise<T>;
  /** Vrai si une requête de la stratégie, ou l'un de ses sauts, visait un hôte hors des domaines de l'API. */
  cut(): boolean;
  /** Vrai si la chaîne de `request` part d'une requête de la stratégie (à lire après l'écouteur `request` de ce suivi). */
  owns(request: Request): boolean;
};

export function trackStrategyRequests(context: BrowserContext, allowedHosts: readonly string[]): StrategyRequests {
  const matchers = new Set<(request: Request) => boolean>();
  const roots = new WeakSet<Request>();
  let cut = false;
  context.on('request', (request) => {
    const root = chainRoot(request);
    if (root === request && matchers.size > 0) {
      for (const match of matchers) {
        let matched = false;
        try {
          matched = match(request);
        } catch {
          // Requête sans cadre (service worker, bloqués) : jamais celle de la stratégie.
        }
        if (matched) {
          roots.add(request);
          break;
        }
      }
    }
    if (roots.has(root) && !hostAllowed(request.url(), allowedHosts)) cut = true;
  });
  return {
    during: async (match, fn) => {
      matchers.add(match);
      try {
        return await fn();
      } finally {
        matchers.delete(match);
      }
    },
    cut: () => cut,
    owns: (request) => roots.has(chainRoot(request)),
  };
}

/**
 * Seule façon de créer un `APIRequestContext` hors d'un contexte de navigateur : le proxy d'egress de l'essai est
 * imposé (sans lui, Playwright se connecterait directement depuis Node, hors garde SSRF).
 */
export function newEgressRequestContext(request: APIRequest, egressServer: string): Promise<APIRequestContext> {
  return request.newContext({ proxy: { server: egressServer }, ignoreHTTPSErrors: false });
}
