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
// robots.txt (1.11, INV11) à CHAQUE saut (`checkRequest`) : `context.route` ne voit que la première URL d'une chaîne de
// redirections ; chaque requête que Chromium s'apprête à envoyer, saut compris, passe par le contrôle CDP de
// `request-guard.ts` (page du run et cadres hors processus) ; la poignée de main d'un WebSocket aussi. Les requêtes d'une
// autre page du contexte (fenêtre surgissante, fermée aussitôt) sont coupées : elles échapperaient à ce contrôle.
// SharedWorker (revue de 1.11) : ses requêtes échappent à `context.route` ET au contrôle CDP de la page ; chacun est fermé
// avant d'exécuter son code (`blockSharedWorkers`, session CDP du navigateur), dans tous les modes, contrôle robots ou non.
// Workers dédiés (revue de 1.11) : `routeWebSocket` ne voit pas leurs WebSocket ; le contrôle CDP pose sur le script de
// tout worker http(s) une CSP sans WebSocket (request-guard.ts), et la garde des documents (`installPageGuard`,
// page-guard.ts) refuse les workers blob: et data: ; WebSocketStream, que `routeWebSocket` ne voit pas non plus, est coupé
// au lancement (launch.ts).
// Règles de spéculation (revue de 1.11) : leur préchargement part du navigateur, hors de toute interception ; la garde des
// documents les retire, le contrôle CDP coupe celles de l'en-tête `Speculation-Rules`, le prérendu est coupé au lancement.
// Garde OBLIGATOIRE (correctif fix-inv11-agent) : `checkRequest` est exigé par le type et toute la garde ci-dessus est posée
// sans condition, pour TOUT contexte Chromium d'un run — E1-E3 et E4 par le navigateur et les rejeux E5 (pool), comme le
// Chromium dédié des essais agentiques E5-E6 piloté par Stagehand (`dedicated`, agent-browser.ts). Ce module est le seul à
// créer un contexte ou une page de run (`newContext`, `newPage`) : `assert_all_browser_contexts_guarded`
// (browser/guarded-contexts.unit.test.ts) échoue sur tout autre appel du code du worker et du paquet agent.
import { browserUserAgent } from '@runtime/core/access';
import type { APIRequest, APIRequestContext, Browser, BrowserContext, Page, Request } from 'playwright-core';
import { installPageGuard } from './page-guard.js';
import { blockSharedWorkers, installRequestGuard, type RequestCheck } from './request-guard.js';

export type { BrowserRequestCheck } from './request-guard.js';

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
  /** Requête d'un domaine autorisé : `false` la coupe (cadence refusée, plafond atteint, robots.txt, action d'écriture). */
  readonly admit?: (request: Request) => Promise<boolean>;
  /**
   * Contrôle de CHAQUE requête http(s) d'un domaine de l'API que Chromium envoie, sauts de redirection compris, et de la
   * poignée de main de chaque WebSocket (robots.txt, 1.11) : `false` la coupe avant toute connexion.
   */
  readonly checkRequest: RequestCheck;
  /**
   * User-Agent du robot (`buildUserAgent`, tâche 1.11) : ajouté APRÈS celui du navigateur, qui reste tel qu'il est
   * (aucun masquage, X2, 17 §5).
   */
  readonly userAgent?: string;
  /**
   * Chromium DÉDIÉ d'un essai agentique (agent-browser.ts : lancé pour l'essai seul, derrière le proxy d'egress de l'essai,
   * piloté aussi par Stagehand) : son unique contexte (contexte par défaut) est celui du run et sa page initiale la page
   * du run ; proxy, profil et service workers relèvent du lancement. Même garde qu'un contexte neuf (routes, WebSocket,
   * SharedWorker, garde des documents, contrôle CDP de chaque requête). Une requête admise ici retombe sur les routes
   * posées avant (`route.fallback` : verrou de domaines et écritures de l'agent, cadence). Le contexte n'est pas fermé
   * ici : le navigateur l'est par son propriétaire, AVANT `close()` (qui ne détache alors que le blocage des SharedWorker).
   */
  readonly dedicated?: boolean;
};

/** User-Agent propre du navigateur (CDP `Browser.getVersion`) ; vide s'il est illisible. */
async function ownUserAgent(browser: Browser): Promise<string> {
  try {
    const session = await browser.newBrowserCDPSession();
    try {
      const version = (await session.send('Browser.getVersion')) as { userAgent?: unknown };
      return typeof version.userAgent === 'string' ? version.userAgent : '';
    } finally {
      await session.detach().catch(() => undefined);
    }
  } catch {
    return '';
  }
}

