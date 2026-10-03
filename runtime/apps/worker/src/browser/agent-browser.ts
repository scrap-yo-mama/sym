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
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installDomainGuard, installSemanticRecorder, type DomainGuard, type SemanticRecorder } from '@runtime/agent';
import type { RequestPacer } from '@runtime/core/exec';
import { buildUserAgent } from '@runtime/core/access';
import { chromiumEgressLaunchOptions } from '@runtime/core/net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { installedEngineIdentity } from './engine-identity.js';
import { assertNotRoot, chromiumEnv, CHROMIUM_LAUNCH_TIMEOUT_MS, CHROMIUM_SILENT_ARGS, GUARD_DISABLED_FEATURES } from './launch.js';
import type { RequestCheck } from './request-guard.js';
import { openRunContext, type RunContext } from './run-context.js';

export type AgentBrowserOptions = {
  /** `BrowserEgress.server` de l'essai (http://127.0.0.1:PORT). */
  readonly egressServer: string;
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
 * Limites (revue de fix-flaky), hors de portée de la barrière : une écriture d'un worker ou d'un cadre hors processus, et
 * une navigation POST (envoi de formulaire, même dans la page : son `requestWillBeSent` vient du processus du navigateur,
 * après l'IPC BeginNavigation, sur un autre canal que la réponse de l'évaluation). Elles ne sont connues qu'à leur arrivée
 * à une couche de la garde (`route`, `check`), sans attendre aucun verdict : reste leur seul acheminement moteur de rendu
 * → navigateur → Node, que Stagehand précède d'au moins 500 ms de calme réseau après chaque geste. Le rejeu E5 sur le pool
 * refuse de toute façon toute écriture sans `allow_write_actions` (`navigationAdmission`, agent-executors.ts).
 */
async function trackPageWrites(context: BrowserContext, page: Page, counts: WriteCounts): Promise<(timeoutMs: number) => Promise<number>> {
  const session = await context.newCDPSession(page);
  session.on('Network.requestWillBeSent', (event) => {
    if (isWrite(event.request.method) && /^https?:/i.test(event.request.url)) counts.page.add(event.requestId);
  });
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

/** Fin de la sortie d'erreur de Chromium gardée pour dire la cause d'un lancement raté (bornée, sans le bruit D-Bus). */
const STDERR_TAIL_CHARS = 4000;

/**
 * Lancement raté du Chromium agentique. Le message est un CODE FERMÉ (`chromium_launch_signal:SIGTRAP`,
 * `chromium_launch_exit:3`, `chromium_launch_timeout`, `chromium_not_started:ENOENT`) : il remonte jusqu'à `error_detail`,
 * lisible par le propriétaire du run. La fin du stderr de Chromium (chemins, arguments, port du proxy d'egress) reste sur
 * `stderr`, pour le journal de l'opérateur seulement.
 */
export class ChromiumLaunchError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr = '') {
    super(message);
    this.name = 'ChromiumLaunchError';
    this.stderr = stderr;
  }
}

/** Sortie d'erreur du Chromium lue en continu (le tube ne se remplit jamais) ; seule sa fin est gardée. */
function stderrTail(child: ChildProcess): () => string {
  let tail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    tail = (tail + chunk).slice(-STDERR_TAIL_CHARS);
  });
  return () =>
    tail
      .split('\n')
      .filter((line) => line.trim() !== '' && !/dbus|OOM score/i.test(line))
      .join(' | ')
      .replace(/[^\x20-\x7e]/g, '?')
      .slice(-300);
}

/** Code système (ENOENT, SIGTRAP) restreint à des majuscules, chiffres et tiret bas : jamais un texte libre. */
const closedCode = (value: string): string => (/^[A-Z0-9_]{1,20}$/.test(value) ? value : 'UNKNOWN');

/**
 * Attend le port CDP du Chromium dédié. Un Chromium arrêté au lancement (code de sortie, SIGNAL : un CHECK de Chromium ou
 * de crashpad finit en SIGTRAP, `exitCode` reste alors null) ou jamais lancé (binaire absent) échoue AUSSITÔT, avec un
 * code fermé (UX-23 ; la fin du stderr reste sur l'erreur pour l'opérateur), au lieu d'attendre tout le délai de lancement.
 */
