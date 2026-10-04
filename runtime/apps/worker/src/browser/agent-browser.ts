// SPDX-License-Identifier: AGPL-3.0-only
// Chromium DÉDIÉ d'un essai agentique (tâche 2.4 ; ADR 0001 ; 08 §4 mesure 2 ; 08b §1). Stagehand pilote Chromium par
// son propre client CDP (`cdpUrl`) : le navigateur est lancé par le worker, pour cet essai seulement, avec
// - le proxy d'egress DE L'ESSAI comme proxy de lancement (boucle locale comprise, `<-loopback>`) : verrou de domaines de
//   l'API et garde SSRF à chaque connexion et à chaque saut de redirection, hors de portée du moteur et du modèle ;
// - le résolveur DNS local coupé, WebRTC sans UDP hors proxy, la liste silencieuse de 1.6, le bac à sable de Chromium
//   actif (jamais `--no-sandbox`), un profil jetable, un environnement réduit (ni MASTER_KEY, ni DATABASE_URL, ni clé) ;
// - en seconde couche, `installDomainGuard` (route Playwright, interception CDP des redirections, WebSocket, écritures
//   refusées sans `allow_write_actions`) et l'enregistreur de cibles sémantiques (compilation E6 → E5) ;
// - la cadence par domaine (1.9) et `max_requests_per_run` sur les documents du cadre principal ;
// - la garde des contextes de run (correctif fix-inv11-agent) : le même code de garde que les contextes de run d'E1-E3
//   (`openRunContext` en mode `dedicated`) — contrôle CDP de chaque requête de la page du run (verrou de domaines), sauts
//   de redirection, cadres hors processus et workers compris, poignée de main de chaque WebSocket, SharedWorker et service
//   workers coupés au niveau CDP du navigateur, garde des documents (workers blob:/data:, règles de spéculation, `register`
//   figé), autres pages fermées — et les fonctions coupées au lancement (prérendu, préchargement qui le précède,
//   WebSocketStream). Stagehand pilote cette même page avec sa propre auto-attache CDP (`waitForDebuggerOnStart`, puis
//   `runIfWaitingForDebugger`) : un cadre hors processus reste retenu tant que CHAQUE client qui l'a suspendu ne l'a pas
//   relancé, la garde comprise (interception posée avant sa reprise) ; les workers d'arrière-plan, qu'un seul client relance,
//   sont coupés par l'interception du navigateur, sans dépendre d'aucune suspension.
//   Échec fermé : si la garde ne peut pas être posée, le lancement échoue ;
// - un script posé avant ceux de chaque page (`addInitScript`) : `register` des service workers figé (prototype et
//   instance), et aucune saisie ne parvient à un champ d'un formulaire qui envoie HORS des domaines de l'API (formulaire
//   piège d'une injection de prompt : la page ne voit ni la frappe ni la valeur, 08 §4 mesures 2 et 4).
// Le port CDP n'écoute que sur 127.0.0.1, chemin imprévisible, pour la seule durée de l'essai ; le processus est tué à
// la fermeture. Un seul contexte : la couche CDP de la garde vaut pour tout le navigateur.
// Ce Chromium est lancé DANS un slot du pool (`BrowserPool.hold`, appelé par les exécuteurs E5 et E6) : le Chromium
// partagé du slot est fermé avant, `BROWSER_CONCURRENCY` borne donc aussi les essais agentiques (14 §11).
import { installDomainGuard, installSemanticRecorder, type DomainGuard, type SemanticRecorder } from '@runtime/agent';
import type { RequestPacer } from '@runtime/core/exec';
import { buildUserAgent } from '@runtime/core/access';
import type { BrowserProvider } from '@sym/contracts/browser';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { createLocalProvider } from './provider-local.js';
import type { RunEgress } from './run-egress.js';
import type { RequestCheck } from './request-guard.js';
import { openRunContext, type RunContext } from './run-context.js';

