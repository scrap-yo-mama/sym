// SPDX-License-Identifier: AGPL-3.0-only
// Session réseau d'un essai : `direct` (N1), `dc_proxy` (N2) ou `res_proxy` (N3), toujours derrière la garde SSRF
// (INV10, 08b §1). Le proxy BYO est une destination contrôlée : sa connexion passe par une garde dédiée (résolution
// unique, adresse épinglée), qui ne déroge au privé que sur `allow_private_address` (admin). La cible reste
// contrôlée localement (schéma, port, résolution) à chaque connexion ; le proxy résout ensuite le nom lui-même,
// risque résiduel documenté (08 §2). Identifiants lus dans le dépôt de secrets, jamais journalisés (INV8).
import type { Socket } from 'node:net';
import { buildConnector, Pool, ProxyAgent, Socks5ProxyAgent, type Dispatcher, type RequestInit, type Response } from 'undici';
import { Secret, secretValues } from '../../crypto/index.js';
import { createGuardedConnector, createGuardedDispatcher, guardedFetch } from '../fetch.js';
import { createSsrfPolicy, SsrfGuard, type Resolver } from '../guard.js';
import { stripAddress } from '../ip.js';
import { NetworkConfigError, renderProxyUsername, type NetworkMode, type ProviderParams, type ProxyDefinition, type ProxyPrice } from './definitions.js';
import type { NetworkRung } from './ladder.js';

/** Lecture seule du dépôt de secrets (0.3a) : `secretStore(...)` de `@runtime/db` convient. */
export type SecretReader = { get(id: string): Promise<Secret> };

export type ProxyCredentials = { readonly username: Secret; readonly password: Secret };

/** Secret `kind = proxy` : JSON `{"username": "...", "password": "..."}`. Les valeurs rejoignent le registre de masquage. */
export async function loadProxyCredentials(reader: SecretReader, proxy: ProxyDefinition): Promise<ProxyCredentials | undefined> {
  if (proxy.credentialsSecretId === undefined) return undefined;
  const secret = await reader.get(proxy.credentialsSecretId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret.reveal());
  } catch {
    throw new NetworkConfigError(`proxy ${proxy.id} : secret d’identifiants illisible (JSON attendu)`);
  }
  const { username, password } = (parsed ?? {}) as { username?: unknown; password?: unknown };
  if (typeof username !== 'string' || username === '' || typeof password !== 'string') {
    throw new NetworkConfigError(`proxy ${proxy.id} : secret d’identifiants incomplet`);
  }
  secretValues.add(username);
  secretValues.add(password);
  return { username: new Secret(username), password: new Secret(password) };
}

const DEFAULT_PROXY_PORTS: Readonly<Record<string, number>> = { 'http:': 80, 'https:': 443, 'socks5:': 1080 };

/**
 * Garde propre au proxy (classe `operator-config`) : port du proxy seulement, privé refusé sauf dérogation admin
 * `allow_private_address` limitée à l'hôte du proxy. Le drapeau de test ne s'applique pas ici.
 */
export function proxyGuardFor(proxy: ProxyDefinition, resolver?: Resolver): SsrfGuard {
  const url = new URL(proxy.url);
  const host = stripAddress(url.hostname);
  const port = url.port === '' ? (DEFAULT_PROXY_PORTS[url.protocol] ?? 0) : Number(url.port);
  const policy = createSsrfPolicy({ allowedPrivateHosts: proxy.allowPrivateAddress ? [host] : [], allowedPorts: [port] });
  return new SsrfGuard({ policy, ...(resolver === undefined ? {} : { resolver }) });
}

export type NetworkUsage = {
  readonly mode: NetworkMode;
  readonly proxyId: string | null;
  /** Octets émis et reçus sur les connexions au proxy (0 en `direct`). */
  readonly bytes: number;
  readonly requests: number;
  /** Coût imputé au run : octets × prix au Go + requêtes × prix par requête (6 décimales, comme `runs.cost_proxy_usd`). */
  readonly costUsd: number;
};

export function proxyCostUsd(price: ProxyPrice, bytes: number, requests: number): number {
  const raw = (bytes * price.perGbUsd) / 1e9 + requests * price.perRequestUsd;
  return Math.round(raw * 1e6) / 1e6;
}

/** Compteur d'octets des sockets ouverts par un connecteur (sockets fermés + sockets vivants). */
class ByteMeter {
  #closed = 0;
  readonly #live = new Set<Socket>();

  wrap(connector: buildConnector.connector): buildConnector.connector {
    return (options, callback) =>
      connector(options, (...args) => {
        const [error, socket] = args;
        if (error === null) {
          this.#live.add(socket);
          socket.once('close', () => {
            this.#closed += socket.bytesRead + socket.bytesWritten;
            this.#live.delete(socket);
          });
          callback(null, socket);
        } else {
          callback(error, null);
        }
      });
  }

