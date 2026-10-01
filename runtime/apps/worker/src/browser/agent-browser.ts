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
// - un script posé avant ceux de chaque page (`addInitScript`, même mécanisme que `serviceWorkers: 'block'` de Playwright,
//   qui ne vaut que pour un contexte neuf) : service workers jamais enregistrés (leurs requêtes échappent en partie aux
//   routes), et aucune saisie ne parvient à un champ d'un formulaire qui envoie HORS des domaines de l'API (formulaire
//   piège d'une injection de prompt : la page ne voit ni la frappe ni la valeur, 08 §4 mesures 2 et 4).
// Le port CDP n'écoute que sur 127.0.0.1, chemin imprévisible, pour la seule durée de l'essai ; le processus est tué à
// la fermeture. Un seul contexte : la couche CDP de la garde vaut pour tout le navigateur.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installDomainGuard, installSemanticRecorder, type DomainGuard, type SemanticRecorder } from '@runtime/agent';
import type { RequestPacer } from '@runtime/core/exec';
import { chromiumEgressLaunchOptions } from '@runtime/core/net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { assertNotRoot, chromiumEnv, CHROMIUM_SILENT_ARGS } from './launch.js';

export type AgentBrowserOptions = {
  /** `BrowserEgress.server` de l'essai (http://127.0.0.1:PORT). */
  readonly egressServer: string;
  readonly allowedHosts: readonly string[];
  readonly allowWriteActions: boolean;
  readonly pacer?: RequestPacer;
  /** Plafond de documents du cadre principal (`domain_pacing.max_requests_per_run`). */
  readonly maxRequests?: number;
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
  close(): Promise<void>;
};

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
    if (navigator.serviceWorker) {
      const blocked = () => Promise.reject(new DOMException('service workers bloqués (agent)', 'SecurityError'));
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
function agentChromiumArgs(egressServer: string, profileDir: string, env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const egress = chromiumEgressLaunchOptions(egressServer, env);
  return [
    ...egress.args,
    `--proxy-server=${egress.proxy.server}`,
    // Sans cette règle, Chromium contournerait le proxy pour la boucle locale.
    '--proxy-bypass-list=<-loopback>',
    ...CHROMIUM_SILENT_ARGS,
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
  const kill = async () => {
    child.kill('SIGKILL');
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
    const page = context.pages()[0] ?? (await context.newPage());
    const opened = browser;
    return {
      cdpUrl,
      browser: opened,
      context,
      page,
      guard,
      recorder,
      refused: () => ({ ...refused }),
      close: async () => {
        recorder.dispose();
        await guard.dispose().catch(() => undefined);
        await opened.close().catch(() => undefined);
        await kill();
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    await kill();
    throw error;
  }
}
