// SPDX-License-Identifier: AGPL-3.0-only
// Egress distant du fournisseur `sym-browser` (tâche 4.3 ; cdc/sym-browser 04e §3) : la politique d'egress de chaque essai
// devient la politique de la session distante.
// - `toEgressPolicy` : fonction pure, une ligne de 04e §3.1 par champ (verrou de domaines, barreau réseau, plafond de coût,
//   ports de la garde) ;
// - `openRemoteEgress` : `BrowserEgress` sans proxy local (`server: null`). `attach(browser)` pose la politique par
//   `PUT /v1/sessions/{id}/egress` et suit les événements SSE de la session (`egress.blocked` → `onDomainBlocked` ou `blocked`,
//   `egress.budget_exceeded` → `budgetExceeded()`) ; `settle()` relit l'état final de l'époque (`usage()`, coût par
//   `proxyCostUsd` côté worker) ; `close()` le relit une dernière fois puis referme la politique (`allowedHosts: []`).
// La garde SSRF du nœud (INV10) et le verrou de domaines restent ceux de la session : rien n'est affaibli, les requêtes de Node
// (E1, robots.txt) gardent l'egress local du worker.
import type { Secret } from '@runtime/core';
import { COST_BYTE_MARGIN, proxyCostUsd, renderProxyUsername, type BrowserEgressOptions, type EgressTarget, type NetworkUsage, type SsrfDenyDetail, type SsrfDenyReason } from '@runtime/core/net';
import type { EgressBlockReason, EgressPolicy, EgressState, SessionEvent, UpstreamProxy } from '@sym/contracts/browser';
import type { SymBrowser } from '@sym-browser/sdk';
import type { Browser } from 'playwright-core';
import type { RunEgress } from './run-egress.js';

const DEFAULT_PROXY_PORTS: Readonly<Record<string, number>> = { http: 80, https: 443, socks5: 1080 };
/** Politique d'une session sans trafic admis : l'egress du nœud est fermé entre deux essais. */
const CLOSED_POLICY: EgressPolicy = { allowedHosts: [] };
/** Entrées gardées de `domainBlocked` (comme l'egress local). */
const DOMAIN_BLOCKED_KEPT = 100;
/** Tolérance d'horloge entre le worker et le nœud pour écarter le rejeu de l'histoire d'une session partagée. */
const EVENT_CLOCK_SLACK_MS = 250;

/** Lecture d'un secret du dépôt de SYM au moment de l'essai (défaut : `reveal`). */
export type ResolveSecret = (secret: Secret) => string;

/**
 * Politique d'egress de l'essai pour la session distante (04e §3.1). `dnsViaProxy` n'est pas posé : avec un proxy amont le nœud
 * résout par le proxy (défaut `true`), comme le proxy local qui laisse le proxy BYO résoudre le nom (08 §2). Le prix par requête
 * du proxy n'a pas d'équivalent en octets : le budget ne porte que sur le prix au Go.
 */
export function toEgressPolicy(options: BrowserEgressOptions, resolveSecret: ResolveSecret = (secret) => secret.reveal()): EgressPolicy {
  const policy: EgressPolicy = {};
  if (options.allowedHosts !== undefined || options.allowedHostSuffixes !== undefined) {
    policy.allowedHosts = [...(options.allowedHosts ?? []), ...(options.allowedHostSuffixes ?? []).map((suffix) => `*.${suffix}`)];
  }
  policy.ports = [...options.guard.policy.allowedPorts];
  const { rung } = options;
  if (rung.mode !== 'direct') {
    const url = new URL(rung.proxy.url);
    const type = url.protocol.slice(0, -1) as UpstreamProxy['type'];
    const upstream: UpstreamProxy = {
      type,
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port === '' ? (DEFAULT_PROXY_PORTS[type] ?? 0) : Number(url.port),
    };
    if (options.credentials !== undefined) {
      upstream.username = renderProxyUsername(rung.proxy.usernameTemplate, resolveSecret(options.credentials.username), rung.params);
      upstream.password = resolveSecret(options.credentials.password);
    }
    policy.upstream = upstream;
    const perGb = rung.proxy.price.perGbUsd;
    if (options.costCeiling !== undefined && perGb > 0) {
      const left = options.costCeiling.maxUsd - (options.costCeiling.otherUsd?.() ?? 0);
      policy.budgetBytes = Math.max(0, Math.floor((left / perGb) * 1e9) - COST_BYTE_MARGIN);
    }
  }
  return policy;
}

/** Part du SDK que l'egress utilise (les tests en fournissent une doublure). */
export type RemoteEgressClient = { sessions: { egress: Pick<SymBrowser['sessions']['egress'], 'put' | 'get'> }; events: SymBrowser['events'] };

