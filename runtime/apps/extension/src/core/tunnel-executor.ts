// SPDX-License-Identifier: AGPL-3.0-only
// Exécuteur du tunnel dans l'extension (07 § 3-5, tâche 2.7) : un JEU FERMÉ de quatre commandes, aucune exécution de
// code venu du serveur. Avant toute action :
// - domaine CONNECTÉ dans ce navigateur (consentement + permission d'hôte), URL dans ce domaine, et garde des adresses
//   privées (INV10 : IP privées, `localhost`, `*.local`, métadonnées cloud), même pour un domaine connecté ;
// - liste blanche CDP (`page_script`), paramètres permis seulement, aucune chaîne de code (`method_not_allowed`) ;
// - garde d'écriture : clic d'envoi, touche Entrée ou méthode HTTP d'écriture refusés sans `allow_write_actions`.
// Défi détecté (page, réponse, arbre d'accessibilité) : l'onglet et le run sont VERROUILLÉS, plus aucune commande n'est
// exécutée (`challenge_in_tunnel`) ; le débogueur est détaché et l'onglet laissé à l'utilisateur, qui navigue
// normalement. Aucune prise de contrôle, aucun contournement (X3).
// Onglets d'automatisation : `active: false`, `autoDiscardable: false`, groupe « Scrapyomama », réveillés avant chaque
// commande (déchargé : rechargé ; gelé : `Page.setWebLifecycleState` à `active`). Débogueur attaché seulement pour
// `page_script` et `agent_step`, détaché à la fin du run (inactivité).
import {
  AgentStepExecutor,
  checkCdpCommand,
  commandUrl,
  detectChallenge,
  isSubmitKey,
  isWriteTarget,
  parseFetchArgs,
  type CommandFrame,
  type FetchArgs,
  type FetchResponse,
  type AgentStepWireResult,
  type TunnelError,
  type TunnelResult,
} from '@runtime/core/tunnel';
import type { BrowserApi, PageInspection } from './browser-api.ts';
import { CdpStepDriver, type AxNode } from './cdp-driver.ts';
import { checkHost, originPatterns } from './host-guard.ts';

/** Inactivité au-delà de laquelle la session d'un run est close (débogueur détaché, onglet fermé). */
const RUN_IDLE_MS = 30_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 5_000;
const MAX_META = 64 * 1024;

export type ExecutorDeps = {
  browser: BrowserApi;
  /** Domaines connectés dans CE navigateur (consentement explicite, 07 § 2). */
  connectedDomains(): Promise<ReadonlySet<string>>;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
};

type RunSession = {
  runId: string;
  domain: string;
  tabId: number | null;
  attached: boolean;
  agent: AgentStepExecutor | null;
  allowWriteActions: boolean;
  idle: unknown;
  unsubscribe: (() => void) | null;
  /** Réponse du document principal (statut, en-têtes) capturée par les événements `Network` (lecture seule). */
  lastDocument: { status: number; headers: Record<string, string>; url: string } | null;
};

class CommandRefused extends Error {
  readonly code: TunnelError;
  constructor(code: TunnelError) {
    super(code);
    this.code = code;
  }
}

const ok = (started: number, now: number, body: unknown, snapshotId: string | null = null): TunnelResult => ({ ok: true, error: null, ms: Math.max(0, Math.round(now - started)), snapshot_id: snapshotId, body });
const fail = (started: number, now: number, error: TunnelError, body: unknown = null, snapshotId: string | null = null): TunnelResult => ({
  ok: false,
  error,
  ms: Math.max(0, Math.round(now - started)),
  snapshot_id: snapshotId,
  body,
});

export class TunnelExecutor {
  readonly #deps: ExecutorDeps;
  readonly #runs = new Map<string, RunSession>();
  /** Runs et onglets verrouillés par un défi : plus aucune commande (07 § 5). */
  readonly #lockedRuns = new Set<string>();
  readonly #lockedTabs = new Set<number>();
  /** Commandes refusées sans rien exécuter parce que le run était verrouillé (observabilité, tests). */
  withheld = 0;
  /** Appels au navigateur faits pour des commandes (observabilité, tests). */
  browserCalls = 0;

