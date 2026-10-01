// SPDX-License-Identifier: AGPL-3.0-only
// Egress du contexte Chromium d'un run (tâche 1.6, 08b §1) : un proxy d'egress local par essai, sur le barreau réseau de
// l'essai. `direct` : la garde résout et se connecte à l'adresse validée. `dc_proxy` / `res_proxy` : la garde contrôle la
// cible, puis le tunnel passe par le proxy BYO de l'admin (`createUpstreamDialer`). Le coût proxy du run se calcule sur
// les octets échangés avec le proxy, comme la couche fetch (1.4). Aucun argument de proxy ne vient d'une stratégie,
// d'un prompt ou d'un membre : seulement du barreau (`NetworkRung`) construit depuis la configuration de l'admin.
// Verrou de domaines (`allowedHosts`) : appliqué ici à chaque demande (redirections, sous-ressources, WebSocket,
// `APIRequestContext`), ce que `context.route` ne voit pas toujours ; chaque refus est signalé aux abonnés
// (`onDomainBlocked`, E3 en script : guet du bac à sable). Plafond `max_cost_usd` (`costCeiling`) : nouveau tunnel
// refusé quand le coût projeté dépasserait le plafond ; en cours de tunnel (prix au Go), le budget d'octets restant est
// contrôlé à chaque bloc reçu (marge d'un bloc de lecture) et tout est coupé avant de le dépasser.
import { startEgressProxy, type EgressTarget } from '../egress-proxy.js';
import type { SsrfDenyDetail } from '../guard.js';
import type { NetworkMode } from './definitions.js';
import { COST_BYTE_MARGIN, proxyCostUsd, wouldExceed, type CostCeiling, type NetworkSessionOptions, type NetworkUsage } from './session.js';
import { createUpstreamDialer } from './upstream.js';

export type BrowserEgress = {
  readonly mode: NetworkMode;
  readonly proxyId: string | null;
  /** `http://127.0.0.1:PORT` : seule valeur passée à `browser.newContext({ proxy })` et à `request.newContext({ proxy })`. */
  readonly server: string;
  /** Refus de la garde vus par ce proxy (détail réservé au journal admin). */
  readonly blocked: readonly SsrfDenyDetail[];
  /** Demandes refusées par le verrou de domaines (hôte normalisé, jamais l'URL ; 100 premières). */
  readonly domainBlocked: readonly EgressTarget[];
  /** Nombre total de refus du verrou de domaines (non plafonné). */
  domainBlockedCount(): number;
  /** Abonnement aux refus du verrou de domaines ; rend la fonction de désabonnement. */
  onDomainBlocked(listener: (target: EgressTarget) => void): () => void;
  /** Le plafond de coût a refusé ou coupé du trafic. */
  budgetExceeded(): boolean;
  usage(): NetworkUsage;
  close(): Promise<void>;
};

export type BrowserEgressOptions = NetworkSessionOptions & {
  readonly idleTimeoutMs?: number;
  /** Période du contrôle de secours du coût en cours de tunnel (prix au Go), en ms (défaut 250). */
  readonly costWatchMs?: number;
};

export async function openBrowserEgress(options: BrowserEgressOptions): Promise<BrowserEgress> {
  const { rung, guard } = options;
  const blocked: SsrfDenyDetail[] = [];
  const domainBlocked: EgressTarget[] = [];
  let domainBlockedTotal = 0;
  const listeners = new Set<(target: EgressTarget) => void>();
  const ceiling: CostCeiling | undefined = options.costCeiling;
  let exceeded = false;
  /** Coupure de tout le trafic de l'essai, branchée une fois le proxy démarré. */
  const cutter: { cut?: () => void } = {};
  const price = rung.mode === 'direct' ? undefined : rung.proxy.price;
  /** Coût marge comprise au-delà du plafond : tout est coupé (contrôle par octets et contrôle périodique de secours). */
  const checkBytes = () => {
    if (exceeded || ceiling === undefined || dialer === undefined || price === undefined) return;
    const { bytes, tunnels } = dialer.usage();
    if (proxyCostUsd(price, bytes + COST_BYTE_MARGIN, tunnels) + (ceiling.otherUsd?.() ?? 0) > ceiling.maxUsd) {
      exceeded = true;
      cutter.cut?.();
    }
  };
  const dialer =
    rung.mode === 'direct'
      ? undefined
      : createUpstreamDialer({
          proxy: rung.proxy,
          params: rung.params,
          ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
          ...(options.proxyResolver === undefined ? {} : { proxyResolver: options.proxyResolver }),
          ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
          ...(ceiling === undefined ? {} : { onTraffic: () => checkBytes() }),
        });
  const admit =
    ceiling === undefined || dialer === undefined
      ? undefined
      : () => {
          const { bytes, tunnels } = dialer.usage();
          if (exceeded || wouldExceed(ceiling, price, bytes, tunnels)) exceeded = true;
          return !exceeded;
        };
  const proxy = await startEgressProxy({
    guard,
    onBlocked: (detail) => blocked.push(detail),
    ...(dialer === undefined ? {} : { upstream: (host: string, port: number) => dialer.dial(host, port) }),
    ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    ...(options.allowedHosts === undefined
      ? {}
      : {
          allowHosts: options.allowedHosts,
          onDomainBlocked: (t: EgressTarget) => {
            domainBlockedTotal += 1;
            if (domainBlocked.length < 100) domainBlocked.push(t);
            for (const listener of [...listeners]) listener(t);
          },
        }),
    ...(admit === undefined ? {} : { admit }),
  });
  cutter.cut = () => proxy.abortAll();
  // Secours du contrôle par octets (envois de Chromium, coût engagé ailleurs dans l'essai) : contrôle périodique.
  const watch = ceiling === undefined || dialer === undefined ? undefined : setInterval(checkBytes, options.costWatchMs ?? 250);
  watch?.unref();
  const proxyId = rung.mode === 'direct' ? null : rung.proxy.id;
  return {
    mode: rung.mode,
    proxyId,
    server: proxy.url,
    blocked,
    domainBlocked,
    domainBlockedCount: () => domainBlockedTotal,
    onDomainBlocked: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    budgetExceeded: () => exceeded,
    usage: () => {
      if (rung.mode === 'direct' || dialer === undefined) return { mode: rung.mode, proxyId, bytes: 0, requests: proxy.requests(), costUsd: 0 };
      const { bytes, tunnels } = dialer.usage();
      return { mode: rung.mode, proxyId, bytes, requests: tunnels, costUsd: proxyCostUsd(rung.proxy.price, bytes, tunnels) };
    },
    close: () => {
      if (watch !== undefined) clearInterval(watch);
      return proxy.close();
    },
  };
}
