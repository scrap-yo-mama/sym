// SPDX-License-Identifier: AGPL-3.0-only
// Proxy d'egress local du worker (08b §1) : tout Chromium passe par lui (`--proxy-server`). Il résout une fois,
// refuse les adresses interdites, se connecte à l'adresse validée. HTTP (forme absolue) et CONNECT (HTTPS, ws et
// wss : Chromium tunnelle tous les WebSocket par CONNECT derrière un proxy HTTP, vérifié par le test ws://).
// Aucun gestionnaire `upgrade` : une requête Upgrade en forme absolue est relayée sans ses en-têtes hop-by-hop, donc
// jamais surclassée. Écoute sur 127.0.0.1 seulement ; délai d'inactivité et plafond de connexions.
// Tâche 1.6 : chaînage vers le proxy BYO du run (`upstream`, la cible reste contrôlée ici avant le tunnel) et mode
// fermé (`refuseAll`) pour le proxy de lancement de Chromium : tout trafic hors contexte de run est refusé et compté.
// Verrou de domaines (`allowHosts`) : Playwright n'appelle pas `context.route` sur les sauts de redirection ; seul le
// proxy voit chaque saut, chaque sous-ressource, chaque WebSocket et chaque `APIRequestContext`. Tout hôte hors API
// reçoit 403 `domain_not_allowed`, sans connexion sortante. Plafond de coût (`admit`) : nouveau tunnel refusé (403
// `run_budget_exceeded`) quand le plafond du run serait dépassé.
import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { connect as netConnect, Socket, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { domainLock, normalizeHost } from './domain-lock.js';
import { findSsrfBlocked, type SsrfDenyDetail, type SsrfGuard } from './guard.js';

export type EgressProxy = {
  readonly url: string;
  readonly port: number;
  /** Demandes reçues (requêtes en forme absolue et CONNECT), refusées comprises. */
  requests(): number;
  /** Coupe toutes les connexions et tous les tunnels en cours (plafond de coût atteint). */
  abortAll(): void;
  close(): Promise<void>;
};

export type EgressTarget = { host: string; port: number; via: 'http' | 'connect' };

/** Ouvre le tunnel vers une cible déjà contrôlée par la garde (proxy BYO amont, `createUpstreamDialer`). */
export type EgressUpstream = (host: string, port: number) => Promise<Socket>;

export type EgressProxyOptions = {
  guard: SsrfGuard;
  /** Journal admin : détail du refus (jamais renvoyé au navigateur). */
  onBlocked?: (detail: SsrfDenyDetail & { via: 'http' | 'connect' }) => void;
  connectTimeoutMs?: number;
  /** Inactivité (ms) au-delà de laquelle une connexion ou un tunnel est fermé. Défaut : 120 s. */
  idleTimeoutMs?: number;
  /** Connexions clientes simultanées au plus ; au-delà, 503 et fermeture. Défaut : 256. */
  maxConnections?: number;
  /** Chaînage vers un proxy amont : la garde contrôle la cible (résolution unique), puis `upstream` ouvre le tunnel. */
  upstream?: EgressUpstream;
  /** Proxy fermé : toute demande est refusée (403 `egress_closed`) et comptée. */
  refuseAll?: boolean;
  /** Toute demande reçue, avant décision (observation, tests « 0 requête »). */
  onRequest?: (target: EgressTarget) => void;
  /** Verrou de domaines de l'essai : seuls ces hôtes (comparaison exacte) sont joignables ; les autres → 403. */
  allowHosts?: readonly string[];
  /** Portées de site admises en plus d'`allowHosts` (domaine et sous-domaines), posées par le code seulement (`domainLock`). */
  allowHostSuffixes?: readonly string[];
  /**
   * Hôtes admis en plus, décidés requête par requête par le code (sous-ressources statiques d'un tiers pendant la
   * reconnaissance, `createStaticAssetAllowance`) ; jamais tirés d'une stratégie. La garde SSRF reste appliquée.
   */
  allowExtraHost?: (host: string) => boolean;
  /** Journal : demande refusée par le verrou de domaines (hôte normalisé). */
  onDomainBlocked?: (target: EgressTarget) => void;
  /** Admission d'une nouvelle connexion sortante (plafond de coût) : `false` → 403 `run_budget_exceeded`. */
  admit?: () => boolean;
};

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const BLOCKED_BODY = 'ssrf_blocked';

/** Refus décidé par le proxy lui-même (fermé, hors domaines, plafond) : 403 et un corps stable. */
class EgressRefusedError extends Error {
  override name = 'EgressRefusedError';
  readonly body: 'egress_closed' | 'domain_not_allowed' | 'run_budget_exceeded';
  constructor(body: EgressRefusedError['body']) {
    super(body);
    this.body = body;
  }
}

function forwardHeaders(req: IncomingMessage): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  const connectionTokens = new Set(
    String(req.headers.connection ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase()),
  );
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || connectionTokens.has(name)) continue;
    headers[name] = value;
  }
  return headers;
}