  constructor(deps: ExecutorDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  /** Exécute une commande ; ne lève jamais (toute erreur devient une réponse typée). */
  async run(frame: CommandFrame): Promise<TunnelResult> {
    const started = this.#now();
    if (this.#lockedRuns.has(frame.run_id)) {
      this.withheld += 1;
      return fail(started, this.#now(), 'challenge_in_tunnel');
    }
    try {
      const domain = await this.#checkDomain(frame.domain);
      const session = this.#session(frame, domain);
      this.#touch(session);
      switch (frame.cmd) {
        case 'http_fetch':
          return ok(started, this.#now(), await this.#httpFetch(session, this.#fetchArgs(frame)));
        case 'page_fetch':
          return ok(started, this.#now(), await this.#pageFetch(session, this.#fetchArgs(frame)));
        case 'page_script':
          return ok(started, this.#now(), await this.#pageScript(session, frame.args));
        case 'agent_step': {
          const wire = await this.#agentStep(session, frame.args);
          if (wire.error === 'challenge_in_tunnel') await this.#lock(session);
          return wire.ok ? ok(started, this.#now(), wire, wire.snapshot_id) : fail(started, this.#now(), wire.error ?? 'fetch_failed', wire, wire.snapshot_id);
        }
      }
    } catch (error) {
      if (error instanceof CommandRefused) return fail(started, this.#now(), error.code);
      return fail(started, this.#now(), 'fetch_failed');
    }
  }

  /** Domaine de la commande : garde des adresses (INV10), connecté dans ce navigateur, permission d'hôte accordée. */
  async #checkDomain(raw: string): Promise<string> {
    const verdict = checkHost(raw);
    if (!verdict.ok || verdict.domain !== raw) throw new CommandRefused('domain_not_allowed');
    if (!(await this.#deps.connectedDomains()).has(verdict.domain)) throw new CommandRefused('domain_not_allowed');
    if (!(await this.#deps.browser.permissions.contains(originPatterns(verdict.domain)))) throw new CommandRefused('permission_required');
    return verdict.domain;
  }

  /** URL d'une commande : dans le domaine connecté, et jamais une adresse privée. */
  #url(raw: unknown, domain: string): URL {
    const url = commandUrl(raw, domain);
    if (url === null || !checkHost(url.hostname).ok) throw new CommandRefused('domain_not_allowed');
    return url;
  }

  #fetchArgs(frame: CommandFrame): FetchArgs {
    const parsed = parseFetchArgs(frame.args, frame.domain, frame.allow_write_actions);
    if (!parsed.ok) throw new CommandRefused(parsed.error === 'write_action_blocked' ? 'write_action_blocked' : parsed.error);
    this.#url(parsed.args.url, frame.domain);
    return parsed.args;
  }

  #session(frame: CommandFrame, domain: string): RunSession {
    let session = this.#runs.get(frame.run_id);
    if (session === undefined || session.domain !== domain) {
      session = { runId: frame.run_id, domain, tabId: null, attached: false, agent: null, allowWriteActions: frame.allow_write_actions, idle: null, unsubscribe: null, lastDocument: null };
      this.#runs.set(frame.run_id, session);
    }
    session.allowWriteActions = frame.allow_write_actions;
    return session;
  }

  #touch(session: RunSession): void {
    const clear = this.#deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    const set = this.#deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    if (session.idle !== null) clear(session.idle);
    session.idle = set(() => void this.release(session.runId), RUN_IDLE_MS);
  }

  /** Fin d'un run (inactivité) : débogueur détaché, onglet d'automatisation fermé (sauf onglet laissé après un défi). */
  async release(runId: string): Promise<void> {
    const session = this.#runs.get(runId);
    if (session === undefined) return;
    this.#runs.delete(runId);
    session.unsubscribe?.();
    if (session.attached && session.tabId !== null) await this.#deps.browser.debugger.detach(session.tabId).catch(() => undefined);
    if (session.tabId !== null && !this.#lockedTabs.has(session.tabId)) await this.#deps.browser.tabs.remove(session.tabId).catch(() => undefined);
  }

  /** Défi : run et onglet verrouillés, débogueur détaché, onglet laissé à l'utilisateur. */
  async #lock(session: RunSession): Promise<never> {
    this.#lockedRuns.add(session.runId);
    if (session.tabId !== null) this.#lockedTabs.add(session.tabId);
    if (session.attached && session.tabId !== null) {
      session.attached = false;
      session.unsubscribe?.();
      session.unsubscribe = null;
      await this.#deps.browser.debugger.detach(session.tabId).catch(() => undefined);
    }
    throw new CommandRefused('challenge_in_tunnel');
  }

  #challenged(session: RunSession, probe: Parameters<typeof detectChallenge>[0]): Promise<void> {
    return detectChallenge(probe) ? this.#lock(session) : Promise.resolve();
  }

  /**
   * Onglet d'automatisation du run, ouvert sur `origin` (`null` : page vide, la commande navigue ensuite), réveillé
   * avant chaque commande (07 § 4).
   */
  async #tab(session: RunSession, origin: string | null): Promise<number> {
    const { tabs } = this.#deps.browser;
    if (session.tabId !== null) {
      if (this.#lockedTabs.has(session.tabId)) throw new CommandRefused('challenge_in_tunnel');
      const tab = await tabs.get(session.tabId);
      if (tab !== null) {
        if (tab.discarded === true) {
          this.browserCalls += 1;
          await tabs.reload(tab.id);
          await tabs.waitComplete(tab.id, NAVIGATION_TIMEOUT_MS);
        } else if (tab.frozen === true) {
          await this.#unfreeze(session, tab.id);
        }
        return tab.id;
      }
      session.tabId = null;
      session.attached = false;
    }
    this.browserCalls += 1;
    const tab = await tabs.create(origin === null ? 'about:blank' : `${origin}/`);
    session.tabId = tab.id;
    await tabs.keep(tab.id);
    await tabs.group(tab.id).catch(() => undefined);
    if (!(await tabs.waitComplete(tab.id, NAVIGATION_TIMEOUT_MS))) throw new CommandRefused('timeout');
    // Page d'accueil du site : un défi ici arrête tout avant la première requête de données.
    if (origin !== null) await this.#inspectForChallenge(session, tab.id);
    return tab.id;
  }

  /** Onglet gelé : le cycle de vie repasse à `active` (débogueur, méthode de la liste blanche), puis détaché si besoin. */
  async #unfreeze(session: RunSession, tabId: number): Promise<void> {
    const { debugger: dbg } = this.#deps.browser;
    const wasAttached = session.attached;
    if (!wasAttached) await dbg.attach(tabId);
    await dbg.send(tabId, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => undefined);
    if (!wasAttached) await dbg.detach(tabId).catch(() => undefined);
  }

  async #inspectForChallenge(session: RunSession, tabId: number): Promise<PageInspection | null> {
    const page = await this.#deps.browser.scripting.inspect(tabId).catch(() => null);
    if (page !== null) await this.#challenged(session, { url: page.url, title: page.title, text: page.text });
    return page;
  }

  // --- http_fetch / page_fetch --------------------------------------------------------------------------------------

  async #httpFetch(session: RunSession, args: FetchArgs): Promise<FetchResponse> {
    this.browserCalls += 1;
    const res = await this.#deps.browser.fetch(args.url, { method: args.method, headers: args.headers, ...(args.body === null ? {} : { body: args.body }) });
    // Redirection hors du domaine connecté ou vers une adresse privée : rien n'est rendu.
    this.#url(res.url || args.url, session.domain);
    const body = await res.text(args.max_bytes);
    if (body === null) throw new CommandRefused('response_too_large');
    const headers = Object.fromEntries(res.headers.map(([k, v]) => [k.toLowerCase(), v]));
    await this.#challenged(session, { status: res.status, headers, url: res.url, text: body });
    return { status: res.status, headers, body, url: res.url || args.url };
  }

  async #pageFetch(session: RunSession, args: FetchArgs): Promise<FetchResponse> {
    const url = new URL(args.url);
    const tabId = await this.#tab(session, url.origin);
    this.browserCalls += 1;
    const out = await this.#deps.browser.scripting.pageFetch(tabId, { url: args.url, method: args.method, headers: args.headers, body: args.body, maxBytes: args.max_bytes, maxMeta: MAX_META });
    if (out.kind === 'too_large') throw new CommandRefused('response_too_large');
    if (out.kind === 'error') throw new CommandRefused('fetch_failed');
    this.#url(out.url || args.url, session.domain);
    let headers: Record<string, string> = {};
    try {
      const parsed = JSON.parse(out.headers) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        headers = Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'));
      }
    } catch {
      headers = {};
    }
    const html = /html/i.test(headers['content-type'] ?? '');
    await this.#challenged(session, { status: out.status, headers, url: out.url, ...(html ? { text: out.body } : {}) });
    return { status: out.status, headers, body: out.body, url: out.url || args.url };
  }

  // --- page_script / agent_step (débogueur) ---------------------------------------------------------------------------

  async #attached(session: RunSession, origin: string | null): Promise<number> {
    const tabId = await this.#tab(session, origin);
    if (!session.attached) {
      this.browserCalls += 1;
      await this.#deps.browser.debugger.attach(tabId);
      session.attached = true;
      session.unsubscribe = this.#deps.browser.debugger.onEvent(tabId, (method, params) => {
        // Lecture seule : statut et en-têtes du document principal (réponse de navigation).
        if (method !== 'Network.responseReceived') return;
        const p = params as { type?: string; response?: { status?: number; headers?: Record<string, unknown>; url?: string } } | null;
        if (p?.type !== 'Document' || typeof p.response?.status !== 'number') return;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(p.response.headers ?? {})) if (typeof v === 'string') headers[k.toLowerCase()] = v;
        session.lastDocument = { status: p.response.status, headers, url: typeof p.response.url === 'string' ? p.response.url : '' };
      });
      await this.#deps.browser.debugger.send(tabId, 'Network.enable', {});
      await this.#deps.browser.debugger.send(tabId, 'Page.enable', {});
      await this.#deps.browser.debugger.send(tabId, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => undefined);
    }
    return tabId;
  }

  /** Garde d'écriture d'un clic (07 § 5) : élément visé, ses ancêtres accessibles, bouton `type=submit`. */
  async #clickIsWrite(tabId: number, x: number, y: number): Promise<boolean> {
    const send = this.#deps.browser.debugger.send;
    const hit = (await send(tabId, 'DOM.getNodeForLocation', { x, y, ignorePointerEventsNone: true }).catch(() => null)) as { backendNodeId?: number } | null;
    if (typeof hit?.backendNodeId !== 'number') return false;
    const described = (await send(tabId, 'DOM.describeNode', { backendNodeId: hit.backendNodeId, depth: 0 }).catch(() => null)) as { node?: { nodeName?: string; attributes?: string[] } } | null;
    const attrs = described?.node?.attributes ?? [];
    const type = attrs[attrs.indexOf('type') + 1];
    const name = described?.node?.nodeName ?? '';
    if ((name === 'BUTTON' && (type === undefined || attrs.indexOf('type') === -1 || type === 'submit')) || (name === 'INPUT' && (type === 'submit' || type === 'image'))) {
      // Un bouton sans type, dans un formulaire, envoie le formulaire : écriture par défaut (fermé).
      return true;
    }
    const tree = (await send(tabId, 'Accessibility.getPartialAXTree', { backendNodeId: hit.backendNodeId, fetchRelatives: true }).catch(() => null)) as { nodes?: AxNode[] } | null;
    return (tree?.nodes ?? []).some((n) => typeof n.role?.value === 'string' && typeof n.name?.value === 'string' && isWriteTarget({ role: n.role.value, name: n.name.value }));
  }

  async #pageScript(session: RunSession, rawArgs: unknown): Promise<unknown> {
    if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs) || Object.keys(rawArgs).some((k) => k !== 'method' && k !== 'params')) {
      throw new CommandRefused('method_not_allowed');
    }
    const { method, params } = rawArgs as { method?: unknown; params?: unknown };
    if (!checkCdpCommand(method, params).ok) throw new CommandRefused('method_not_allowed');
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === 'Page.navigate') {
      const url = this.#url(p['url'], session.domain);
      const tabId = await this.#attached(session, url.origin);
      session.lastDocument = null;
      this.browserCalls += 1;
      const nav = (await this.#deps.browser.debugger.send(tabId, 'Page.navigate', { url: url.href })) as { frameId?: string; loaderId?: string; errorText?: string } | null;
      await this.#deps.browser.tabs.waitComplete(tabId, NAVIGATION_TIMEOUT_MS);
      const page = await this.#inspectForChallenge(session, tabId);
      const doc = session.lastDocument as RunSession['lastDocument'];
      if (page !== null) this.#url(page.url, session.domain);
      await this.#challenged(session, { ...(doc === null ? {} : { status: doc.status, headers: doc.headers }) });
      return { frameId: nav?.frameId ?? null, loaderId: nav?.loaderId ?? null, errorText: nav?.errorText ?? null, status: doc?.status ?? 0, headers: doc?.headers ?? {}, url: page?.url ?? doc?.url ?? url.href };
    }
    const tabId = await this.#attached(session, null);
    if (!session.allowWriteActions) {
      if (method === 'Input.dispatchKeyEvent' && isSubmitKey(p['key'], p['code'])) throw new CommandRefused('write_action_blocked');
      if (method === 'Input.dispatchMouseEvent' && p['type'] === 'mousePressed' && typeof p['x'] === 'number' && typeof p['y'] === 'number' && (await this.#clickIsWrite(tabId, p['x'], p['y']))) {
        throw new CommandRefused('write_action_blocked');
      }
    }
    this.browserCalls += 1;
    return this.#deps.browser.debugger.send(tabId, method as string, p);
  }

  async #agentStep(session: RunSession, rawArgs: unknown): Promise<AgentStepWireResult> {
    const tabId = await this.#attached(session, null);
    if (session.agent === null) {
      const driver = new CdpStepDriver({
        send: (method, params) => {
          this.browserCalls += 1;
          return this.#deps.browser.debugger.send(tabId, method, params);
        },
        url: async () => (await this.#deps.browser.tabs.get(tabId))?.url ?? '',
        settle: async () => void (await this.#deps.browser.tabs.waitComplete(tabId, SETTLE_TIMEOUT_MS)),
      });
      session.agent = new AgentStepExecutor({
        driver,
        urlAllowed: (url) => {
          const u = commandUrl(url, session.domain);
          return u !== null && checkHost(u.hostname).ok;
        },
        allowWriteActions: session.allowWriteActions,
      });
    }
    return session.agent.execute(rawArgs);
  }
}

