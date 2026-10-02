// SPDX-License-Identifier: AGPL-3.0-only
// Egress d'une session (cdc/sym-browser 04c § 1, BINV2) : proxy HTTP (forme absolue) et CONNECT lié à 127.0.0.1, port
// éphémère, un par session ; les WebSocket et le TURN/TCP de WebRTC passent par CONNECT. Ordre de décision (§ 1.3) : egress
// fermé, hôte et port de la politique, budget, résolution unique et contrôle des adresses, puis connexion à l'adresse
// épinglée (adresse distante effective recontrôlée) ou tunnel par le proxy amont. Octets comptés sur le socket sortant
// (destination ou proxy amont : TLS et en-têtes de tunnel compris), budget contrôlé à chaque bloc lu ou écrit.
// Dérivé du proxy d'egress du worker de SYM (`runtime/packages/core/src/net/egress-proxy.ts`, lu sans être importé) avec la
// politique de session, les compteurs, les époques et les événements en plus. Aucun gestionnaire `upgrade` : une requête
// Upgrade en forme absolue est relayée sans ses en-têtes hop-by-hop, donc jamais surclassée.
import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { connect as netConnect, Socket, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { EgressBlockReason, EgressPolicy, EgressState, UpstreamProxy, UpstreamProxyProfileRef } from '@sym/contracts/browser';
import { createBlockedReporter, type EgressEvent } from './events.js';
import { EgressDeniedError, type EgressGuard } from './guard.js';
import { compileEgressPolicy, normalizeHost, type CompiledEgressPolicy } from './policy.js';

export type EgressTarget = { host: string; port: number; via: 'http' | 'connect' };

/** Cible transmise au proxy amont : le nom seul (`dnsViaProxy`), ou le nom et l'adresse épinglée par la garde. */
export type UpstreamTarget = { host: string; port: number; address?: string };

/** Relais vers le proxy amont (tâche 1.6) : ouvre le tunnel et rend le socket, octets comptés par l'egress. */
export type UpstreamDialer = (target: UpstreamTarget, upstream: UpstreamProxy | UpstreamProxyProfileRef) => Promise<Socket>;

/** Connexion sortante ouverte par l'egress (observation : port local, preuve « 100 % des connexions vues »). */
export type EgressConnection = { epoch: number; host: string; port: number; via: 'http' | 'connect'; localPort: number; remoteAddress: string };

export type SessionEgressDeps = {
  guard: EgressGuard;
  /** `egress.blocked` et `egress.budget_exceeded` (SSE et `session_events`, tâche 2.5). */
  onEvent?: (event: EgressEvent) => void;
  /** Toute demande reçue, avant décision. */
  onRequest?: (target: EgressTarget) => void;
  /** Journal du nœud : refus avec son détail (adresse, classe), jamais renvoyé au navigateur. */
  onDenied?: (error: EgressDeniedError) => void;
  /** `onBudgetExceeded: 'end'` : la session se termine, raison `budget_exceeded` (machine à états, tâche 1.2). */
  onBudgetEnd?: () => void;
  /** Reste du quota mensuel d'octets du client (04d § 4, tâches 2.4 et 2.6) ; le budget effectif est le plus petit. */
  remainingQuotaBytes?: () => number | undefined;
  /** Proxy amont (tâche 1.6). Sans lui, une politique avec `upstream` est refusée. */
  dialUpstream?: UpstreamDialer;
  /** Compteurs poussés périodiquement et à la fermeture (persistance, tâches 0.2 et 2.6). */
  onCounters?: (state: EgressState) => void;
  countersIntervalMs?: number;
  /** Fenêtre d'agrégation de `egress.blocked` (1 s par défaut, à valider). */
  blockedWindowMs?: number;
  connectTimeoutMs?: number;
  /** Inactivité au-delà de laquelle une connexion ou un tunnel est fermé (120 s par défaut). */
  idleTimeoutMs?: number;
  /** Connexions clientes simultanées au plus (256 par défaut) ; au-delà, 503. */
  maxConnections?: number;
};

export type SessionEgress = {
  /** `http://127.0.0.1:PORT` : seule valeur de proxy donnée à Chromium ou au contexte. */
  readonly url: string;
  readonly port: number;
  state(): EgressState;
  /** Nouvelle politique (`PUT /v1/sessions/{id}/egress`) : nouvelle époque, compteurs à zéro, tunnels en cours coupés. */
  replace(policy: EgressPolicy): EgressState;
  /** Connexions sortantes ouvertes (10 000 dernières). */
  connections(): readonly EgressConnection[];
  /** Coupe tous les tunnels et connexions en cours. */
  abortAll(): void;
  /** Destruction, étape 2 (04c § 3.2) : tunnels coupés, puis toute demande reçoit 403 `egress_closed` (comptée). */
  shut(): void;
  /** Destruction, étape 7 : arrêt, port libéré, compteurs poussés une dernière fois. */
  close(): Promise<void>;
};

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const CONNECTION_HISTORY = 10_000;

function forwardHeaders(req: IncomingMessage): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  const tokens = new Set(String(req.headers.connection ?? '').split(',').map((t) => t.trim().toLowerCase()));
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || tokens.has(name)) continue;
    headers[name] = value;
  }
  return headers;
}

