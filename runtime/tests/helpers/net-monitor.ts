// SPDX-License-Identifier: AGPL-3.0-only
// Compteur réseau du processus Node (tâche 2.4, repris du spike 0.6a, eval/spike/src/guards.ts) : chaque requête HTTP
// sortante de Node (undici pour `fetch`, `http.client` pour node:http) est consignée par `diagnostics_channel`, avec son
// hôte. Sert à prouver que le moteur de production (Stagehand) ne contacte ni Browserbase, ni Brave, ni aucun hôte hors
// de la boucle locale (faux fournisseur, fixtures, proxy d'egress) : ADR 0001, obligation de la tâche 2.4.
import { subscribe, unsubscribe } from 'node:diagnostics_channel';

interface NetEvent {
  readonly host: string;
  readonly channel: 'undici' | 'http';
  readonly allowed: boolean;
}

export interface NetMonitor {
  readonly events: readonly NetEvent[];
  /** Requêtes hors boucle locale (et hors `allowedHosts`). */
  offsite(): NetEvent[];
  stop(): void;
}

const LOCAL = /^(127\.0\.0\.1|localhost|\[?::1\]?|[a-z0-9_.-]+\.localhost)$/i;

export function startNetMonitor(allowedHosts: readonly string[] = []): NetMonitor {
  const events: NetEvent[] = [];
  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));
  const record = (channel: NetEvent['channel'], rawHost: string | undefined): void => {
    const host = (rawHost ?? '').toLowerCase().replace(/:\d+$/, '');
    events.push({ host, channel, allowed: LOCAL.test(host) || allowed.has(host) });
  };
  const onUndici = (message: unknown): void => {
    const origin = (message as { request?: { origin?: string | URL } }).request?.origin;
    let host: string | undefined;
    try {
      host = origin === undefined ? undefined : new URL(String(origin)).host;
    } catch {
      host = String(origin);
    }
    record('undici', host);
  };
  const onHttp = (message: unknown): void => {
    const request = (message as { request?: { host?: string; getHeader?: (n: string) => unknown } }).request;
    const header = request?.getHeader?.('host');
    record('http', request?.host ?? (typeof header === 'string' ? header : undefined));
  };
  subscribe('undici:request:create', onUndici);
  subscribe('http.client.request.start', onHttp);
  return {
    events,
    offsite: () => events.filter((e) => !e.allowed),
    stop: () => {
      unsubscribe('undici:request:create', onUndici);
      unsubscribe('http.client.request.start', onHttp);
    },
  };
}