// Le lancement du Chromium (spawn, port CDP, arguments figés) vit dans le fournisseur `local` (provider-local.ts, tâche 4.1) ;
// ce module reste propriétaire de tout ce qui suit le lancement (garde, cadence, écritures, enregistreur). Réexportés pour
// les appelants et tests existants.
export { agentChromiumArgs, ChromiumLaunchError } from './provider-local.js';

export type AgentBrowserOptions = {
  /** `BrowserEgress.server` de l'essai (http://127.0.0.1:PORT) ; `null` : le nœud distant impose son egress. */
  readonly egressServer: string | null;
  /** Egress de l'essai : `policy` posée à la création d'une session distante `dedicated`, `attach` après la connexion (tâche 4.3). */
  readonly egress?: Pick<RunEgress, 'attach' | 'policy'>;
  readonly allowedHosts: readonly string[];
  readonly allowWriteActions: boolean;
  readonly pacer?: RequestPacer;
  /** Plafond de documents du cadre principal (`domain_pacing.max_requests_per_run`). */
  readonly maxRequests?: number;
  /**
   * Contrôle supplémentaire, optionnel, de CHAQUE requête http(s) d'un domaine de l'API et de chaque poignée de main
   * WebSocket : `false` la coupe avant toute connexion. Aucun exécuteur ne le pose ; il permet de retenir une requête
   * (verdict tardif) pour vérifier le compte des écritures lancées (`settleWrites`).
   */
  readonly checkRequest?: RequestCheck;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Exécutable Chromium (défaut : celui de Playwright). */
  readonly executablePath?: string;
  /** Fournisseur de navigateur (`BrowserProvider`, factory.ts) ; défaut : le Chromium local du worker. */
  readonly provider?: BrowserProvider;
  readonly launchTimeoutMs?: number;
  /**
   * User-Agent du robot de l'essai (`buildUserAgent`, 1.11, 17 §5), posé au lancement par `--user-agent` : la chaîne
   * du moteur, avec le jeton si `identify_instance` est activé. Défaut : la chaîne exacte du Chromium installé.
   */
  readonly userAgent?: string;
};

export type AgentBrowser = {
  readonly cdpUrl: string;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly guard: DomainGuard;
  readonly recorder: SemanticRecorder;
  /** Documents refusés par la cadence ou le plafond de requêtes. */
  readonly refused: () => { pacing: number; maxRequests: number };
  /** Requêtes et WebSocket coupés par le verrou de domaines du contexte de run (hôtes seulement). */
  readonly violations: () => number;
  /**
   * Nombre d'écritures (méthode autre que GET, HEAD, OPTIONS) LANCÉES depuis le lancement, quel que soit leur verdict
   * (coupée par la garde, par la route des domaines, ou encore suspendue), toutes cibles de la page du
   * run (cadres hors processus et workers dédiés compris), après une barrière sur la page : minorant du nombre réel, et
   * au moins 1 si la barrière n'a pas répondu dans `timeoutMs` (échec fermé). Rend la main en `timeoutMs` au plus, même
   * si le fil principal de la page boucle. À appeler à la fin de l'agent (08 §4 mesure 4) ; voir `trackPageWrites`.
   */
  readonly settleWrites: (timeoutMs: number) => Promise<number>;
  close(): Promise<void>;
};

/** Méthodes de lecture (même verdict que `installDomainGuard`, playwright-channel.ts). */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const isWrite = (method: string): boolean => !READ_METHODS.has(method.toUpperCase());