function parseAbsolute(raw: string | undefined): URL | undefined {
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' && url.username === '' && url.password === '' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Autorité d'un CONNECT (`hôte:port`, IPv6 entre crochets) ; l'hôte passe par le parseur WHATWG (IPv4 encodées, IDN). */
export function parseAuthority(raw: string | undefined): { host: string; port: number } | undefined {
  if (raw === undefined) return undefined;
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:/@[\]\s]+):(\d{1,5})$/.exec(raw);
  if (match === null) return undefined;
  const port = Number(match[2]);
  if (port < 1 || port > 65_535) return undefined;
  try {
    return { host: new URL(`http://${match[1] ?? ''}/`).hostname.replace(/^\[(.*)\]$/, '$1'), port };
  } catch {
    return undefined;
  }
}

function openPinned(address: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: address, port });
    const timer = setTimeout(() => socket.destroy(new Error('connect timeout')), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Réponse texte complète (longueur posée, pas de découpage `chunked`), connexion fermée. */
function textHeaders(body: string): OutgoingHttpHeaders {
  return { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body), connection: 'close' };
}

function rawResponse(socket: Duplex, status: string, body: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

function assertUpstreamWired(policy: CompiledEgressPolicy, deps: SessionEgressDeps): void {
  if (policy.upstream !== undefined && deps.dialUpstream === undefined) {
    throw new Error('upstream : aucun relais de proxy amont branché sur cet egress (tâche 1.6)');
  }
}

async function start(initial: CompiledEgressPolicy, deps: SessionEgressDeps, closedMode: boolean): Promise<SessionEgress> {
  assertUpstreamWired(initial, deps);
  const { guard } = deps;
  const timeoutMs = deps.connectTimeoutMs ?? 10_000;
  const idleTimeoutMs = deps.idleTimeoutMs ?? 120_000;
  const maxConnections = deps.maxConnections ?? 256;
  const emit = (event: EgressEvent): void => deps.onEvent?.(event);
  const reporter = createBlockedReporter(emit, deps.blockedWindowMs);

  let policy = initial;
  let epoch = 1;
  let requests = 0;
  let blocked = 0;
  let bytesIn = 0;
  let bytesOut = 0;
  let exceeded = false;
  let budgetEventSent = false;
  let shutDown = closedMode;
  const history: EgressConnection[] = [];
  /** Sockets sortants et clients de tunnel : coupés ensemble. */
  const sockets = new Set<Duplex>();
  const clients = new Set<Socket>();
  const cutter: { abort?: (except?: Duplex) => void } = {};

  const effectiveBudget = (): number | undefined => {
    const quota = deps.remainingQuotaBytes?.();
    if (quota === undefined) return policy.budgetBytes;
    return policy.budgetBytes === undefined ? Math.max(0, quota) : Math.min(policy.budgetBytes, Math.max(0, quota));
  };

  const state = (): EgressState => {
    const budgetBytes = effectiveBudget();
    return { epoch, requests, blocked, bytesIn, bytesOut, ...(budgetBytes === undefined ? {} : { budgetBytes }), budgetExceeded: exceeded };
  };

  /** Franchissement du budget : tout est coupé, événement une fois par époque, fin de session si demandée. */
  const crossBudget = (budgetBytes: number, except?: Duplex): void => {
    exceeded = true;
    cutter.abort?.(except);
    if (budgetEventSent) return;
    budgetEventSent = true;
    emit({ type: 'egress.budget_exceeded', data: { budgetBytes, bytesIn, bytesOut, action: policy.onBudgetExceeded } });
    if (policy.onBudgetExceeded === 'end') queueMicrotask(() => deps.onBudgetEnd?.());
  };

  const checkBudget = (): void => {
    if (exceeded) return;
    const budget = effectiveBudget();
    if (budget !== undefined && bytesIn + bytesOut >= budget) crossBudget(budget);
  };

  /** Admission d'un nouveau tunnel : tant que `bytesIn + bytesOut < budget`. La connexion qui demande reçoit son 403. */
  const admit = (origin: Duplex): boolean => {
    if (exceeded) return false;
    const budget = effectiveBudget();
    if (budget === undefined || bytesIn + bytesOut < budget) return true;
    crossBudget(budget, origin);
    return false;
  };

  /**
   * Comptage d'un socket sortant : relevé de `bytesRead` et `bytesWritten` à chaque bloc lu, après chaque écriture et à la
   * fermeture ; les octets d'une époque close ne comptent plus.
   */
  const track = (socket: Socket): void => {
    const socketEpoch = epoch;
    let lastRead = 0;
    let lastWritten = 0;
    const sample = (): void => {
      const read = socket.bytesRead;
      const written = socket.bytesWritten;
      if (socketEpoch === epoch) {
        bytesIn += read - lastRead;
        bytesOut += written - lastWritten;
      }
      lastRead = read;
      lastWritten = written;
      if (socketEpoch === epoch) checkBudget();
    };
    const write = socket.write.bind(socket) as (...args: unknown[]) => boolean;
    socket.write = ((...args: unknown[]) => {
      const ok = write(...args);
      sample();
      return ok;
    }) as Socket['write'];
    socket.prependListener('data', sample);
    socket.once('close', sample);
  };

  const refuse = (reason: EgressBlockReason, host: string, port: number, cause?: EgressDeniedError): never => {
    blocked += 1;
    reporter.report(host, reason, port);
    const error = cause ?? new EgressDeniedError(reason, host, { port });
    deps.onDenied?.(error);
    throw error;
  };

  /** Décision et ouverture de la connexion sortante d'une demande. */
  const dial = async (rawHost: string, port: number, via: 'http' | 'connect', origin: Duplex): Promise<Socket> => {
    const host = normalizeHost(rawHost) ?? rawHost.toLowerCase();
    requests += 1;
    deps.onRequest?.({ host, port, via });
    const current = policy;
    if (shutDown) refuse('egress_closed', host, port);
    if (!current.allows(host)) refuse('domain_not_allowed', host, port);
    if (!current.ports.has(port)) refuse('port_not_allowed', host, port);
    if (!admit(origin)) refuse('budget_exceeded', host, port);
    let socket: Socket;
    try {
      if (current.upstream !== undefined && deps.dialUpstream !== undefined) {
        let target: UpstreamTarget = { host, port };
        if (current.dnsViaProxy) guard.checkName(host, port);
        else target = { host, port, address: (await guard.resolve(host, port)).address };
        socket = await deps.dialUpstream(target, current.upstream);
      } else {
        const pinned = await guard.resolve(host, port);
        socket = await openPinned(pinned.address, port, timeoutMs);
        try {
          guard.checkAddress(host, socket.remoteAddress ?? '', port);
        } catch (error) {
          socket.destroy();
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof EgressDeniedError) refuse(error.reason, host, port, error);
      throw error;
    }
    // L'egress a pu être fermé, la politique remplacée ou le budget franchi pendant la résolution ou la connexion.
    if (shutDown || current !== policy || exceeded) {
      socket.destroy();
      refuse(shutDown ? 'egress_closed' : exceeded ? 'budget_exceeded' : 'domain_not_allowed', host, port);
    }
    track(socket);
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(idleTimeoutMs, () => socket.destroy());
    history.push({ epoch, host, port, via, localPort: socket.localPort ?? 0, remoteAddress: socket.remoteAddress ?? '' });
    if (history.length > CONNECTION_HISTORY) history.splice(0, history.length - CONNECTION_HISTORY);
    return socket;
  };

  const refusalBody = (error: unknown): { status: number; body: string } =>
    error instanceof EgressDeniedError ? { status: 403, body: error.reason } : { status: 502, body: 'bad_gateway' };

  const server = createServer((req, res) => {
    const url = parseAbsolute(req.url);
    if (url === undefined) {
      res.writeHead(400, textHeaders('bad_proxy_request')).end('bad_proxy_request');
      return;
    }
    const port = url.port === '' ? 80 : Number(url.port);
    dial(url.hostname, port, 'http', req.socket).then(
      (upstream) => {
        const outgoing = httpRequest(
          {
            // Pas d'option `agent` : avec `agent: false`, Node ignorerait createConnection. La requête part sur le socket épinglé.
            createConnection: () => upstream,
            host: upstream.remoteAddress ?? url.hostname,
            port,
            method: req.method,
            path: `${url.pathname}${url.search}`,
            headers: { ...forwardHeaders(req), host: url.host },
          },
          (upstreamRes) => {
            const headers = { ...upstreamRes.headers };
            for (const name of HOP_BY_HOP) delete headers[name];
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, headers);
            upstreamRes.pipe(res);
            upstreamRes.on('error', () => res.destroy());
          },
        );
        outgoing.once('socket', (socket) => {
          if (socket !== upstream) outgoing.destroy(new Error('socket non épinglé'));
        });
        outgoing.on('error', () => {
          if (!res.headersSent) res.writeHead(502, textHeaders('bad_gateway')).end('bad_gateway');
          else res.destroy();
        });
        upstream.once('close', () => {
          if (!res.writableEnded) res.destroy();
        });
        req.pipe(outgoing);
      },
      (error: unknown) => {
        const { status, body } = refusalBody(error);
        res.writeHead(status, textHeaders(body)).end(body);
      },
    );
  });

  server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    const target = parseAuthority(req.url);
    if (target === undefined) {
      rawResponse(client, '400 Bad Request', 'bad_proxy_request');
      return;
    }
    dial(target.host, target.port, 'connect', client).then(
      (upstream) => {
        if (client.destroyed) {
          upstream.destroy();
          return;
        }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        if (client instanceof Socket) client.setTimeout(idleTimeoutMs, () => client.destroy());
        upstream.pipe(client).pipe(upstream);
        upstream.on('error', () => client.destroy());
        upstream.once('close', () => client.destroy());
        client.once('close', () => upstream.destroy());
      },
      (error: unknown) => {
        const { status, body } = refusalBody(error);
        rawResponse(client, status === 403 ? '403 Forbidden' : '502 Bad Gateway', body);
      },
    );
  });

  server.on('connection', (socket: Socket) => {
    if (clients.size >= maxConnections) {
      socket.on('error', () => socket.destroy());
      rawResponse(socket, '503 Service Unavailable', 'egress_busy');
      return;
    }
    clients.add(socket);
    socket.once('close', () => clients.delete(socket));
  });
  server.timeout = idleTimeoutMs;
  server.on('clientError', (_error, socket) => rawResponse(socket, '400 Bad Request', 'bad_proxy_request'));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  /** Coupe tunnels, sockets sortants et connexions clientes, sauf `except` (la connexion qui attend son refus). */
  const abortAll = (except?: Duplex): void => {
    for (const socket of [...sockets, ...clients]) if (socket !== except) socket.destroy();
  };
  cutter.abort = abortAll;

  const counters = deps.onCounters === undefined ? undefined : setInterval(() => deps.onCounters?.(state()), deps.countersIntervalMs ?? 10_000);
  counters?.unref();
  let closing: Promise<void> | undefined;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    replace: (next) => {
      const compiled = compileEgressPolicy(next);
      assertUpstreamWired(compiled, deps);
      policy = compiled;
      epoch += 1;
      requests = 0;
      blocked = 0;
      bytesIn = 0;
      bytesOut = 0;
      exceeded = false;
      budgetEventSent = false;
      abortAll();
      return state();
    },
    connections: () => history,
    abortAll: () => abortAll(),
    shut: () => {
      shutDown = true;
      abortAll();
    },
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        shutDown = true;
        if (counters !== undefined) clearInterval(counters);
        abortAll();
        server.close(() => {
          reporter.flush();
          deps.onCounters?.(state());
          resolve();
        });
      });
      return closing;
    },
  };
}

/** Egress d'une session (04c § 6.1, `startSessionEgress`). Politique invalide : `EgressPolicyError` (`invalid_option`). */
export function startSessionEgress(policy: EgressPolicy, deps: SessionEgressDeps): Promise<SessionEgress> {
  return start(compileEgressPolicy(policy), deps, false);
}

/**
 * Proxy de lancement fermé d'un Chromium chaud `shared` (04c § 1.1) : toute demande reçoit 403 `egress_closed`, comptée.
 * Le trafic des sessions passe par le proxy de leur contexte, jamais par celui-ci.
 */
export function startClosedEgress(deps: SessionEgressDeps): Promise<SessionEgress> {
  return start(compileEgressPolicy({ allowedHosts: [] }), deps, true);
}
