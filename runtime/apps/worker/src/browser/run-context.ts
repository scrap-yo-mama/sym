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
// Verrou de domaines à CHAQUE saut : `context.route` ne voit que la première URL d'une chaîne de redirections ; chaque
// requête que Chromium s'apprête à envoyer, saut compris, passe par le contrôle CDP de `request-guard.ts` (page du run et
// cadres hors processus), avec le contrôle optionnel de l'appelant (`checkRequest` : relevé des écritures de l'agent) ;
// la poignée de main d'un WebSocket aussi. Les requêtes d'une
// autre page du contexte (fenêtre surgissante, fermée aussitôt) sont coupées : elles échapperaient à ce contrôle.
// SharedWorker et service workers (revues de 1.11 et de fix-inv11-agent, F-20261001-07) : leurs requêtes échappent à
// `context.route` ET au contrôle CDP de la page, et `serviceWorkers: 'block'` ne couvre pas
// `ServiceWorkerContainer.prototype.register`. Une interception CDP au niveau du NAVIGATEUR, posée avant le contexte, coupe
// toute requête de leurs cibles (script principal d'un service worker compris : il n'est jamais enregistré) et les ferme
// (`blockBackgroundWorkers`, request-guard.ts) ; la garde des documents fige `register` (prototype et instance) et refuse
// les SharedWorker blob: et data:. Dans tous les modes.
// Workers dédiés (revue de 1.11) : `routeWebSocket` ne voit pas leurs WebSocket ; le contrôle CDP pose sur le script de
// tout worker http(s) une CSP sans WebSocket (request-guard.ts), et la garde des documents (`installPageGuard`,
// page-guard.ts) refuse les workers blob: et data: ; WebSocketStream, que `routeWebSocket` ne voit pas non plus, est coupé
// au lancement (launch.ts).
// Règles de spéculation (revue de 1.11) : leur préchargement part du navigateur, hors de toute interception ; la garde des
// documents les retire, le contrôle CDP coupe celles de l'en-tête `Speculation-Rules`, le prérendu est coupé au lancement.
// Garde OBLIGATOIRE (correctif fix-inv11-agent) : toute la garde ci-dessus est posée sans condition, pour TOUT contexte
// Chromium d'un run — E1-E3 et E4 par le navigateur et les rejeux E5 (pool), comme le
// Chromium dédié des essais agentiques E5-E6 piloté par Stagehand (`dedicated`, agent-browser.ts). Ce module est le seul à
// créer un contexte ou une page de run (`newContext`, `newPage`) : `assert_all_browser_contexts_guarded`
// (browser/guarded-contexts.unit.test.ts) échoue sur tout autre appel du code du worker et du paquet agent.
import { buildUserAgent } from '@runtime/core/access';
import type { StaticAssetAllowance } from '@runtime/core/net';
import type { APIRequest, APIRequestContext, Browser, BrowserContext, Page, Request } from 'playwright-core';
import { browserEngineIdentity } from './engine-identity.js';
import { installPageGuard } from './page-guard.js';
import { blockBackgroundWorkers, installRequestGuard, type RequestCheck } from './request-guard.js';
import { engineUserAgentMetadata, installUserAgentOverride, NO_MEDIA_EMULATION } from './user-agent-override.js';

