// SPDX-License-Identifier: AGPL-3.0-only
// Egress du contexte Chromium d'un run (tâche 1.6, 08b §1) : un proxy d'egress local par essai, sur le barreau réseau de
// l'essai. `direct` : la garde résout et se connecte à l'adresse validée. `dc_proxy` / `res_proxy` : la garde contrôle la
// cible, puis le tunnel passe par le proxy BYO de l'admin (`createUpstreamDialer`). Le coût proxy du run se calcule sur
// les octets échangés avec le proxy, comme la couche fetch (1.4). Aucun argument de proxy ne vient d'une stratégie,
// d'un prompt ou d'un membre : seulement du barreau (`NetworkRung`) construit depuis la configuration de l'admin.
// Verrou de domaines (`allowedHosts`) : appliqué ici à chaque demande (redirections, sous-ressources, WebSocket,
// `APIRequestContext`), ce que `context.route` ne voit pas toujours. Plafond `max_cost_usd` (`costCeiling`) : nouveau
// tunnel refusé quand le coût projeté dépasserait le plafond ; au-delà en cours de tunnel (prix au Go), tout est coupé.
import { startEgressProxy, type EgressTarget } from '../egress-proxy.js';
import type { SsrfDenyDetail } from '../guard.js';
import type { NetworkMode } from './definitions.js';
import { proxyCostUsd, wouldExceed, type CostCeiling, type NetworkSessionOptions, type NetworkUsage } from './session.js';
import { createUpstreamDialer } from './upstream.js';

export type BrowserEgress = {
  readonly mode: NetworkMode;
  readonly proxyId: string | null;
  /** `http://127.0.0.1:PORT` : seule valeur passée à `browser.newContext({ proxy })` et à `request.newContext({ proxy })`. */
  readonly server: string;
  /** Refus de la garde vus par ce proxy (détail réservé au journal admin). */
  readonly blocked: readonly SsrfDenyDetail[];
  /** Demandes refusées par le verrou de domaines (hôte normalisé, jamais l'URL). */
  readonly domainBlocked: readonly EgressTarget[];
  /** Le plafond de coût a refusé ou coupé du trafic. */
  budgetExceeded(): boolean;
  usage(): NetworkUsage;
  close(): Promise<void>;
};

export type BrowserEgressOptions = NetworkSessionOptions & {
  readonly idleTimeoutMs?: number;
  /** Période du contrôle du coût en cours de tunnel (prix au Go), en ms (défaut 250). */
  readonly costWatchMs?: number;
};

export async function openBrowserEgress(options: BrowserEgressOptions): Promise<BrowserEgress> {
  const { rung, guard } = options;
  const blocked: SsrfDenyDetail[] = [];
  const domainBlocked: EgressTarget[] = [];
  const dialer =
    rung.mode === 'direct'
      ? undefined
      : createUpstreamDialer({
          proxy: rung.proxy,
          params: rung.params,
          ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
          ...(options.proxyResolver === undefined ? {} : { proxyResolver: options.proxyResolver }),
          ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
        });
  const price = rung.mode === 'direct' ? undefined : rung.proxy.price;
  const ceiling: CostCeiling | undefined = options.costCeiling;
  let exceeded = false;
  const costNow = (): number => {
    if (dialer === undefined || price === undefined) return 0;
    const { bytes, tunnels } = dialer.usage();
    return proxyCostUsd(price, bytes, tunnels);
  };
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
      : { allowHosts: options.allowedHosts, onDomainBlocked: (t: EgressTarget) => void (domainBlocked.length < 100 && domainBlocked.push(t)) }),
    ...(admit === undefined ? {} : { admit }),
  });
  // Prix au Go : un tunnel ouvert peut dépasser le plafond sans nouvelle demande ; contrôle périodique, coupure franche.
  const watch =
    ceiling === undefined || dialer === undefined
      ? undefined
      : setInterval(() => {
          if (costNow() + (ceiling.otherUsd?.() ?? 0) > ceiling.maxUsd && !exceeded) {
            exceeded = true;
            proxy.abortAll();
          }
        }, options.costWatchMs ?? 250);
  watch?.unref();
  const proxyId = rung.mode === 'direct' ? null : rung.proxy.id;
  return {
    mode: rung.mode,
    proxyId,
    server: proxy.url,
    blocked,
    domainBlocked,
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
