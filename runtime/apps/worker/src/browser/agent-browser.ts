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
// - robots.txt (1.11, INV11 ; correctif fix-inv11-agent) : le même code de garde que les contextes de run d'E1-E3
//   (`openRunContext` en mode `dedicated`, `checkRequest` exigé) — contrôle CDP de chaque requête de la page du run, sauts
//   de redirection, cadres hors processus et workers compris, poignée de main de chaque WebSocket, SharedWorker et service
//   workers coupés au niveau CDP du navigateur, garde des documents (workers blob:/data:, règles de spéculation, `register`
//   figé), autres pages fermées — et les fonctions coupées au lancement pour INV11 (prérendu, préchargement qui le précède,
//   WebSocketStream). Stagehand pilote cette même page avec sa propre auto-attache CDP (`waitForDebuggerOnStart`, puis
//   `runIfWaitingForDebugger`) : un cadre hors processus reste retenu tant que CHAQUE client qui l'a suspendu ne l'a pas
//   relancé, la garde comprise (interception posée avant sa reprise) ; les workers d'arrière-plan, qu'un seul client relance,
//   sont coupés par l'interception du navigateur, sans dépendre d'aucune suspension.
//   Vérifié avec Stagehand attaché, par cas (agent-robots.security.test.ts) : navigation, redirection, fetch de la page,
//   WebSocket, workers dédiés, cadre hors processus d'un autre site, règles de spéculation, robots.txt injoignable,
//   SharedWorker, service worker enregistré par le prototype. Échec fermé : si la garde ne peut pas être posée, le
//   lancement échoue ;
// - un script posé avant ceux de chaque page (`addInitScript`) : `register` des service workers figé (prototype et
//   instance), et aucune saisie ne parvient à un champ d'un formulaire qui envoie HORS des domaines de l'API (formulaire
//   piège d'une injection de prompt : la page ne voit ni la frappe ni la valeur, 08 §4 mesures 2 et 4).
// Le port CDP n'écoute que sur 127.0.0.1, chemin imprévisible, pour la seule durée de l'essai ; le processus est tué à
// la fermeture. Un seul contexte : la couche CDP de la garde vaut pour tout le navigateur.
// Ce Chromium est lancé DANS un slot du pool (`BrowserPool.hold`, appelé par les exécuteurs E5 et E6) : le Chromium
// partagé du slot est fermé avant, `BROWSER_CONCURRENCY` borne donc aussi les essais agentiques (14 §11).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installDomainGuard, installSemanticRecorder, type DomainGuard, type SemanticRecorder } from '@runtime/agent';
import type { RequestPacer } from '@runtime/core/exec';
import { chromiumEgressLaunchOptions } from '@runtime/core/net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { assertNotRoot, chromiumEnv, CHROMIUM_SILENT_ARGS, INV11_DISABLED_FEATURES } from './launch.js';
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
   * Contrôle robots.txt de CHAQUE requête http(s) d'un domaine de l'API et de chaque poignée de main WebSocket (1.11,
   * INV11) : obligatoire, aucun Chromium agentique sans lui.
   */
  readonly checkRequest: RequestCheck;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Exécutable Chromium (défaut : celui de Playwright). */
  readonly executablePath?: string;
  readonly launchTimeoutMs?: number;
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
  close(): Promise<void>;
};

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

async function waitForFile(path: string, timeoutMs: number, child: ChildProcess): Promise<string> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = await readFile(path, 'utf8');
      if (text.includes('\n')) return text;
    } catch {
      // pas encore écrit
    }
    if (child.exitCode !== null) throw new Error(`Chromium s'est arrêté au lancement (code ${child.exitCode})`);
    if (Date.now() > end) throw new Error(`Chromium : port CDP absent après ${timeoutMs} ms`);
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
export function agentChromiumArgs(egressServer: string, profileDir: string, env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const egress = chromiumEgressLaunchOptions(egressServer, env);
  return [
    ...egress.args,
    `--proxy-server=${egress.proxy.server}`,
    // Sans cette règle, Chromium contournerait le proxy pour la boucle locale.
    '--proxy-bypass-list=<-loopback>',
    ...CHROMIUM_SILENT_ARGS,
    // INV11 (revue de 1.11) : mêmes fonctions coupées que le Chromium du pool (launch.ts).
    `--disable-features=${INV11_DISABLED_FEATURES.join(',')}`,
    '--headless=new',
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
  const child = spawn(options.executablePath ?? chromium.executablePath(), agentChromiumArgs(options.egressServer, profile, env), {
    stdio: 'ignore',
    env: chromiumEnv(env),
  });
  let browser: Browser | undefined;
  let rc: RunContext | undefined;
  /** Processus tué et attendu : plus rien ne part, aucune requête suspendue par une interception ne peut repartir. */
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    const [port, path] = (await waitForFile(join(profile, 'DevToolsActivePort'), options.launchTimeoutMs ?? 20_000, child)).trim().split('\n');
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
    await context.route('**/*', async (route) => {
      const request = route.request();
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
    // Garde robots.txt des contextes de run (posée en dernier : sa route est consultée avant les autres, une requête
    // admise retombe sur la cadence puis sur le verrou de domaines). Elle désigne la page du run.
    rc = await openRunContext(browser, { dedicated: true, egressServer: options.egressServer, allowedHosts: options.allowedHosts, checkRequest: options.checkRequest });
    const run = rc;
    const page = run.page;
    const opened = browser;
    return {
      cdpUrl,
      browser: opened,
      context,
      page,
      guard,
      recorder,
      refused: () => ({ ...refused }),
      violations: () => run.violations.length,
      close: async () => {
        recorder.dispose();
        // Processus tué AVANT tout détachement CDP : une requête encore suspendue par une interception (contrôle robots de
        // la page, verrou de domaines, workers d'arrière-plan) repartirait dès que sa session se détache (`Fetch.disable`,
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
