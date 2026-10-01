// Canal `agent_step` côté serveur (07 §3), sur une Page Playwright : cinq actions à gros grain, `snapshot_id`, refus
// `stale_ref` sans exécution, verrou de domaines (route, redirections, WebSocket ; 08 §4, mesure 2) et refus des écritures
// (08 §4, mesure 4). Le même contrat sera tenu par le tunnel (tâche 0.6b) : le moteur ne voit que `AgentStepChannel`.
import type { AgentSnapshot, AgentStepAction, AgentStepChannel, AgentStepErrorCode, AgentStepResult } from '@runtime/core';
import type { Browser, BrowserContext, BrowserContextOptions, CDPSession, Page, Route, WebSocketRoute } from 'playwright-core';
import { contentDigest, DEFAULT_MAX_TREE_CHARS, hasRef, hostAllowed, hostOf, semanticOf, truncateTree } from './snapshot.js';

export interface BlockedRequest {
  readonly url: string;
  readonly host: string | null;
  readonly method: string;
  readonly reason: 'domain' | 'write';
  readonly atMs: number;
}

export interface DomainGuard {
  readonly blocked: readonly BlockedRequest[];
  /** Tentatives (bloquées ou non) vers un hôte donné, requêtes réseau vues par la garde. */
  attemptsTo(host: string): number;
  /** Requêtes vues par la garde vers des hôtes hors de la liste (bloquées). */
  offsite(): number;
  dispose(): Promise<void>;
}

export interface DomainGuardOptions {
  readonly allowedHosts: readonly string[];
  readonly allowWriteActions: boolean;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Options de tout contexte agentique : service workers bloqués (leurs requêtes échappent en partie aux routes). */
export const AGENT_CONTEXT_OPTIONS = { serviceWorkers: 'block' } as const satisfies BrowserContextOptions;

interface FetchRequestPaused {
  readonly requestId: string;
  readonly request: { readonly url: string; readonly method: string };
  readonly redirectedRequestId?: string;
}

/**
 * Verrou de domaines (08 §4, mesure 2), en trois couches :
 * 1. `context.route('**')` : toute requête initiale du contexte (navigations, sous-ressources, `window.open`, requêtes
 *    des service workers que Playwright voit). Hors liste : `blockedbyclient`. Écriture (méthode non idempotente) sans
 *    `allowWriteActions` : refusée aussi.
 * 2. Interception CDP `Fetch` au niveau du navigateur : Playwright n'appelle la route que pour la PREMIÈRE requête d'une
 *    chaîne de redirections et laisse Chromium suivre les sauts suivants sans contrôle (un 302 d'un hôte autorisé vers un
 *    hôte interdit passait). Chaque saut de redirection (`redirectedRequestId`), et toute requête qui n'aurait pas été
 *    vue par la route, est vérifié ici avec la même règle, dans Chromium : le trafic ne quitte jamais le navigateur
 *    (`route.fetch` le ferait partir de Node, hors du résolveur et du proxy de Chromium). Cette couche vaut pour tout le
 *    navigateur : un contexte agentique exige un navigateur dédié (un seul contexte), vérifié ici.
 * 3. `context.routeWebSocket('**')` : les WebSocket ne passent pas par la route ; hors liste, fermées et consignées.
 * Les contextes agentiques se créent par `newAgentContext` (service workers bloqués). Défense en profondeur attendue :
 * la même liste appliquée par le proxy d'egress (tâche 0.7).
 */
export async function installDomainGuard(context: BrowserContext, options: DomainGuardOptions): Promise<DomainGuard> {
  const browser = context.browser();
  if (browser === null) throw new Error('verrou de domaines : contexte sans navigateur (contexte persistant non pris en charge)');
  if (browser.contexts().length !== 1) {
    throw new Error(`verrou de domaines : un contexte agentique exige un navigateur dédié (contextes ouverts : ${browser.contexts().length})`);
  }
  const blocked: BlockedRequest[] = [];
  const seen = new Map<string, number>();
  const t0 = performance.now();
  const count = (host: string | null): void => {
    if (host !== null) seen.set(host, (seen.get(host) ?? 0) + 1);
  };
  /** Motif du refus d'une requête, ou null si elle passe. */
  const verdict = (url: string, method: string): BlockedRequest['reason'] | null => {
    const host = hostOf(url);
    if (host === null && url.startsWith('data:')) return null;
    if (!hostAllowed(host, options.allowedHosts)) return 'domain';
    if (!options.allowWriteActions && !READ_METHODS.has(method.toUpperCase())) return 'write';
    return null;
  };
  const record = (url: string, method: string, reason: BlockedRequest['reason']): void => {
    blocked.push({ url, host: hostOf(url.replace(/^ws(s?):/i, 'http$1:')), method: method.toUpperCase(), reason, atMs: Math.round(performance.now() - t0) });
  };

  const handler = async (route: Route): Promise<void> => {
    const request = route.request();
    const url = request.url();
    count(hostOf(url));
    const reason = verdict(url, request.method());
    if (reason === null) return route.continue();
    record(url, request.method(), reason);
    return route.abort('blockedbyclient');
  };
  await context.route('**/*', handler);

  const cdp: CDPSession = await browser.newBrowserCDPSession();
  cdp.on('Fetch.requestPaused', (event: FetchRequestPaused) => {
    const { url, method } = event.request;
    const reason = verdict(url, method);
    if (event.redirectedRequestId !== undefined || reason !== null) count(hostOf(url));
    if (reason === null) {
      cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => undefined);
      return;
    }
    record(url, method, reason);
    cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });

  const wsHandler = (ws: WebSocketRoute): void => {
    const url = ws.url();
    const host = hostOf(url.replace(/^ws(s?):/i, 'http$1:'));
    count(host);
    if (hostAllowed(host, options.allowedHosts)) {
      ws.connectToServer();
      return;
    }
    record(url, 'GET', 'domain');
    ws.close({ code: 1008, reason: 'blockedbyclient' }).catch(() => undefined);
  };
  await context.routeWebSocket('**', wsHandler);

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await cdp.send('Fetch.disable').catch(() => undefined);
    await cdp.detach().catch(() => undefined);
    await context.unroute('**/*', handler).catch(() => undefined);
  };
  context.once('close', () => void dispose());
  return {
    blocked,
    attemptsTo: (host) => seen.get(host.toLowerCase()) ?? 0,
    offsite: () => blocked.filter((b) => b.reason === 'domain').length,
    dispose,
  };
}

/** Contexte agentique : options `AGENT_CONTEXT_OPTIONS` et verrou de domaines posé avant la première page. */
export async function newAgentContext(browser: Browser, options: DomainGuardOptions): Promise<{ context: BrowserContext; guard: DomainGuard }> {
  const context = await browser.newContext(AGENT_CONTEXT_OPTIONS);
  try {
    return { context, guard: await installDomainGuard(context, options) };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

export interface PlaywrightChannelOptions {
  readonly page: Page;
  readonly allowedHosts: readonly string[];
  readonly maxTreeChars?: number;
  /** Délai d'une action élémentaire (clic, saisie, navigation). */
  readonly actionTimeoutMs?: number;
}

interface Current {
  snapshot: AgentSnapshot;
  /** Arbre complet (non tronqué) : sert à retrouver rôle et nom d'un `ref`. */
  fullTree: string;
  digest: string;
}

export class PlaywrightStepChannel implements AgentStepChannel {
  readonly #page: Page;
  readonly #allowed: readonly string[];
  readonly #maxTree: number;
  readonly #timeout: number;
  #counter = 0;
  #current: Current | undefined;

  constructor(options: PlaywrightChannelOptions) {
    this.#page = options.page;
    this.#allowed = options.allowedHosts;
    this.#maxTree = options.maxTreeChars ?? DEFAULT_MAX_TREE_CHARS;
    this.#timeout = options.actionTimeoutMs ?? 10_000;
  }

  /** Rôle et nom accessibles d'un `ref` de l'instantané courant (trace sémantique). */
  semanticTarget(snapshotId: string, ref: string): { role: string; name: string } | undefined {
    if (this.#current?.snapshot.snapshotId !== snapshotId) return undefined;
    return semanticOf(this.#current.fullTree, ref);
  }

  async #capture(): Promise<Current> {
    const url = this.#page.url();
    let tree: string;
    try {
      tree = await this.#page.ariaSnapshot({ mode: 'ai', timeout: this.#timeout });
    } catch {
      // Page en cours de navigation : une seconde tentative après le chargement.
      await this.#page.waitForLoadState('domcontentloaded', { timeout: this.#timeout }).catch(() => undefined);
      tree = await this.#page.ariaSnapshot({ mode: 'ai', timeout: this.#timeout });
    }
    const digest = contentDigest(url, tree);
    if (this.#current?.digest === digest) return this.#current;
    const { text, truncated } = truncateTree(tree, this.#maxTree);
    this.#counter += 1;
    const current: Current = {
      snapshot: { snapshotId: `s${this.#counter}-${digest.slice(0, 6)}`, url, accessibilityTree: text, truncated },
      fullTree: tree,
      digest,
    };
    this.#current = current;
    return current;
  }

  async snapshot(): Promise<AgentSnapshot> {
    return (await this.#capture()).snapshot;
  }

  async #settle(): Promise<void> {
    await this.#page.waitForLoadState('domcontentloaded', { timeout: this.#timeout }).catch(() => undefined);
    await this.#page.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => undefined);
  }

  #refused(error: AgentStepErrorCode, snapshot?: AgentSnapshot): AgentStepResult {
    return snapshot === undefined ? { ok: false, error } : { ok: false, error, snapshot };
  }

  /**
   * Vérifie qu'une action vise l'instantané courant ET que la page n'a pas changé depuis : sinon `stale_ref`, rien
   * n'est exécuté et le nouvel instantané est renvoyé (07 §3).
   */
  async #fresh(snapshotId: string, ref?: string): Promise<{ ok: true } | { ok: false; result: AgentStepResult }> {
    const previous = this.#current;
    const now = await this.#capture();
    if (previous === undefined || previous.snapshot.snapshotId !== snapshotId || now.digest !== previous.digest) {
      return { ok: false, result: this.#refused('stale_ref', now.snapshot) };
    }
    if (ref !== undefined && !hasRef(now.fullTree, ref)) return { ok: false, result: this.#refused('stale_ref', now.snapshot) };
    return { ok: true };
  }

  async execute(action: AgentStepAction): Promise<AgentStepResult> {
    switch (action.kind) {
      case 'navigate': {
        if (!hostAllowed(hostOf(action.url), this.#allowed)) return this.#refused('domain_not_allowed', (await this.#capture()).snapshot);
        try {
          await this.#page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: this.#timeout });
        } catch (error) {
          await this.#settle();
          // Saut de redirection vers un hôte hors liste, refusé par le verrou de domaines (l'URL de départ était permise).
          const code = String(error).includes('ERR_BLOCKED_BY_CLIENT') ? 'domain_not_allowed' : 'timeout';
          return this.#refused(code, (await this.#capture()).snapshot);
        }
        await this.#settle();
        return { ok: true, snapshot: (await this.#capture()).snapshot };
      }
      case 'click':
      case 'type': {
        const check = await this.#fresh(action.target.snapshotId, action.target.ref);
        if (!check.ok) return check.result;
        const locator = this.#page.locator(`aria-ref=${action.target.ref}`);
        try {
          if (action.kind === 'click') await locator.click({ timeout: this.#timeout });
          else await locator.fill(action.text, { timeout: this.#timeout });
        } catch {
          await this.#settle();
          return this.#refused('timeout', (await this.#capture()).snapshot);
        }
        await this.#settle();
        return { ok: true, snapshot: (await this.#capture()).snapshot };
      }
      case 'scroll': {
        const check = await this.#fresh(action.snapshotId);
        if (!check.ok) return check.result;
        await this.#page.mouse.wheel(0, action.direction === 'down' ? 800 : -800);
        await this.#settle();
        return { ok: true, snapshot: (await this.#capture()).snapshot };
      }
      case 'read':
        return { ok: true, snapshot: (await this.#capture()).snapshot };
    }
  }
}