/** Cible d'une requête proxy : URL absolue http (forme absolue) ou autorité `hôte:port` (CONNECT). */
function parseAbsolute(raw: string | undefined): URL | undefined {
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Autorité d'un CONNECT (`hôte:port`, IPv6 entre crochets). Le port est extrait à part : `new URL` efface le port
 * par défaut du schéma (80), ce qui cassait `CONNECT hôte:80` (ws://). Seul l'hôte passe par le parseur WHATWG,
 * qui normalise les encodages d'IPv4 (décimal, octal, hexadécimal) et les IDN.
 */
export function parseAuthority(raw: string | undefined): { host: string; port: number } | undefined {
  if (raw === undefined) return undefined;
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:/@[\]\s]+):(\d{1,5})$/.exec(raw);
  if (match === null) return undefined;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return undefined;
  try {
    return { host: new URL(`http://${match[1] ?? ''}/`).hostname, port };
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

function rawResponse(socket: Duplex, status: string, body: string): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const { guard, onBlocked, refuseAll, onRequest, onDomainBlocked, admit } = options;
  const allowHost = options.allowHosts === undefined ? undefined : domainLock(options.allowHosts, options.allowHostSuffixes);
  const chain = options.upstream;
  let requests = 0;
  const timeoutMs = options.connectTimeoutMs ?? 10_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
  const maxConnections = options.maxConnections ?? 256;
  const sockets = new Set<Duplex>();
  const clients = new Set<Socket>();

  const report = (error: unknown, via: 'http' | 'connect'): boolean => {
    const blocked = findSsrfBlocked(error);
    if (blocked === undefined) return false;
    onBlocked?.({ ...blocked.detail, via });
    return true;
  };

  /** Résolution unique, contrôle, connexion sur l'adresse validée, contrôle de l'adresse distante effective. */
  const dial = async (host: string, port: number, via: 'http' | 'connect'): Promise<Socket> => {
    requests += 1;
    onRequest?.({ host, port, via });
    if (refuseAll === true) throw new EgressRefusedError('egress_closed');
    if (allowHost !== undefined && !allowHost(host) && options.allowExtraHost?.(host) !== true) {
      onDomainBlocked?.({ host: normalizeHost(host), port, via });
      throw new EgressRefusedError('domain_not_allowed');
    }
    if (admit !== undefined && !admit()) throw new EgressRefusedError('run_budget_exceeded');
    const pinned = await guard.resolve(host, port);
    if (chain !== undefined) {
      // Proxy amont : la cible vient d'être contrôlée (refus précoce) ; l'adresse distante est celle du proxy,
      // contrôlée par sa propre garde dans `upstream`.
      const tunnel = await chain(host, port);
      sockets.add(tunnel);
      tunnel.once('close', () => sockets.delete(tunnel));
      tunnel.setTimeout(idleTimeoutMs, () => tunnel.destroy());
      return tunnel;
    }
    const upstream = await openPinned(pinned.address, port, timeoutMs);
    try {
      guard.checkAddress(host, upstream.remoteAddress ?? '', port);
    } catch (error) {
      upstream.destroy();
      throw error;
    }
    sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
    return upstream;
  };

  const server = createServer((req, res) => {
    const url = parseAbsolute(req.url);
    if (url === undefined || url.protocol !== 'http:' || url.username !== '' || url.password !== '') {
      res.writeHead(400, { 'content-type': 'text/plain', connection: 'close' }).end('bad_proxy_request');
      return;
    }
    const port = url.port === '' ? 80 : Number(url.port);
    dial(url.hostname, port, 'http').then(
      (upstream) => {
        const outgoing = httpRequest(
          {
            // Pas d'option `agent` : avec `agent: false`, Node ignorerait createConnection et ouvrirait son propre
            // socket (vers localhost:80 par défaut). host et port pointent de toute façon sur l'adresse validée.
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
          },
        );
        // Invariant : la requête part sur le socket épinglé, jamais sur un socket ouvert par Node.
        outgoing.once('socket', (socket) => {
          if (socket !== upstream) outgoing.destroy(new Error('socket non épinglé'));
        });
        outgoing.on('error', () => {
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('bad_gateway');
          else res.destroy();
        });
        req.pipe(outgoing);
      },
      (error: unknown) => {
        const refused = error instanceof EgressRefusedError ? error.body : undefined;
        const blocked = refused === undefined && report(error, 'http');
        res
          .writeHead(blocked || refused !== undefined ? 403 : 502, { 'content-type': 'text/plain', connection: 'close' })
          .end(refused ?? (blocked ? BLOCKED_BODY : 'bad_gateway'));
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
    dial(target.host, target.port, 'connect').then(
      (upstream) => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        // Tunnel : inactivité surveillée des deux côtés, la fermeture d'un côté ferme l'autre.
        if (client instanceof Socket) client.setTimeout(idleTimeoutMs, () => client.destroy());
        upstream.pipe(client).pipe(upstream);
        upstream.on('error', () => client.destroy());
        upstream.once('close', () => client.destroy());
        client.once('close', () => upstream.destroy());
      },
      (error: unknown) => {
        const refused = error instanceof EgressRefusedError ? error.body : undefined;
        const blocked = refused === undefined && report(error, 'connect');
        rawResponse(client, blocked || refused !== undefined ? '403 Forbidden' : '502 Bad Gateway', refused ?? (blocked ? BLOCKED_BODY : 'bad_gateway'));
      },
    );
  });

  // Plafond de connexions simultanées et délai d'inactivité par connexion cliente.
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

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests: () => requests,
    abortAll: () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