export type RunContext = {
  readonly context: BrowserContext;
  readonly page: Page;
  /** Requêtes coupées par la politique de domaines (hôte seulement, jamais l'URL complète). */
  readonly violations: readonly string[];
  close(): Promise<void>;
};

/** URL http(s) de la poignée de main d'un WebSocket (ws → http, wss → https) ; `undefined` si illisible. */
function websocketHandshakeUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

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
  // Échec fermé : sans contrôle de chaque requête, aucun contexte de run (appel non typé compris), rien n'est ouvert.
  if (typeof options.checkRequest !== 'function') throw new Error('contexte de run sans contrôle robots.txt (INV11) : refusé');
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
  const userAgent = options.userAgent === undefined ? undefined : browserUserAgent(await ownUserAgent(browser), options.userAgent);
  const dedicated = options.dedicated === true;
  // Posé avant le contexte : aucun SharedWorker de ce contexte ne peut naître avant lui (échec fermé s'il ne peut pas l'être).
  const sharedWorkers = await blockSharedWorkers(browser);
  let context: BrowserContext;
  try {
    if (dedicated) {
      // Chromium dédié : un seul contexte, le sien (la garde CDP du navigateur et celle-ci valent pour tout le navigateur).
      const contexts = browser.contexts();
      if (contexts.length !== 1) throw new Error(`contexte de run dédié : un seul contexte attendu (ouverts : ${contexts.length})`);
      context = contexts[0]!;
    } else {
      context = await browser.newContext({
        ...(userAgent === undefined ? {} : { userAgent }),
        proxy: { server: options.egressServer },
        serviceWorkers: 'block',
        acceptDownloads: false,
        ignoreHTTPSErrors: false,
        bypassCSP: false,
      });
    }
  } catch (error) {
    await sharedWorkers.close();
    throw error;
  }
  // Contexte fermé d'abord : détachée avant, la session laisserait repartir un SharedWorker resté suspendu.
  const closeAll = async () => {
    if (!dedicated) await context.close().catch(() => undefined);
    await sharedWorkers.close();
  };
  /** Page du run, connue une fois créée : toute requête d'une autre page du contexte est coupée. */
  let runPage: Page | undefined;
  try {
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      let foreign = false;
      try {
        foreign = runPage !== undefined && route.request().frame().page() !== runPage;
      } catch {
        // Requête sans cadre (service worker, bloqués) : traitée comme les autres.
      }
      if (foreign) {
        await route.abort('blockedbyclient');
        return;
      }
      if (hostAllowed(url, options.allowedHosts)) {
        const admitted = options.admit === undefined ? true : await options.admit(route.request()).catch(() => false);
        // Retombée sur les routes posées avant celle-ci (aucune sur un contexte neuf : la requête part).
        if (admitted) await route.fallback();
        else await route.abort('blockedbyclient');
      } else {
        note(url, route.request());
        await route.abort('blockedbyclient');
      }
    });
    await context.routeWebSocket(/.*/, async (ws) => {
      if (!hostAllowed(ws.url(), options.allowedHosts)) {
        note(ws.url());
        await ws.close({ code: 1008, reason: 'domain_not_allowed' });
        return;
      }
      // Poignée de main = GET http sur le chemin : robots.txt d'abord (1.11).
      const handshake = websocketHandshakeUrl(ws.url());
      const allowed =
        handshake !== undefined && (await options.checkRequest({ url: handshake, redirect: false, rootUrl: handshake, resourceType: 'WebSocket', mainFrame: false }).catch(() => false));
      if (!allowed) {
        await ws.close({ code: 1008, reason: 'robots_disallowed' });
        return;
      }
      ws.connectToServer();
    });
    // Garde des documents (workers blob:/data:, règles de spéculation), avant la création de la page.
    await installPageGuard(context);
    // Chromium dédié : sa page initiale (about:blank, rien chargé) devient la page du run ; toute autre est fermée.
    const page = dedicated ? (context.pages()[0] ?? (await context.newPage())) : await context.newPage();
    runPage = page;
    // La session du contrôle n'est jamais détachée avant la fermeture du contexte : détachée, elle laisserait repartir
    // les requêtes encore suspendues.
    await installRequestGuard(context, page, (url) => hostAllowed(url, options.allowedHosts), options.checkRequest);
    context.on('page', (other) => {
      if (other !== page) void other.close().catch(() => undefined);
    });
    for (const other of context.pages()) if (other !== page) await other.close().catch(() => undefined);
    return { context, page, violations, close: closeAll };
  } catch (error) {
    await closeAll();
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
