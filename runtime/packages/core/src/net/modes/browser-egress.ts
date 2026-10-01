// SPDX-License-Identifier: AGPL-3.0-only
// Egress du contexte Chromium d'un run (tâche 1.6, 08b §1) : un proxy d'egress local par essai, sur le barreau réseau de
// l'essai. `direct` : la garde résout et se connecte à l'adresse validée. `dc_proxy` / `res_proxy` : la garde contrôle la
// cible, puis le tunnel passe par le proxy BYO de l'admin (`createUpstreamDialer`). Le coût proxy du run se calcule sur
// les octets échangés avec le proxy, comme la couche fetch (1.4). Aucun argument de proxy ne vient d'une stratégie,
// d'un prompt ou d'un membre : seulement du barreau (`NetworkRung`) construit depuis la configuration de l'admin.
import { startEgressProxy } from '../egress-proxy.js';
import type { SsrfDenyDetail } from '../guard.js';
import type { NetworkMode } from './definitions.js';
import { proxyCostUsd, type NetworkSessionOptions, type NetworkUsage } from './session.js';
import { createUpstreamDialer } from './upstream.js';

export type BrowserEgress = {
  readonly mode: NetworkMode;
  readonly proxyId: string | null;
  /** `http://127.0.0.1:PORT` : seule valeur passée à `browser.newContext({ proxy })` et à `request.newContext({ proxy })`. */
  readonly server: string;
  /** Refus de la garde vus par ce proxy (détail réservé au journal admin). */
  readonly blocked: readonly SsrfDenyDetail[];
  usage(): NetworkUsage;
  close(): Promise<void>;
};

export type BrowserEgressOptions = NetworkSessionOptions & { readonly idleTimeoutMs?: number };

export async function openBrowserEgress(options: BrowserEgressOptions): Promise<BrowserEgress> {
  const { rung, guard } = options;
  const blocked: SsrfDenyDetail[] = [];
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
  const proxy = await startEgressProxy({
    guard,
    onBlocked: (detail) => blocked.push(detail),
    ...(dialer === undefined ? {} : { upstream: (host: string, port: number) => dialer.dial(host, port) }),
    ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
  });
  const proxyId = rung.mode === 'direct' ? null : rung.proxy.id;
  return {
    mode: rung.mode,
    proxyId,
    server: proxy.url,
    blocked,
    usage: () => {
      if (rung.mode === 'direct' || dialer === undefined) return { mode: rung.mode, proxyId, bytes: 0, requests: proxy.requests(), costUsd: 0 };
      const { bytes, tunnels } = dialer.usage();
      return { mode: rung.mode, proxyId, bytes, requests: tunnels, costUsd: proxyCostUsd(rung.proxy.price, bytes, tunnels) };
    },
    close: () => proxy.close(),
  };
}