/**
 * Écritures (méthode autre que GET, HEAD, OPTIONS) LANCÉES pendant l'essai, quel que soit leur verdict : sans
 * `allow_write_actions`, aucune n'est légitime, chacune est coupée par une couche ou une autre (verrou de l'agent,
 * domaines). Compter le verdict de la garde ne suffit pas (revue de fix-flaky) : il arrive après la fin de l'agent quand
 * une couche consultée avant elle tarde (cadence ; course constatée sous charge), et une écriture coupée par la route des
 * domaines n'atteint jamais la garde d'écriture.
 * Trois relevés, chacun un minorant du nombre d'écritures distinctes (une requête n'y est comptée qu'une fois) :
 * - `page` : la session CDP `Network` de la page du run (page et cadres du même processus), ordonnée par la barrière ;
 * - `route` : les routes Playwright du contexte (route des domaines du contexte de run, puis cadence), à l'entrée, avant
 *   tout verdict : page, cadres hors processus, workers dédiés (requêtes initiales) ;
 * - `check` : le contrôle CDP de chaque requête (request-guard.ts), à l'entrée, avant son verdict : page,
 *   cadres hors processus et workers dédiés, requêtes d'un domaine de l'API.
 */
type WriteCounts = { readonly page: Set<string>; route: number; check: number };

const newWriteCounts = (): WriteCounts => ({ page: new Set(), route: 0, check: 0 });

/** Issue d'une étape bornée : réponse, rejet, ou échéance atteinte. */
function within(step: Promise<unknown>, ms: number): Promise<'answered' | 'rejected' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    void step.then(
      () => (clearTimeout(timer), resolve('answered')),
      () => (clearTimeout(timer), resolve('rejected')),
    );
  });
}

/**
 * Suivi `Network` de la page du run (sa propre session CDP, sans tampon de corps : `maxTotalBufferSize: 0`) et
 * `settleWrites`. Blink émet `requestWillBeSent` au lancement d'une requête, sur le fil de la page ; une évaluation sur
 * la même session sert de barrière : quand elle répond, le lancement de toute requête que ce moteur de rendu a émise
 * avant est déjà connu. UNE échéance couvre toute l'attente : une page dont le fil principal boucle (l'évaluation ne
 * répond jamais) ne tient ni l'essai ni le slot du pool ; la barrière sans réponse à l'échéance compte pour une écriture
 * (non vérifiable : échec fermé). Une évaluation rejetée (contexte détruit par une navigation) est relancée.
 * Un envoi de formulaire POST de la page est compté dès sa DEMANDE (`Page.frameRequestedNavigation`, émise par le moteur de
 * rendu sur le fil de la page : son `requestWillBeSent` vient, lui, du processus du navigateur, après l'IPC BeginNavigation).
 * Limites (revue de fix-flaky), hors de portée de la barrière : une écriture d'un worker ou d'un cadre hors processus. Elles ne sont connues qu'à leur arrivée
 * à une couche de la garde (`route`, `check`), sans attendre aucun verdict : reste leur seul acheminement moteur de rendu
 * → navigateur → Node, que Stagehand précède d'au moins 500 ms de calme réseau après chaque geste. Le rejeu E5 sur le pool
 * refuse de toute façon toute écriture sans `allow_write_actions` (`navigationAdmission`, agent-executors.ts).
 */
async function trackPageWrites(context: BrowserContext, page: Page, counts: WriteCounts): Promise<(timeoutMs: number) => Promise<number>> {
  const session = await context.newCDPSession(page);
  session.on('Network.requestWillBeSent', (event) => {
    if (isWrite(event.request.method) && /^https?:/i.test(event.request.url)) counts.page.add(event.requestId);
  });
  // Envoi de formulaire POST : la DEMANDE de navigation est émise par le moteur de rendu, sur le fil de la page, avant l'IPC
  // vers le navigateur (`Page.frameRequestedNavigation`) : la barrière ci-dessous, ordonnée sur la même session, la voit.
  // Sans elle, un envoi lancé par le tout dernier geste de l'agent n'arrivait aux couches de la garde qu'après le compte
  // (course constatée sous charge, fix-pa01).
  let formPosts = 0;
  session.on('Page.frameRequestedNavigation', (event) => {
    if (event.reason === 'formSubmissionPost') counts.page.add(`form:${(formPosts += 1)}`);
  });
  await session.send('Page.enable');
  // Aucun tampon de corps de réponse ni de corps envoyé : seuls les identifiants des requêtes servent ici.
  await session.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 });
  return async (timeoutMs) => {
    const deadline = performance.now() + timeoutMs;
    let verified = false;
    for (;;) {
      const left = deadline - performance.now();
      if (left <= 0) break;
      const outcome = await within(session.send('Runtime.evaluate', { expression: '0', silent: true }), left);
      if (outcome === 'answered') {
        verified = true;
        break;
      }
      if (outcome === 'timeout') break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, deadline - performance.now()))));
    }
    return Math.max(counts.page.size, counts.route, counts.check, verified ? 0 : 1);
  };
}

