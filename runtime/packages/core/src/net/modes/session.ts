// SPDX-License-Identifier: AGPL-3.0-only
// Session réseau d'un essai : `direct` (N1), `dc_proxy` (N2) ou `res_proxy` (N3), toujours derrière la garde SSRF
// (INV10, 08b §1). Le proxy BYO est une destination contrôlée : sa connexion passe par une garde dédiée (résolution
// unique, adresse épinglée), qui ne déroge au privé que sur `allow_private_address` (admin). La cible reste
// contrôlée localement (schéma, port, résolution) à chaque connexion ; le proxy résout ensuite le nom lui-même,
// risque résiduel documenté (08 §2). Identifiants lus dans le dépôt de secrets, jamais journalisés (INV8).
import type { Socket } from 'node:net';
import { buildConnector, Headers, Pool, ProxyAgent, Socks5ProxyAgent, type Dispatcher, type RequestInit, type Response } from 'undici';
import { ENGINE_ACCEPT_LANGUAGE } from '../../access/identity.js';
import { Secret, secretValues } from '../../crypto/index.js';
import { createGuardedConnector, createGuardedDispatcher, guardedFetch } from '../fetch.js';
import { domainLock } from '../domain-lock.js';
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

/**
 * Plafond `max_cost_usd` atteint PENDANT le run (04b §3, « arrêt run_budget_exceeded, coût imputé ≤ plafond ») : une
 * nouvelle requête (ou un nouveau tunnel) n'est envoyée que si le coût projeté reste sous le plafond.
 */
export class ProxyBudgetExceededError extends Error {
  readonly code = 'run_budget_exceeded';
  constructor() {
    super('run_budget_exceeded');
    this.name = 'ProxyBudgetExceededError';
  }
}

/**
 * Marge du contrôle par octets du plafond de coût (prix au Go) : au plus deux lectures de socket (64 Kio chacune) entre
 * deux contrôles. Le transfert est coupé dès que le coût, marge comprise, dépasserait le plafond : le coût imputé reste
 * sous lui.
 */
export const COST_BYTE_MARGIN = 128 * 1024;

/** Plafond de coût proxy d'un essai. `otherUsd` : coût déjà engagé ailleurs dans le même essai (egress Chromium). */
export type CostCeiling = { readonly maxUsd: number; readonly otherUsd?: () => number };

/** Vrai si une requête de plus (prix par requête, octets déjà comptés) dépasserait le plafond. */
export function wouldExceed(ceiling: CostCeiling | undefined, price: ProxyPrice | undefined, bytes: number, requests: number): boolean {
  if (ceiling === undefined || price === undefined) return false;
  return proxyCostUsd(price, bytes, requests + 1) + (ceiling.otherUsd?.() ?? 0) > ceiling.maxUsd;
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
  /** Verrou de domaines de l'essai (`allowed_hosts`) : chaque saut de redirection est contrôlé (tâche 1.6). */
  readonly allowedHosts?: readonly string[];
  /**
   * Portées de site admises en plus d'`allowedHosts` (le domaine et ses sous-domaines), posées par le code de la
   * reconnaissance de l'enquête seulement (2.1, 04b §2), jamais tirées d'une stratégie ; sans `allowedHosts`, ignorées.
   */
  readonly allowedHostSuffixes?: readonly string[];
  /** Plafond `max_cost_usd` de l'API, contrôlé avant chaque requête (tâche 1.6). */
  readonly costCeiling?: CostCeiling;
  /**
   * Module d'accès (tâche 1.11) : contrôle robots.txt de chaque saut avant connexion (`AccessRefusedError` pour refuser).
   * Absent seulement pour la session qui lit robots.txt elle-même.
   */
  readonly checkUrl?: (url: URL) => Promise<void>;
  /**
   * User-Agent du robot (`buildUserAgent` : celui du moteur embarqué, plus le jeton si `identify_instance`), imposé à
   * chaque requête : une stratégie ne le remplace jamais (X2). Avec lui, `Accept` et `Accept-Language` standard d'un
   * navigateur quand la requête n'en pose pas.
   */
  readonly userAgent?: string;
  /** En-tête `From` (RFC 9110 §10.1.2) imposé à chaque requête : contact d'instance, si `identify_instance` est activé. */
  readonly from?: string;
};

type FetchInit = Parameters<typeof guardedFetch>[1];

