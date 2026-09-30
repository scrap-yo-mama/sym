// SPDX-License-Identifier: AGPL-3.0-only
// Proxy d'egress local du worker (08b §1) : tout Chromium passe par lui (`--proxy-server`). Il résout une fois,
// refuse les adresses interdites, se connecte à l'adresse validée. HTTP (forme absolue) et CONNECT (HTTPS, ws et
// wss : Chromium tunnelle tous les WebSocket par CONNECT derrière un proxy HTTP, vérifié par le test ws://).
// Aucun gestionnaire `upgrade` : une requête Upgrade en forme absolue est relayée sans ses en-têtes hop-by-hop, donc
// jamais surclassée. Écoute sur 127.0.0.1 seulement ; délai d'inactivité et plafond de connexions.
import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { connect as netConnect, Socket, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { findSsrfBlocked, type SsrfDenyDetail, type SsrfGuard } from './guard.js';

export type EgressProxy = { readonly url: string; readonly port: number; close(): Promise<void> };

export type EgressProxyOptions = {
  guard: SsrfGuard;
  /** Journal admin : détail du refus (jamais renvoyé au navigateur). */
  onBlocked?: (detail: SsrfDenyDetail & { via: 'http' | 'connect' }) => void;
  connectTimeoutMs?: number;
  /** Inactivité (ms) au-delà de laquelle une connexion ou un tunnel est fermé. Défaut : 120 s. */
  idleTimeoutMs?: number;
  /** Connexions clientes simultanées au plus ; au-delà, 503 et fermeture. Défaut : 256. */
  maxConnections?: number;
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
  const { guard, onBlocked } = options;
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
  const dial = async (host: string, port: number): Promise<Socket> => {
    const pinned = await guard.resolve(host, port);
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
    dial(url.hostname, port).then(
      (upstream) => {
        const outgoing = httpRequest(
          {
            // Pas d'option `agent` : avec `agent: false`, Node ignorerait createConnection et ouvrirait son propre
            // socket (vers localhost:80 par défaut). host et port pointent de toute façon sur l'adresse validée.
            createConnection: () => upstream,
            host: upstream.remoteAddress,
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
        const blocked = report(error, 'http');
        res
          .writeHead(blocked ? 403 : 502, { 'content-type': 'text/plain', connection: 'close' })
          .end(blocked ? BLOCKED_BODY : 'bad_gateway');
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
    dial(target.host, target.port).then(
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
        const blocked = report(error, 'connect');
        rawResponse(client, blocked ? '403 Forbidden' : '502 Bad Gateway', blocked ? BLOCKED_BODY : 'bad_gateway');
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
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