export type RunContextOptions = {
  /** `BrowserEgress.server` de l'essai (http://127.0.0.1:PORT). */
  readonly egressServer: string;
  /** Domaines de l'API (`allowed_hosts`) : toute autre requête du navigateur est coupée. */
  readonly allowedHosts: readonly string[];
  /** Portées de site admises en plus (domaine et sous-domaines) : reconnaissance de l'enquête seulement (2.1, 04b §2). */
  readonly allowedHostSuffixes?: readonly string[];
  /**
   * Sous-ressources statiques (script, feuille de style, police, préchargement ; GET) d'hôtes TIERS admises, bornées : reconnaissance de l'enquête
   * seulement (banc R05, application rendue en JavaScript servie par un CDN). Le même objet est passé au proxy d'egress de
   * la passe. Toute autre requête vers un tiers reste coupée.
   */
  readonly staticAssets?: Pick<StaticAssetAllowance, 'admit'>;
  /**
   * Requête coupée par la politique de domaines (hôte seulement ; la requête Chromium quand il y en a une, absente pour
   * un WebSocket) : E3 en script tue alors l'enfant du bac à sable si la requête lui est imputable.
   */
  readonly onViolation?: (host: string, request?: Request) => void;
  /** Requête d'un domaine autorisé : `false` la coupe (cadence refusée, plafond atteint, action d'écriture). */
  readonly admit?: (request: Request) => Promise<boolean>;
  /**
   * Contrôle optionnel de CHAQUE requête http(s) d'un domaine de l'API que Chromium envoie, sauts de redirection compris,
   * et de la poignée de main de chaque WebSocket : `false` la coupe avant toute connexion. Absent : tout est admis (le
   * verrou de domaines, lui, s'applique toujours).
   */
  readonly checkRequest?: RequestCheck;
  /**
   * User-Agent du robot de ce run (`buildUserAgent`, tâche 1.11, 17 §5) : la chaîne du moteur, avec le jeton si
   * `identify_instance` est activé ; sans elle, la chaîne exacte du moteur de `browser.version()`. Posée par
   * `installUserAgentOverride` avec les indices clients RÉELS du moteur (jamais l'option `userAgent` de Playwright, qui
   * en déduirait de faux de la chaîne). Jamais une autre version ni un autre navigateur, aucune rotation.
   * Refusé avec `dedicated` : le User-Agent d'un Chromium dédié relève de son lancement (`--user-agent`).
   */
  readonly userAgent?: string;
  /**
   * Chromium DÉDIÉ d'un essai agentique (agent-browser.ts : lancé pour l'essai seul, derrière le proxy d'egress de l'essai,
   * piloté aussi par Stagehand) : son unique contexte (contexte par défaut) est celui du run et sa page initiale la page
   * du run ; proxy et profil relèvent du lancement. Même garde qu'un contexte neuf (routes, WebSocket, SharedWorker et
   * service workers coupés au niveau du navigateur, garde des documents, contrôle CDP de chaque requête). Une requête
   * admise ici retombe sur les routes posées avant (`route.fallback` : verrou de domaines et écritures de l'agent,
   * cadence). Le contexte n'est pas fermé
   * ici : le navigateur l'est par son propriétaire, AVANT `close()` (qui ne détache alors que le blocage des workers
   * d'arrière-plan).
   * Coupures hors domaines (comptage, `agent_domain_blocked`) : la route de ce module, posée en dernier, est consultée la
   * première et COUPE elle-même une requête initiale ou un WebSocket hors domaines (`violations`) ; une requête coupée
   * en route n'atteint jamais une interception CDP au niveau du navigateur (consultée après les routes, constaté sur
   * Chromium 153), ni le proxy d'egress. Le verrou de l'agent (`installDomainGuard`) ne compte donc que ce qui passe la
   * route : les sauts de redirection hors domaines, vus par son interception CDP du navigateur. Chaque coupure est comptée
   * par une seule couche : `violations` + `guard.blocked` (motif `domain`) + proxy d'egress, sans double compte.
   */
  readonly dedicated?: boolean;
};

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

/**
 * Nom d'hôte autorisé : égal à un domaine de l'API (comparaison exacte, minuscules, sans point final), ou dans une portée
 * de site posée par le code (`suffixes` : le domaine et ses sous-domaines ; jamais tirée d'une stratégie).
 */
export function hostAllowed(url: string, allowedHosts: readonly string[], suffixes: readonly string[] = []): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== '') return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return allowedHosts.some((h) => h.toLowerCase() === host) || suffixes.some((s) => host === s.toLowerCase() || host.endsWith(`.${s.toLowerCase()}`));
}