  get bytes(): number {
    let live = 0;
    for (const s of this.#live) live += s.bytesRead + s.bytesWritten;
    return this.#closed + live;
  }
}

export type NetworkSessionOptions = {
  readonly rung: NetworkRung;
  /** Garde des cibles (politique `untrusted-target`). */
  readonly guard: SsrfGuard;
  /** Identifiants du proxy (`loadProxyCredentials`), si le proxy en exige. */
  readonly credentials?: ProxyCredentials;
  /** Résolveur de la garde du proxy (tests). */
  readonly proxyResolver?: Resolver;
  readonly connectTimeoutMs?: number;
};

type FetchInit = Parameters<typeof guardedFetch>[1];

export type NetworkSession = {
  readonly mode: NetworkMode;
  readonly proxyId: string | null;
  readonly dispatcher: Dispatcher;
  /** fetch sous garde (redirections recontrôlées, 5 sauts au plus) via le niveau de la session. */
  fetch(input: string | URL, init?: FetchInit): Promise<Response>;
  usage(): NetworkUsage;
  close(): Promise<void>;
};

/** Contrôle local de la cible avant chaque connexion tunnelée (refus précoce ; le proxy résout ensuite). */
function checkTargetFirst(guard: SsrfGuard, connect: buildConnector.connector): buildConnector.connector {
  return (options, callback) => {
    const host = stripAddress(options.hostname);
    const port = options.port === '' ? (options.protocol === 'https:' ? 443 : 80) : Number(options.port);
    guard.resolve(host, port).then(
      () => connect(options, callback),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), null),
    );
  };
}

function proxyDispatcher(
  proxy: ProxyDefinition,
  params: ProviderParams,
  options: NetworkSessionOptions,
  meter: ByteMeter,
): Dispatcher {
  const timeout = options.connectTimeoutMs ?? 10_000;
  const proxyConnector = meter.wrap(
    createGuardedConnector(proxyGuardFor(proxy, options.proxyResolver), buildConnector({ timeout })),
  );
  const creds = options.credentials;
  const username = creds === undefined ? undefined : renderProxyUsername(proxy.usernameTemplate, creds.username.reveal(), params);
  if (username !== undefined) secretValues.add(username);
  const url = new URL(proxy.url);

  if (url.protocol === 'socks5:') {
    return new Socks5ProxyAgent(proxy.url, {
      connect: proxyConnector,
      connectTimeout: timeout,
      ...(creds === undefined || username === undefined ? {} : { username, password: creds.password.reveal() }),
    });
  }

  let token: string | undefined;
  if (creds !== undefined && username !== undefined) {
    token = `Basic ${Buffer.from(`${username}:${creds.password.reveal()}`).toString('base64')}`;
    secretValues.add(token);
  }
  return new ProxyAgent({
    uri: proxy.url,
    ...(token === undefined ? {} : { token }),
    // Toujours CONNECT, y compris pour http : une seule voie, celle dont la connexion au proxy est gardée.
    proxyTunnel: true,
    connectTimeout: timeout,
    clientFactory: (origin, opts) => new Pool(origin, { ...opts, connect: proxyConnector }),
    factory: (origin, opts) => {
      const connect = (opts as Pool.Options).connect;
      if (typeof connect !== 'function') throw new NetworkConfigError('connecteur de tunnel inattendu');
      return new Pool(origin, { ...opts, connect: checkTargetFirst(options.guard, connect) });
    },
  });
}

/**
 * Ouvre la session réseau d'un essai. Aucune connexion n'est ouverte avant le premier fetch. À fermer en fin
 * d'essai (`close`), puis imputer `usage().costUsd` au run.
 */
export function openNetworkSession(options: NetworkSessionOptions): NetworkSession {
  const { rung, guard } = options;
  const meter = new ByteMeter();
  let requests = 0;
  const base: Dispatcher =
    rung.mode === 'direct'
      ? createGuardedDispatcher(guard, options.connectTimeoutMs)
      : proxyDispatcher(rung.proxy, rung.params, options, meter);
  // Une requête = un envoi par le dispatcher (chaque saut de redirection compte).
  const dispatcher = base.compose((dispatch) => (opts, handler) => {
    requests += 1;
    return dispatch(opts, handler);
  });
  const proxyId = rung.mode === 'direct' ? null : rung.proxy.id;
  const price = rung.mode === 'direct' ? undefined : rung.proxy.price;
  return {
    mode: rung.mode,
    proxyId,
    dispatcher,
    fetch: (input, init = {}) => guardedFetch(input, init as Omit<RequestInit, 'dispatcher' | 'redirect'>, { guard, dispatcher }),
    usage: () => {
      const bytes = meter.bytes;
      return { mode: rung.mode, proxyId, bytes, requests, costUsd: price === undefined ? 0 : proxyCostUsd(price, bytes, requests) };
    },
    close: () => base.close(),
  };
}

/** Coût proxy cumulé d'un run (`runs.cost_proxy_usd`), essai par essai. */
export class RunProxyCost {
  readonly #entries: NetworkUsage[] = [];
  add(usage: NetworkUsage): void {
    this.#entries.push(usage);
  }
  get entries(): readonly NetworkUsage[] {
    return [...this.#entries];
  }
  get totalUsd(): number {
    return Math.round(this.#entries.reduce((sum, u) => sum + u.costUsd, 0) * 1e6) / 1e6;
  }
  get totalBytes(): number {
    return this.#entries.reduce((sum, u) => sum + u.bytes, 0);
  }
}
