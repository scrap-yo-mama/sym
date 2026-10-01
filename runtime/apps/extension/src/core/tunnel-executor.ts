// SPDX-License-Identifier: AGPL-3.0-only
// Exécuteur du tunnel dans l'extension (07 § 3-5, tâche 2.7) : un JEU FERMÉ de quatre commandes, aucune exécution de
// code venu du serveur. Avant toute action :
// - domaine CONNECTÉ dans ce navigateur (consentement + permission d'hôte), URL dans ce domaine, et garde des adresses
//   privées (INV10 : IP privées, `localhost`, `*.local`, métadonnées cloud), même pour un domaine connecté ;
// - liste blanche CDP (`page_script`), paramètres permis seulement, aucune chaîne de code (`method_not_allowed`) ;
// - garde d'écriture : clic d'envoi, focus d'un bouton d'envoi, touche Entrée ou Espace (quelle que soit sa forme),
//   verbe HTTP d'écriture (PUT, PATCH, DELETE) refusés sans `allow_write_actions` ;
// - onglet du débogueur : AVANT chaque commande `page_script` / `agent_step`, son URL courante (`tabs.get`, lisible sans
//   permission d'hôte) doit rester dans le domaine connecté et hors adresses privées, et la page est inspectée (défi) ;
//   APRÈS une commande qui peut naviguer (`Page.navigate`, `Page.reload`, `Input.*`, action `agent_step`), même contrôle.
//   Onglet passé sur un autre site (redirection serveur, JavaScript, redirection ouverte) : `domain_not_allowed`,
//   débogueur détaché, onglet fermé, rien n'est rendu. Inspection impossible = refus (fermé), jamais « pas de défi » ;
// - `fetch` sans redirection suivie (`redirect: 'manual'`) : une redirection est un échec (`fetch_failed`).
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
  detectResponseChallenge,
  isActivationKey,
  isWriteElement,
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
import { CdpStepDriver, renderAxTree, type AxNode } from './cdp-driver.ts';
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
  /** Cadre principal de l'onglet (`Page.getFrameTree`) : les documents des iframes (autres sites) sont ignorés. */
  mainFrameId: string | null;
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
          // L'action a pu mener sur un autre site : rien de ce qu'elle a observé n'est rendu.
          if (session.tabId !== null) await this.#checkTab(session, session.tabId, { inspect: false });
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
      session = { runId: frame.run_id, domain, tabId: null, attached: false, agent: null, allowWriteActions: frame.allow_write_actions, idle: null, unsubscribe: null, lastDocument: null, mainFrameId: null };
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
   * Onglet passé hors du domaine connecté (ou sur une adresse privée) : débogueur détaché, onglet fermé (il porte la
   * session de l'utilisateur sur un autre site), session de pas oubliée ; la commande est refusée sans rien rendre.
   */
  async #evict(session: RunSession): Promise<never> {
    const tabId = session.tabId;
    session.unsubscribe?.();
    session.unsubscribe = null;
    session.agent = null;
    session.lastDocument = null;
    session.mainFrameId = null;
    session.tabId = null;
    if (tabId !== null) {
      if (session.attached) await this.#deps.browser.debugger.detach(tabId).catch(() => undefined);
      if (!this.#lockedTabs.has(tabId)) await this.#deps.browser.tabs.remove(tabId).catch(() => undefined);
    }
    session.attached = false;
    throw new CommandRefused('domain_not_allowed');
  }

  /** URL d'onglet dans le domaine connecté et hors adresses privées ; `about:blank` (onglet neuf, vide) toléré. */
  #tabUrlAllowed(raw: string | undefined, domain: string): boolean {
    if (raw === undefined || raw === '') return false;
    if (raw === 'about:blank') return true;
    const url = commandUrl(raw, domain);
    return url !== null && checkHost(url.hostname).ok;
  }

  /**
   * Contrôle de l'onglet du run avant et après chaque commande (07 § 5, INV10, X3) : URL courante ET URL en cours de
   * chargement lues par `tabs.get` (aucune permission d'hôte requise, donc fiable même sur un autre site), puis
   * inspection de la page (défi). Fermé : onglet introuvable ou URL illisible = refus.
   */
  async #checkTab(session: RunSession, tabId: number, opts: { inspect: boolean } = { inspect: true }): Promise<void> {
    const tab = await this.#deps.browser.tabs.get(tabId);
    if (tab === null) {
      session.tabId = null;
      session.attached = false;
      throw new CommandRefused('tab_unavailable');
    }
    if (!this.#tabUrlAllowed(tab.url, session.domain) || (tab.pendingUrl !== undefined && tab.pendingUrl !== '' && !this.#tabUrlAllowed(tab.pendingUrl, session.domain))) {
      await this.#evict(session);
    }
    if (session.lastDocument !== null && session.lastDocument.url !== '' && !this.#tabUrlAllowed(session.lastDocument.url, session.domain)) await this.#evict(session);
    if (opts.inspect && tab.url !== 'about:blank') await this.#inspectForChallenge(session, tabId);
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
    // Page d'accueil du site : redirigée ailleurs, ou un défi, arrête tout avant la première requête de données.
    if (origin !== null) await this.#checkTab(session, tab.id);
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

  /**
   * Inspection de la page (défi) par la fonction empaquetée ; si `chrome.scripting` échoue (page d'erreur, onglet sur un
   * autre site), repli sur l'arbre d'accessibilité quand le débogueur est attaché. Rien de lisible : refus
   * (`tab_unavailable`), jamais « pas de défi ».
   */
  async #inspectForChallenge(session: RunSession, tabId: number): Promise<PageInspection> {
    const page = await this.#deps.browser.scripting.inspect(tabId).catch(() => null);
    if (page !== null) {
      if (!this.#tabUrlAllowed(page.url, session.domain)) await this.#evict(session);
      await this.#challenged(session, { url: page.url, title: page.title, text: page.text });
      return page;
    }
    if (session.attached) {
      const tree = (await this.#deps.browser.debugger.send(tabId, 'Accessibility.getFullAXTree', {}).catch(() => null)) as { nodes?: AxNode[] } | null;
      if (tree !== null && Array.isArray(tree.nodes)) {
        const text = renderAxTree(tree.nodes);
        const title = /^- RootWebArea "((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ?? '';
        const url = (await this.#deps.browser.tabs.get(tabId))?.url ?? '';
        await this.#challenged(session, { url, title, text });
        return { url, title, text };
      }
    }
    throw new CommandRefused('tab_unavailable');
  }

  // --- http_fetch / page_fetch --------------------------------------------------------------------------------------

  async #httpFetch(session: RunSession, args: FetchArgs): Promise<FetchResponse> {
    this.browserCalls += 1;
    const res = await this.#deps.browser.fetch(args.url, { method: args.method, headers: args.headers, ...(args.body === null ? {} : { body: args.body }) });
    // Redirection : jamais suivie (le saut suivant n'a pas été émis), rien n'est rendu.
    if (res.redirected) throw new CommandRefused('fetch_failed');
    this.#url(res.url || args.url, session.domain);
    const body = await res.text(args.max_bytes);
    if (body === null) throw new CommandRefused('response_too_large');
    const headers = Object.fromEntries(res.headers.map(([k, v]) => [k.toLowerCase(), v]));
    if (detectResponseChallenge({ status: res.status, headers, body, url: res.url })) await this.#lock(session);
    return { status: res.status, headers, body, url: res.url || args.url };
  }

  async #pageFetch(session: RunSession, args: FetchArgs): Promise<FetchResponse> {
    const url = new URL(args.url);
    const tabId = await this.#tab(session, url.origin);
    this.browserCalls += 1;
    const out = await this.#deps.browser.scripting.pageFetch(tabId, { url: args.url, method: args.method, headers: args.headers, body: args.body, maxBytes: args.max_bytes, maxMeta: MAX_META });
    if (out.kind === 'too_large') throw new CommandRefused('response_too_large');
    if (out.kind === 'error' || out.kind === 'redirect') throw new CommandRefused('fetch_failed');
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
    // Corps lu s'il est HTML ou si la réponse est une erreur, même en JSON (XHR DataDome : 403 + captcha-delivery.com).
    if (detectResponseChallenge({ status: out.status, headers, body: out.body, url: out.url })) await this.#lock(session);
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
        const p = params as { type?: string; frameId?: string; response?: { status?: number; headers?: Record<string, unknown>; url?: string } } | null;
        if (p?.type !== 'Document' || typeof p.response?.status !== 'number') return;
        if (session.mainFrameId !== null && p.frameId !== undefined && p.frameId !== session.mainFrameId) return; // iframe
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(p.response.headers ?? {})) if (typeof v === 'string') headers[k.toLowerCase()] = v;
        session.lastDocument = { status: p.response.status, headers, url: typeof p.response.url === 'string' ? p.response.url : '' };
      });
      await this.#deps.browser.debugger.send(tabId, 'Network.enable', {});
      await this.#deps.browser.debugger.send(tabId, 'Page.enable', {});
      const tree = (await this.#deps.browser.debugger.send(tabId, 'Page.getFrameTree', {}).catch(() => null)) as { frameTree?: { frame?: { id?: unknown } } } | null;
      session.mainFrameId = typeof tree?.frameTree?.frame?.id === 'string' ? tree.frameTree.frame.id : null;
      await this.#deps.browser.debugger.send(tabId, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => undefined);
    }
    return tabId;
  }

  /** Garde d'écriture d'un clic (07 § 5) : élément visé, ses ancêtres accessibles, bouton `type=submit`. */
  async #clickIsWrite(tabId: number, x: number, y: number): Promise<boolean> {
    const hit = (await this.#deps.browser.debugger.send(tabId, 'DOM.getNodeForLocation', { x, y, ignorePointerEventsNone: true }).catch(() => null)) as { backendNodeId?: number } | null;
    if (typeof hit?.backendNodeId !== 'number') return false;
    return this.#nodeIsWrite(tabId, { backendNodeId: hit.backendNodeId });
  }

  /**
   * L'activation de ce nœud est-elle une écriture ? Bouton d'envoi (`isWriteElement` : sans type ou `type=submit`, dans un
   * formulaire, il l'envoie) ou élément accessible au libellé d'écriture (lui ou ses ancêtres). Nœud illisible : écriture
   * (fermé).
   */
  async #nodeIsWrite(tabId: number, ref: { backendNodeId: number } | { nodeId: number }): Promise<boolean> {
    const send = this.#deps.browser.debugger.send;
    const described = (await send(tabId, 'DOM.describeNode', { ...ref, depth: 0 }).catch(() => null)) as { node?: { nodeName?: string; attributes?: string[]; backendNodeId?: number } } | null;
    if (described?.node === undefined) return true;
    if (isWriteElement(described.node)) return true;
    const tree = (await send(tabId, 'Accessibility.getPartialAXTree', { ...ref, fetchRelatives: true }).catch(() => null)) as { nodes?: AxNode[] } | null;
    return (tree?.nodes ?? []).some((n) => typeof n.role?.value === 'string' && typeof n.name?.value === 'string' && isWriteTarget({ role: n.role.value, name: n.name.value }));
  }

  /** Garde d'écriture de `page_script` (07 § 5, 08 § 4), fermée par défaut, appliquée par l'extension elle-même. */
  async #guardWrite(tabId: number, method: string, p: Record<string, unknown>): Promise<void> {
    // Entrée (soumission implicite) ou Espace (bouton focalisé), sous toutes leurs formes : refusées. Le texte se saisit
    // par `Input.insertText`, qui n'active rien.
    if (method === 'Input.dispatchKeyEvent' && isActivationKey(p)) throw new CommandRefused('write_action_blocked');
    if (method === 'DOM.focus') {
      const ref = typeof p['backendNodeId'] === 'number' ? { backendNodeId: p['backendNodeId'] } : typeof p['nodeId'] === 'number' ? { nodeId: p['nodeId'] } : null;
      if (ref === null || (await this.#nodeIsWrite(tabId, ref))) throw new CommandRefused('write_action_blocked');
    }
    if (method === 'Input.dispatchMouseEvent' && p['type'] === 'mousePressed') {
      if (typeof p['x'] !== 'number' || typeof p['y'] !== 'number' || (await this.#clickIsWrite(tabId, p['x'], p['y']))) throw new CommandRefused('write_action_blocked');
    }
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
      // Avant : l'onglet est toujours sur le domaine et sans défi (aucune commande sur un onglet de défi).
      await this.#checkTab(session, tabId);
      session.lastDocument = null;
      this.browserCalls += 1;
      const nav = (await this.#deps.browser.debugger.send(tabId, 'Page.navigate', { url: url.href })) as { frameId?: string; loaderId?: string; errorText?: string } | null;
      await this.#deps.browser.tabs.waitComplete(tabId, NAVIGATION_TIMEOUT_MS);
      // Après : URL finale (redirections serveur comprises) dans le domaine, document principal compris, puis défi.
      await this.#checkTab(session, tabId);
      const doc = session.lastDocument as RunSession['lastDocument'];
      await this.#challenged(session, { ...(doc === null ? {} : { status: doc.status, headers: doc.headers }) });
      const finalUrl = (await this.#deps.browser.tabs.get(tabId))?.url ?? url.href;
      return { frameId: nav?.frameId ?? null, loaderId: nav?.loaderId ?? null, errorText: nav?.errorText ?? null, status: doc?.status ?? 0, headers: doc?.headers ?? {}, url: finalUrl };
    }
    const tabId = await this.#attached(session, null);
    // Avant chaque commande : onglet dans le domaine, page sans défi.
    await this.#checkTab(session, tabId);
    if (!session.allowWriteActions) await this.#guardWrite(tabId, method as string, p);
    this.browserCalls += 1;
    const result = await this.#deps.browser.debugger.send(tabId, method as string, p);
    // Après : une commande qui peut naviguer (clic, touche, rechargement) est suivie d'une attente de chargement et d'une
    // inspection complète ; une lecture, d'un contrôle d'URL (navigation survenue pendant la lecture : rien n'est rendu).
    const mayNavigate = (method as string).startsWith('Input.') || method === 'Page.reload';
    if (mayNavigate) await this.#deps.browser.tabs.waitComplete(tabId, SETTLE_TIMEOUT_MS);
    await this.#checkTab(session, tabId, { inspect: mayNavigate });
    return result;
  }

  async #agentStep(session: RunSession, rawArgs: unknown): Promise<AgentStepWireResult> {
    const tabId = await this.#attached(session, null);
    // Avant chaque pas : onglet dans le domaine, page sans défi (l'exécuteur de pas observe ensuite l'arbre).
    await this.#checkTab(session, tabId);
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