export async function openRunContext(browser: Browser, options: RunContextOptions): Promise<RunContext> {
  const checkRequest: RequestCheck = options.checkRequest ?? (async () => true);
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
  const dedicated = options.dedicated === true;
  // Chromium dédié : son User-Agent relève du lancement (aucun contexte n'est créé ici) ; un userAgent serait ignoré.
  if (dedicated && options.userAgent !== undefined) throw new Error('contexte de run dédié : userAgent refusé (il relève du lancement du Chromium dédié)');
  const userAgent = options.userAgent ?? buildUserAgent({ engine: browserEngineIdentity(browser) });
  // Indices clients réels du moteur (contexte vierge, une fois par navigateur), avant le contexte du run (rien en mode dédié).
  const metadata = dedicated ? undefined : await engineUserAgentMetadata(browser);
  // Posé avant le contexte : aucun worker d'arrière-plan de ce contexte ne peut naître avant lui (échec fermé s'il ne peut
  // pas l'être).
  const backgroundWorkers = await blockBackgroundWorkers(browser);
  let context: BrowserContext;
  try {
    if (dedicated) {
      // Chromium dédié : un seul contexte, le sien (la garde CDP du navigateur et celle-ci valent pour tout le navigateur).
      const contexts = browser.contexts();
      if (contexts.length !== 1) throw new Error(`contexte de run dédié : un seul contexte attendu (ouverts : ${contexts.length})`);
      context = contexts[0]!;
    } else {
      context = await browser.newContext({
        ...NO_MEDIA_EMULATION,
        proxy: { server: options.egressServer },
        serviceWorkers: 'block',
        acceptDownloads: false,
        ignoreHTTPSErrors: false,
        bypassCSP: false,
      });
    }
  } catch (error) {
    await backgroundWorkers.close();
    throw error;
  }
  // Contexte fermé d'abord : détachée avant, la session lèverait l'interception des workers d'arrière-plan encore vivants.
  const closeAll = async () => {
    if (!dedicated) await context.close().catch(() => undefined);
    await backgroundWorkers.close();
  };
  /** Page du run, connue une fois créée : toute requête d'une autre page du contexte est coupée. */
  let runPage: Page | undefined;
  try {
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      let foreign: boolean;
      try {
        foreign = runPage !== undefined && route.request().frame().page() !== runPage;
      } catch {
        // Requête sans cadre. Navigation : celle d'une fenêtre ouverte par la page (`window.open`, lien `target=_blank`),
        // émise avant que Playwright ne connaisse son cadre ; elle partirait avec le User-Agent par défaut du moteur
        // (`HeadlessChrome`, sans la surcharge de la page du run), elle est coupée comme toute requête d'une autre page.
        // Sinon (service worker, bloqués) : traitée comme les autres.
        foreign = runPage !== undefined && route.request().isNavigationRequest();
      }
      if (foreign) {
        await route.abort('blockedbyclient');
        return;
      }
      if (hostAllowed(url, options.allowedHosts, options.allowedHostSuffixes)) {
        const admitted = options.admit === undefined ? true : await options.admit(route.request()).catch(() => false);
        // Retombée sur les routes posées avant celle-ci (aucune sur un contexte neuf : la requête part).
        if (admitted) await route.fallback();
        else await route.abort('blockedbyclient');
      } else if (options.staticAssets !== undefined && options.staticAssets.admit(url, route.request().resourceType(), route.request().method())) {
        // Code et styles d'un tiers (CDN) pendant la reconnaissance : la page se rend ; rien d'autre ne sort vers ce tiers.
        await route.fallback();
      } else {
        note(url, route.request());
        await route.abort('blockedbyclient');
      }
    });
    await context.routeWebSocket(/.*/, async (ws) => {
      if (!hostAllowed(ws.url(), options.allowedHosts, options.allowedHostSuffixes)) {
        note(ws.url());
        await ws.close({ code: 1008, reason: 'domain_not_allowed' });
        return;
      }
      // Poignée de main = GET http sur le chemin : contrôle de l'appelant d'abord.
      const handshake = websocketHandshakeUrl(ws.url());
      const allowed =
        handshake !== undefined && (await checkRequest({ url: handshake, redirect: false, rootUrl: handshake, resourceType: 'WebSocket', mainFrame: false, method: 'GET' }).catch(() => false));
      if (!allowed) {
        await ws.close({ code: 1008, reason: 'request_refused' });
        return;
      }
      ws.connectToServer();
    });
    // Garde des documents (workers blob:/data:, règles de spéculation), avant la création de la page.
    await installPageGuard(context);
    // Chromium dédié : sa page initiale (about:blank, rien chargé) devient la page du run ; toute autre est fermée.
    const page = dedicated ? (context.pages()[0] ?? (await context.newPage())) : await context.newPage();
    runPage = page;
    // User-Agent du moteur et indices clients réels, avant toute navigation (la page est encore à about:blank).
    if (metadata !== undefined) await installUserAgentOverride(context, page, userAgent, metadata);
    // La session du contrôle n'est jamais détachée avant la fermeture du contexte : détachée, elle laisserait repartir
    // les requêtes encore suspendues.
    await installRequestGuard(context, page, (url) => hostAllowed(url, options.allowedHosts, options.allowedHostSuffixes), checkRequest);
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