export type NetworkSession = {
  readonly mode: NetworkMode;
  readonly proxyId: string | null;
  readonly dispatcher: Dispatcher;
  /** fetch sous garde (redirections recontrôlées, 5 sauts au plus) via le niveau de la session. */
  fetch(input: string | URL, init?: FetchInit, options?: { readonly followRedirects?: boolean }): Promise<Response>;
  usage(): NetworkUsage;
  /** Une requête a été refusée par le plafond de coût. */
  budgetExceeded(): boolean;
  /**
   * `Accept-Language` RÉELLEMENT envoyé par la dernière requête partie (relevé au dernier moment, dans le dispatcher, après le retrait
   * de l'identité du robot) : `null` = aucun en-tête, `undefined` = aucune requête encore partie. Affiché dans le rapport d'accès
   * (21 § 6.6, M8) : la valeur reçue par le site, jamais une constante.
   */
  sentAcceptLanguage(): string | null | undefined;
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

/** `Accept` et `Accept-Language` que Chromium envoie à une navigation (17 §5) : seuls ces deux-là, rien de plus. */
const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';

/**
 * En-têtes de la requête avec l'identité du robot imposée : User-Agent (tout `user-agent` fourni est remplacé, X2),
 * `From` s'il est posé, `Accept` standard de navigateur SEULEMENT si la requête n'en pose pas, `Accept-Language` toujours celui du moteur
 * (aucun : `ENGINE_ACCEPT_LANGUAGE` vaut `null`, l'en-tête d'une stratégie est retiré).
 */
function withRobotHeaders(init: FetchInit, options: { userAgent?: string | undefined; from?: string | undefined }): FetchInit {
  if (options.userAgent === undefined && options.from === undefined) return init;
  const headers = new Headers(init.headers as ConstructorParameters<typeof Headers>[0]);
  if (options.userAgent !== undefined) {
    headers.set('user-agent', options.userAgent);
    if (!headers.has('accept')) headers.set('accept', BROWSER_ACCEPT);
    // Langue : celle du moteur, imposée comme le User-Agent (21 § 6 : jamais la langue d'un utilisateur, d'un compte ou d'un proxy).
    // Un Chromium vierge n'en envoie aucune (`null`) : l'en-tête d'une stratégie est retiré, rien n'est ajouté.
    headers.delete('accept-language');
    if (ENGINE_ACCEPT_LANGUAGE !== null) headers.set('accept-language', ENGINE_ACCEPT_LANGUAGE);
  }
  if (options.from !== undefined) headers.set('from', options.from);
  return { ...init, headers };
}

/**
 * `Accept-Language` retiré au dernier moment (dispatcher) : le `fetch` d'undici ajoute `accept-language: *` à toute requête qui n'en
 * pose pas (Fetch Standard), ce qu'un Chromium vierge ne fait pas. Seul l'envoi réel compte (assert_accept_language_engine_real).
 */
function withoutAcceptLanguage(headers: Dispatcher.DispatchOptions['headers']): Dispatcher.DispatchOptions['headers'] {
  const drop = (name: unknown): boolean => typeof name === 'string' && name.toLowerCase() === 'accept-language';
  if (headers === undefined || headers === null) return headers;
  if (Array.isArray(headers)) {
    if (headers.length > 0 && Array.isArray(headers[0])) return (headers as unknown as [string, string][]).filter(([name]) => !drop(name)) as never;
    const flat: (string | string[])[] = [];
    for (let i = 0; i + 1 < headers.length; i += 2) if (!drop(headers[i])) flat.push(headers[i] as string, headers[i + 1] as string | string[]);
    return flat as never;
  }
  if (typeof (headers as Iterable<unknown>)[Symbol.iterator] === 'function') {
    return [...(headers as Iterable<[string, string | string[] | undefined]>)].filter(([name]) => !drop(name)) as never;
  }
  return Object.fromEntries(Object.entries(headers as Record<string, unknown>).filter(([name]) => !drop(name))) as never;
}

/** Valeur d'un en-tête dans les options d'un dispatcher undici (objet, paires, liste plate ou itérable) ; `null` s'il est absent. */
function headerValue(headers: Dispatcher.DispatchOptions['headers'], name: string): string | null {
  const is = (n: unknown): boolean => typeof n === 'string' && n.toLowerCase() === name;
  const text = (v: unknown): string | null => (v === undefined || v === null ? null : Array.isArray(v) ? v.join(', ') : String(v));
  if (headers === undefined || headers === null) return null;
  if (Array.isArray(headers)) {
    if (headers.length > 0 && Array.isArray(headers[0])) return text((headers as unknown as [string, unknown][]).find(([n]) => is(n))?.[1]);
    for (let i = 0; i + 1 < headers.length; i += 2) if (is(headers[i])) return text(headers[i + 1]);
    return null;
  }
  if (typeof (headers as Iterable<unknown>)[Symbol.iterator] === 'function') {
    for (const [n, v] of headers as Iterable<[string, unknown]>) if (is(n)) return text(v);
    return null;
  }
  for (const [n, v] of Object.entries(headers as Record<string, unknown>)) if (is(n)) return text(v);
  return null;
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
  const proxyId = rung.mode === 'direct' ? null : rung.proxy.id;
  const price = rung.mode === 'direct' ? undefined : rung.proxy.price;
  const allowHost = options.allowedHosts === undefined ? undefined : domainLock(options.allowedHosts, options.allowedHostSuffixes);
  let exceeded = false;
  const ceiling = options.costCeiling;
  /** Abandonné au dépassement du plafond en cours de corps : chaque `fetch` de la session y est relié. */
  const budget = new AbortController();
  /** Prix au Go : budget d'octets restant contrôlé à chaque bloc de corps reçu (marge d'un bloc de lecture). */
  const overBytes = (): boolean =>
    ceiling !== undefined && price !== undefined && proxyCostUsd(price, meter.bytes + COST_BYTE_MARGIN, requests) + (ceiling.otherUsd?.() ?? 0) > ceiling.maxUsd;
  // Une requête = un envoi par le dispatcher (chaque saut de redirection compte).
  // Identité du robot (E1) : la langue envoyée est celle d'un Chromium vierge, c'est-à-dire aucune (`ENGINE_ACCEPT_LANGUAGE` null).
  const stripLanguage = options.userAgent !== undefined && ENGINE_ACCEPT_LANGUAGE === null;
  /** `Accept-Language` de la dernière requête réellement partie (`undefined` : aucune encore). */
  let sentLanguage: string | null | undefined;
  const dispatcher = base.compose((dispatch) => (opts0, handler) => {
    requests += 1;
    const opts = stripLanguage ? { ...opts0, headers: withoutAcceptLanguage(opts0.headers) } : opts0;
    sentLanguage = headerValue(opts.headers, 'accept-language');
    if (ceiling === undefined || price === undefined || handler.onResponseData === undefined) return dispatch(opts, handler);
    const guarded: Dispatcher.DispatchHandler = {
      onRequestStart: (controller, context) => handler.onRequestStart?.(controller, context),
      onRequestUpgrade: (controller, status, headers, socket) => handler.onRequestUpgrade?.(controller, status, headers, socket),
      onResponseStart: (controller, status, headers, message) => handler.onResponseStart?.(controller, status, headers, message),
      onResponseData: (controller, chunk) => {
        if (exceeded || overBytes()) {
          exceeded = true;
          const error = new ProxyBudgetExceededError();
          // Le signal d'abandon de la session coupe aussi le corps déjà rendu à l'appelant : l'abandon du contrôleur seul
          // ne le fait pas quand il survient au premier bloc (le lecteur attendait alors son délai).
          budget.abort(error);
          controller.abort(error);
          return;
        }
        handler.onResponseData?.(controller, chunk);
      },
      onResponseEnd: (controller, trailers) => handler.onResponseEnd?.(controller, trailers),
      onResponseError: (controller, error) => handler.onResponseError?.(controller, error),
    };
    return dispatch(opts, guarded);
  });
  const beforeRequest = () => {
    if (exceeded || wouldExceed(options.costCeiling, price, meter.bytes, requests)) {
      exceeded = true;
      throw new ProxyBudgetExceededError();
    }
  };
  return {
    mode: rung.mode,
    proxyId,
    dispatcher,
    fetch: (input, init = {}, opts = {}) =>
      guardedFetch(input, withRobotHeaders(ceiling === undefined ? init : { ...init, signal: init.signal ? AbortSignal.any([init.signal, budget.signal]) : budget.signal }, options) as Omit<RequestInit, 'dispatcher' | 'redirect'>, {
        guard,
        dispatcher,
        ...(opts.followRedirects === false ? { followRedirects: false } : {}),
        ...(allowHost === undefined ? {} : { allowHost }),
        ...(options.costCeiling === undefined ? {} : { beforeRequest }),
        ...(options.checkUrl === undefined ? {} : { checkUrl: options.checkUrl }),
      }),
    budgetExceeded: () => exceeded,
    sentAcceptLanguage: () => sentLanguage,
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
