// SPDX-License-Identifier: AGPL-3.0-only
// Fixtures locales des tests d'egress (tâche 1.5). Point d'accroche de la tâche 0.5 (site de test et proxys, `pnpm fixtures`),
// pas encore livrée : ce site minimal compte, côté destination, chaque connexion TCP (port distant) et chaque octet lu ou
// écrit, ce qui sert de référence aux compteurs de l'egress (± 1 %). À remplacer par les fixtures de 0.5 quand elles existent.
import { createHash } from 'node:crypto';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as connectTcp, createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

export type FixtureSite = {
  readonly port: number;
  /** Connexions TCP acceptées (ports distants, dans l'ordre). */
  readonly remotePorts: readonly number[];
  connections(): number;
  /** Octets reçus par la fixture (envoyés par l'egress). */
  bytesRead(): number;
  /** Octets écrits par la fixture (reçus par l'egress). */
  bytesWritten(): number;
  /** Ferme les connexions ouvertes (les compteurs restent lisibles). */
  dropConnections(): void;
  close(): Promise<void>;
};

export type FixtureRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Trame WebSocket texte non masquée (serveur → client), charge < 126 octets. */
function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

/** Routes par défaut : page, corps de n octets, redirection, WebSocket (poignée de main écrite à la main, sans dépendance). */
const DEFAULT_ROUTES: Record<string, FixtureRoute> = {
  '/': (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }).end('<!doctype html><title>fixture</title><p>ok</p>');
  },
  '/bytes': (_req, res, url) => {
    const n = Number(url.searchParams.get('n') ?? '0');
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(n), 'access-control-allow-origin': '*', connection: 'close' });
    const chunk = Buffer.alloc(16_384, 0x61);
    let left = n;
    const pump = (): void => {
      while (left > 0) {
        const part = chunk.subarray(0, Math.min(left, chunk.length));
        left -= part.length;
        if (!res.write(part)) {
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    };
    pump();
  },
  '/redirect': (_req, res, url) => {
    res.writeHead(302, { location: url.searchParams.get('to') ?? '/', connection: 'close' }).end();
  },
  '/echo': (req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*', connection: 'close' }).end(`${body.length}`);
    });
  },
};

export async function startFixtureSite(routes: Record<string, FixtureRoute> = {}): Promise<FixtureSite> {
  const table = { ...DEFAULT_ROUTES, ...routes };
  const remotePorts: number[] = [];
  const open = new Set<Socket>();
  let closedRead = 0;
  let closedWritten = 0;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.invalid');
    const route = table[url.pathname];
    if (route === undefined) res.writeHead(404, { connection: 'close' }).end('not_found');
    else route(req, res, url);
  });
  server.keepAliveTimeout = 1;
  server.on('connection', (socket: Socket) => {
    remotePorts.push(socket.remotePort ?? 0);
    open.add(socket);
    socket.once('close', () => {
      open.delete(socket);
      closedRead += socket.bytesRead;
      closedWritten += socket.bytesWritten;
    });
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const key = String(req.headers['sec-websocket-key'] ?? '');
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(textFrame('hello'));
    socket.on('data', () => {});
    socket.on('error', () => socket.destroy());
    setTimeout(() => socket.end(Buffer.from([0x88, 0x00])), 100).unref();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const live = (pick: (s: Socket) => number): number => [...open].reduce((sum, s) => sum + pick(s), 0);
  return {
    port,
    remotePorts,
    connections: () => remotePorts.length,
    bytesRead: () => closedRead + live((s) => s.bytesRead),
    bytesWritten: () => closedWritten + live((s) => s.bytesWritten),
    dropConnections: () => {
      for (const socket of open) socket.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Écoute TCP et UDP sur 127.0.0.1 qui ne fait que compter (cibles WebRTC, WebTransport : rien ne doit y arriver). */
export type Sink = { readonly tcpPort: number; readonly udpPort: number; tcpConnections(): number; udpPackets(): number; close(): Promise<void> };

export async function startSink(): Promise<Sink> {
  let connections = 0;
  let packets = 0;
  const tcp: TcpServer = createTcpServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  const udp: UdpSocket = createSocket('udp4');
  udp.on('message', () => void (packets += 1));
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', () => resolve()));
  await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', () => resolve()));
  return {
    tcpPort: (tcp.address() as AddressInfo).port,
    udpPort: udp.address().port,
    tcpConnections: () => connections,
    udpPackets: () => packets,
    close: async () => {
      udp.close();
      await new Promise<void>((resolve) => tcp.close(() => resolve()));
    },
  };
}

/**
 * Relais TCP de comptage placé devant une destination (site de la tâche 0.5) : chaque connexion reçue (port distant) et
 * chaque octet échangé côté entrant est compté. Référence des compteurs de l'egress (± 1 %) et preuve « 0 connexion ».
 */
export type CountingRelay = Omit<FixtureSite, 'dropConnections'>;

export async function startCountingRelay(targetPort: number, targetHost = '127.0.0.1'): Promise<CountingRelay> {
  const remotePorts: number[] = [];
  const open = new Set<Socket>();
  let closedRead = 0;
  let closedWritten = 0;
  const server = createTcpServer((inbound) => {
    remotePorts.push(inbound.remotePort ?? 0);
    open.add(inbound);
    inbound.once('close', () => {
      open.delete(inbound);
      closedRead += inbound.bytesRead;
      closedWritten += inbound.bytesWritten;
    });
    const outbound = connectTcp(targetPort, targetHost);
    inbound.pipe(outbound).pipe(inbound);
    inbound.on('error', () => outbound.destroy());
    outbound.on('error', () => inbound.destroy());
    inbound.once('close', () => outbound.destroy());
    outbound.once('close', () => inbound.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const live = (pick: (s: Socket) => number): number => [...open].reduce((sum, s) => sum + pick(s), 0);
  return {
    port: (server.address() as AddressInfo).port,
    remotePorts,
    connections: () => remotePorts.length,
    bytesRead: () => closedRead + live((s) => s.bytesRead),
    bytesWritten: () => closedWritten + live((s) => s.bytesWritten),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