async function waitForFile(path: string, timeoutMs: number, child: ChildProcess, spawnError: () => Error | undefined, stderr: () => string): Promise<string> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = await readFile(path, 'utf8');
      if (text.includes('\n')) return text;
    } catch {
      // pas encore écrit
    }
    const failed = spawnError();
    if (failed !== undefined) throw new ChromiumLaunchError(`chromium_not_started:${closedCode((failed as NodeJS.ErrnoException).code ?? failed.name)}`, stderr());
    if (child.exitCode !== null) throw new ChromiumLaunchError(`chromium_launch_exit:${child.exitCode}`, stderr());
    if (child.signalCode !== null) throw new ChromiumLaunchError(`chromium_launch_signal:${closedCode(child.signalCode)}`, stderr());
    if (Date.now() > end) throw new ChromiumLaunchError('chromium_launch_timeout', stderr());
    await new Promise((r) => setTimeout(r, 50));
  }
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

/** Arguments figés du Chromium agentique (aucune entrée de stratégie, de prompt ni de membre). */
export function agentChromiumArgs(egressServer: string, profileDir: string, userAgent: string, env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const egress = chromiumEgressLaunchOptions(egressServer, env);
  return [
    ...egress.args,
    `--proxy-server=${egress.proxy.server}`,
    // Sans cette règle, Chromium contournerait le proxy pour la boucle locale.
    '--proxy-bypass-list=<-loopback>',
    ...CHROMIUM_SILENT_ARGS,
    // Garde des requêtes (revue de 1.11) : mêmes fonctions coupées que le Chromium du pool (launch.ts).
    `--disable-features=${GUARD_DISABLED_FEATURES.join(',')}`,
    '--headless=new',
    `--user-agent=${userAgent}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--window-size=1280,900',
    'about:blank',
  ];
}

export async function launchAgentBrowser(options: AgentBrowserOptions): Promise<AgentBrowser> {
  assertNotRoot();
  const env = options.env ?? process.env;
  const profile = await mkdtemp(join(tmpdir(), 'zz_agent_chromium_'));
  // HOME à lui, dans le profil jetable (UX-23) : le HOME hérité du worker peut être illisible (Render : le conteneur part
  // en root, HOME=/root, et le point d'entrée descend sur pwuser sans le changer) ; Chromium complet et son gestionnaire
  // crashpad s'y arrêtent alors en SIGTRAP. Le Chromium du pool (headless shell) n'en dépend pas.
  const home = join(profile, 'home');
  await mkdir(home, { mode: 0o700 });
  const child = spawn(options.executablePath ?? chromium.executablePath(), agentChromiumArgs(options.egressServer, profile, options.userAgent ?? buildUserAgent({ engine: installedEngineIdentity() }), env), {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...chromiumEnv(env), HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache') },
  });
  let spawnError: Error | undefined;
  child.once('error', (error) => {
    spawnError = error;
  });
  const stderr = stderrTail(child);
  let browser: Browser | undefined;
  let rc: RunContext | undefined;
  /** Processus tué et attendu : plus rien ne part, aucune requête suspendue par une interception ne peut repartir. */
  const kill = async () => {
    if (spawnError === undefined && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    const [port, path] = (await waitForFile(join(profile, 'DevToolsActivePort'), options.launchTimeoutMs ?? CHROMIUM_LAUNCH_TIMEOUT_MS, child, () => spawnError, stderr)).trim().split('\n');
    const cdpUrl = `ws://127.0.0.1:${Number(port)}${path ?? ''}`;
    browser = await chromium.connectOverCDP(cdpUrl);
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
        // Processus tué AVANT tout détachement CDP : une requête encore suspendue par une interception (contrôle de chaque
        // requête de la page, verrou de domaines, workers d'arrière-plan) repartirait dès que sa session se détache (`Fetch.disable`,
        // fermeture de la connexion de Playwright) — constaté : saut de redirection vers /prive/ envoyé à la fermeture.
        await kill();
        // Connexion constatée fermée d'abord (`close` attend la déconnexion) : tout appel CDP qui suit échoue aussitôt.
        await settle(opened.close());
        await settle(guard.dispose());
        await settle(run.close());
      },
    };
  } catch (error) {
    await kill();
    if (browser !== undefined) await settle(browser.close());
    if (rc !== undefined) await settle(rc.close());
    throw error;
  }
}
