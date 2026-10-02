// SPDX-License-Identifier: AGPL-3.0-only
// Proxy HTTP de test avec identifiants (Basic, RFC 7235 et 9110 §9.3.6) : requêtes en URI absolue et tunnels CONNECT.
// Chaque tentative est journalisée (IP du client, utilisateur, cible, issue) ; le mot de passe n'y figure jamais.
// L'IP vue par la cible est celle du conteneur du proxy (10.88.0.11 en Docker Compose).
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Credentials } from './config.ts';
import { createJournal, normalizeIp, type Journal } from './journal.ts';

export interface ProxyEvent {
  at: string;
  clientIp: string;
  user: string;
  method: string;
  target: string;
  outcome: string;
}

export interface ProxyHandle {
  port: number;
  journal: Journal<ProxyEvent>;
  close(): Promise<void>;
}

export interface ProxyOptions {
  port?: number;
  host?: string;
  credentials: Credentials;
  /** Appelé pour chaque événement journalisé (sortie standard du conteneur). */
  onEvent?: (event: ProxyEvent) => void;
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
export function credentialsMatch(expected: Credentials, username: string, password: string): boolean {
  const user = timingSafeEqual(digest(expected.username), digest(username));
  const pass = timingSafeEqual(digest(expected.password), digest(password));
  return user && pass;
}

function basicUser(header: string | undefined): { username: string; password: string } | undefined {
  const match = /^Basic\s+(.+)$/i.exec(header ?? '');
  if (!match?.[1]) return undefined;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon === -1 ? undefined : { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

const HOP_BY_HOP = new Set(['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export async function startHttpProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const journal = createJournal<ProxyEvent>(10_000, options.onEvent);
  const sockets = new Set<Socket | Duplex>();
  const log = (req: IncomingMessage, user: string, method: string, target: string, outcome: string): void =>
    journal.add({ at: new Date().toISOString(), clientIp: normalizeIp(req.socket.remoteAddress), user, method, target, outcome });
  const authorize = (req: IncomingMessage): string | undefined => {
    const given = basicUser(req.headers['proxy-authorization']);
    return given && credentialsMatch(options.credentials, given.username, given.password) ? given.username : undefined;
  };

  const server: Server = createServer((req, res) => {
    const user = authorize(req);
    const given = basicUser(req.headers['proxy-authorization'])?.username ?? '';
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const target = `${url.hostname}:${url.port || '80'}`;
    if (user === undefined) {
      log(req, given, req.method ?? 'GET', target, 'auth_failed');
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="sym-browser-fixtures"', 'content-length': '0', connection: 'close' }).end();
      return;
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400).end();
      return;
    }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP_BY_HOP.has(name)));
    const upstream = httpRequest({ host: url.hostname, port: Number(url.port || 80), method: req.method, path: `${url.pathname}${url.search}`, headers }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => {
      log(req, user, req.method ?? 'GET', target, 'upstream_error');
      if (!res.headersSent) res.writeHead(502, { 'content-length': '0' }).end();
      else res.destroy();
    });
    log(req, user, req.method ?? 'GET', target, 'ok');
    req.pipe(upstream);
  });

  server.on('connect', (req: IncomingMessage, clientSocket: Duplex, head: Buffer) => {
    sockets.add(clientSocket);
    clientSocket.on('close', () => sockets.delete(clientSocket));
    clientSocket.on('error', () => clientSocket.destroy());
    const target = req.url ?? '';
    const user = authorize(req);
    if (user === undefined) {
      log(req, basicUser(req.headers['proxy-authorization'])?.username ?? '', 'CONNECT', target, 'auth_failed');
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="sym-browser-fixtures"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const separator = target.lastIndexOf(':');
    const host = target.slice(0, separator).replace(/^\[|\]$/g, '');
    const port = Number(target.slice(separator + 1));
    if (separator === -1 || !Number.isInteger(port) || port < 1 || port > 65_535) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = connect({ host, port });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    let established = false;
    upstream.once('connect', () => {
      established = true;
      log(req, user, 'CONNECT', target, 'ok');
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => {
      if (!established) {
        log(req, user, 'CONNECT', target, 'upstream_error');
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      } else clientSocket.destroy();
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? '0.0.0.0', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    journal,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
