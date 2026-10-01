// Canal `agent_step` côté serveur (07 §3), sur une Page Playwright : cinq actions à gros grain, `snapshot_id`, refus
// `stale_ref` sans exécution, verrou de domaines par `context.route('**')` (08 §4, mesure 2) et refus des écritures
// (08 §4, mesure 4). Le même contrat sera tenu par le tunnel (tâche 0.6b) : le moteur ne voit que `AgentStepChannel`.
import type { AgentSnapshot, AgentStepAction, AgentStepChannel, AgentStepErrorCode, AgentStepResult } from '@runtime/core';
import type { BrowserContext, Page, Route } from 'playwright-core';
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

/**
 * Verrou de domaines sur tout le contexte (navigations initiées par la page, sous-ressources, `window.open`, redirections :
 * chaque requête passe par la route). Hors liste : `blockedbyclient`. Écriture (méthode non idempotente) sans
 * `allowWriteActions` : refusée aussi.
 */
export async function installDomainGuard(context: BrowserContext, options: DomainGuardOptions): Promise<DomainGuard> {
  const blocked: BlockedRequest[] = [];
  const seen = new Map<string, number>();
  const t0 = performance.now();
  const handler = async (route: Route): Promise<void> => {
    const request = route.request();
    const url = request.url();
    const host = hostOf(url);
    if (host !== null) seen.set(host, (seen.get(host) ?? 0) + 1);
    const method = request.method().toUpperCase();
    if (host === null && url.startsWith('data:')) return route.continue();
    if (!hostAllowed(host, options.allowedHosts)) {
      blocked.push({ url, host, method, reason: 'domain', atMs: Math.round(performance.now() - t0) });
      return route.abort('blockedbyclient');
    }
    if (!options.allowWriteActions && !READ_METHODS.has(method)) {
      blocked.push({ url, host, method, reason: 'write', atMs: Math.round(performance.now() - t0) });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  };
  await context.route('**/*', handler);
  return {
    blocked,
    attemptsTo: (host) => seen.get(host.toLowerCase()) ?? 0,
    offsite: () => blocked.filter((b) => b.reason === 'domain').length,
    dispose: () => context.unroute('**/*', handler).catch(() => undefined),
  };
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
        } catch {
          await this.#settle();
          return this.#refused('timeout', (await this.#capture()).snapshot);
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