/**
 * Étape de fermeture bornée (jamais rejetée) : une fois Chromium tué, un appel CDP parti avant que Playwright ne constate
 * la coupure de la connexion ne reçoit jamais de réponse (Playwright ne rejette pas les appels en cours d'une session
 * CDP enfant quand la connexion tombe) ; la fermeture ne doit jamais tenir le slot du pool indéfiniment.
 */
function settle(step: Promise<unknown>, ms = 5000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    void step.then(
      () => (clearTimeout(timer), resolve()),
      () => (clearTimeout(timer), resolve()),
    );
  });
}

/**
 * Script de page du Chromium agentique (monde principal, avant tout script de la page). Les écouteurs sont posés en
 * capture sur `window` : ils passent avant ceux de la page (y compris les attributs `oninput`) et arrêtent l'événement.
 */
function agentPageGuardScript(allowedHosts: readonly string[]): string {
  return `(() => {
  const allowed = new Set(${JSON.stringify(allowedHosts.map((h) => h.toLowerCase()))});
  try {
    // Prototype ET instance : une surcharge de la seule instance se contourne par
    // ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, …) (revue de fix-inv11-agent).
    const blocked = () => Promise.reject(new DOMException('service workers bloqués (agent)', 'SecurityError'));
    if (typeof ServiceWorkerContainer === 'function') {
      Object.defineProperty(ServiceWorkerContainer.prototype, 'register', { value: blocked, configurable: false, writable: false });
    }
    if (navigator.serviceWorker) {
      Object.defineProperty(navigator.serviceWorker, 'register', { value: blocked, configurable: false, writable: false });
    }
  } catch (e) {}
  const offsite = (target) => {
    const form = target && typeof target === 'object' && 'form' in target ? target.form : null;
    if (!form) return false;
    try {
      return !allowed.has(new URL(form.getAttribute('action') || location.href, location.href).hostname.toLowerCase());
    } catch (e) {
      return true;
    }
  };
  const stop = (event) => {
    const target = event.composedPath ? event.composedPath()[0] : event.target;
    if (!offsite(target)) return;
    event.stopImmediatePropagation();
    if (event.cancelable) event.preventDefault();
    if (event.type === 'input' || event.type === 'change') {
      try { target.value = ''; } catch (e) {}
    }
  };
  for (const type of ['beforeinput', 'input', 'change', 'keydown', 'keypress', 'keyup', 'paste', 'compositionend']) {
    window.addEventListener(type, stop, true);
  }
})();`;
}