export type RemoteEgressContext = {
  readonly client: RemoteEgressClient;
  /** Identifiant de la session SYM Browser d'un `Browser` ouvert par le fournisseur. */
  readonly sessionOf: (browser: Browser) => string | undefined;
  /** Lecture des secrets (défaut : `reveal`). */
  readonly resolveSecret?: ResolveSecret;
};

export type RemoteEgress = RunEgress & {
  readonly server: null;
  attach(browser: Browser): Promise<void>;
  settle(): Promise<void>;
  readonly policy: EgressPolicy;
};

/** Motif de refus du nœud converti en motif de garde SSRF du journal admin ; les autres ne sont pas des refus de la garde. */
const DENY_REASON: Partial<Record<EgressBlockReason, SsrfDenyReason>> = { address_not_public: 'private', port_not_allowed: 'port', unresolvable: 'unresolvable' };

export async function openRemoteEgress(context: RemoteEgressContext, options: BrowserEgressOptions): Promise<RemoteEgress> {
  const { client } = context;
  const { rung } = options;
  const policy = toEgressPolicy(options, context.resolveSecret);
  const blocked: SsrfDenyDetail[] = [];
  const domainBlocked: EgressTarget[] = [];
  let domainBlockedTotal = 0;
  const listeners = new Set<(target: EgressTarget) => void>();
  let exceeded = false;
  let state: EgressState | undefined;
  let sessionId: string | undefined;
  let stream: AbortController | undefined;
  let closed = false;

  const onEvent = (event: SessionEvent, since: number): void => {
    if (Date.parse(event.at) < since) return;
    if (event.type === 'egress.budget_exceeded') {
      exceeded = true;
      return;
    }
    if (event.type !== 'egress.blocked') return;
    const { host, reason, port, count } = event.data;
    if (reason === 'domain_not_allowed') {
      domainBlockedTotal += Math.max(1, count);
      const target: EgressTarget = { host, port: port ?? 443, via: 'connect' };
      if (domainBlocked.length < DOMAIN_BLOCKED_KEPT) domainBlocked.push(target);
      for (const listener of [...listeners]) listener(target);
      return;
    }
    const deny = DENY_REASON[reason];
    if (deny !== undefined) blocked.push({ reason: deny, host, ...(port === undefined ? {} : { port }) });
  };

  const settle = async (): Promise<void> => {
    if (sessionId === undefined) return;
    try {
      state = await client.sessions.egress.get(sessionId);
      if (state.budgetExceeded) exceeded = true;
    } catch {
      // Session libérée ou nœud injoignable : dernier état connu.
    }
  };

  const egress: Omit<RemoteEgress, 'policy'> = {
    mode: rung.mode,
    proxyId: rung.mode === 'direct' ? null : rung.proxy.id,
    server: null,
    blocked,
    domainBlocked,
    domainBlockedCount: () => domainBlockedTotal,
    onDomainBlocked: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    budgetExceeded: () => exceeded,
    usage: (): NetworkUsage => {
      const requests = state?.requests ?? 0;
      if (rung.mode === 'direct') return { mode: 'direct', proxyId: null, bytes: 0, requests, costUsd: 0 };
      const bytes = (state?.bytesIn ?? 0) + (state?.bytesOut ?? 0);
      return { mode: rung.mode, proxyId: rung.proxy.id, bytes, requests, costUsd: proxyCostUsd(rung.proxy.price, bytes, requests) };
    },
    attach: async (browser) => {
      const id = context.sessionOf(browser);
      if (id === undefined) throw new Error("egress distant : ce navigateur n'est pas une session du fournisseur sym-browser");
      const since = Date.now() - EVENT_CLOCK_SLACK_MS;
      await client.sessions.egress.put(id, policy);
      sessionId = id;
      closed = false;
      stream = new AbortController();
      const signal = stream.signal;
      void (async () => {
        try {
          for await (const event of client.events(id, { signal })) onEvent(event, since);
        } catch {
          // Flux coupé : l'état final relu par `settle` reste la source du dépassement de budget.
        }
      })();
    },
    settle,
    close: async () => {
      if (closed || sessionId === undefined) return;
      closed = true;
      await settle();
      stream?.abort();
      await client.sessions.egress.put(sessionId, CLOSED_POLICY).catch(() => undefined);
    },
  };
  // Le mot de passe du proxy amont ne se lit que par `policy` ; jamais énumérable (journaux, sérialisation).
  Object.defineProperty(egress, 'policy', { value: policy, enumerable: false });
  return egress as RemoteEgress;
}