export async function launchAgentBrowser(options: AgentBrowserOptions): Promise<AgentBrowser> {
  const env = options.env ?? process.env;
  // Fournisseur : celui du câblage (factory.ts) ; à défaut le Chromium local du worker (sans proxy de lancement : seul le Chromium dédié en sort).
  const provider = options.provider ?? createLocalProvider({ launchProxyUrl: '', env, ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }) });
  const launched = await provider.launchDedicated({
    userAgent: options.userAgent ?? buildUserAgent({ engine: await provider.engineIdentity() }),
    egress: options.egress?.policy ?? { allowedHosts: [...options.allowedHosts] },
    egressServer: options.egressServer,
    launchArgs: [],
    ...(options.launchTimeoutMs === undefined ? {} : { launchTimeoutMs: options.launchTimeoutMs }),
  });
  const { cdpUrl } = launched;
  let browser: Browser | undefined;
  let rc: RunContext | undefined;
  try {
    browser = launched.browser;
    const context = browser.contexts()[0];
    if (context === undefined) throw new Error('Chromium : aucun contexte par défaut');
    // Avant toute page : service workers et saisies vers un formulaire hors domaines (voir agentPageGuardScript).
    await context.addInitScript({ content: agentPageGuardScript(options.allowedHosts) });
    const guard = await installDomainGuard(context, { allowedHosts: options.allowedHosts, allowWriteActions: options.allowWriteActions });
    const recorder = await installSemanticRecorder(context);
    // Cadence (1.9) et plafond de requêtes sur les documents du cadre principal, AVANT la garde (route enregistrée après
    // elle, donc consultée d'abord) ; une requête admise retombe sur la garde (`fallback`).
    let documents = 0;
    const refused = { pacing: 0, maxRequests: 0 };
    // Écritures lancées, relevées à l'entrée de chaque couche, avant tout verdict (voir `WriteCounts`).
    const writes = newWriteCounts();
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (isWrite(request.method())) writes.route += 1;
      if (request.isNavigationRequest() && request.resourceType() === 'document' && request.redirectedFrom() === null) {
        if (options.maxRequests !== undefined && documents >= options.maxRequests) {
          refused.maxRequests += 1;
          return route.abort('blockedbyclient');
        }
        if (options.pacer !== undefined) {
          const slot = await options.pacer.acquire(request.url()).catch(() => ({ granted: false as const }));
          if (!slot.granted) {
            refused.pacing += 1;
            return route.abort('blockedbyclient');
          }
        }
        documents += 1;
      }
      return route.fallback();
    });
    // Garde des contextes de run (posée en dernier : sa route est consultée avant les autres, une requête admise retombe
    // sur la cadence puis sur le verrou de domaines). Elle désigne la page du run.
    // Écriture hors domaines : coupée par cette route, elle n'atteint ni la cadence ni la garde ; écriture d'un domaine de
    // l'API : relevée par le contrôle CDP (requête initiale, saut de redirection exclu).
    rc = await openRunContext(browser, {
      dedicated: true,
      egressServer: options.egressServer,
      ...(options.egress === undefined ? {} : { egress: options.egress }),
      allowedHosts: options.allowedHosts,
      onViolation: (_host, request) => {
        if (request !== undefined && isWrite(request.method())) writes.route += 1;
      },
      checkRequest: async (hop) => {
        if (!hop.redirect && isWrite(hop.method)) writes.check += 1;
        return options.checkRequest === undefined ? true : options.checkRequest(hop);
      },
    });
    const run = rc;
    const page = run.page;
    const opened = browser;
    const settleWrites = await trackPageWrites(context, page, writes);
    return {
      cdpUrl,
      browser: opened,
      context,
      page,
      guard,
      recorder,
      refused: () => ({ ...refused }),
      violations: () => run.violations.length,
      settleWrites,
      close: async () => {
        recorder.dispose();
        // Processus tué AVANT tout détachement CDP (`launched.close()` : `kill()` du fournisseur, puis connexion constatée
        // fermée) : une requête encore suspendue par une interception (contrôle de chaque requête de la page, verrou de
        // domaines, workers d'arrière-plan) repartirait dès que sa session se détache (`Fetch.disable`, fermeture de la
        // connexion de Playwright) — constaté : saut de redirection vers /prive/ envoyé à la fermeture.
        await launched.close();
        await settle(guard.dispose());
        await settle(run.close());
      },
    };
  } catch (error) {
    await launched.close();
    if (rc !== undefined) await settle(rc.close());
    throw error;
  }
}
