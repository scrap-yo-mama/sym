// SPDX-License-Identifier: AGPL-3.0-only
// Proxys BYO simulés (tâche 1.6) : HTTP CONNECT et SOCKS5 (RFC 1928 + RFC 1929), boucle locale, ports éphémères.
// Ils journalisent la cible et l'identité reçues, et ne joignent QUE 127.0.0.1 (un nom `*.localhost` est envoyé vers la
// boucle locale, tout autre nom est refusé) : aucune adresse publique n'est contactée.
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { connect, createServer as createTcpServer, type AddressInfo, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

type UpstreamLogEntry = { target: string; username: string | null; password: string | null };

export type UpstreamTestProxy = {
  readonly url: string;
  readonly port: number;
  readonly log: UpstreamLogEntry[];
  close(): Promise<void>;
};

function localTarget(host: string): string | undefined {
  if (host === '127.0.0.1' || host === 'localhost' || host.endsWith('.localhost')) return '127.0.0.1';
  return undefined;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function closeServer(server: Server, sockets: Set<Socket | Duplex>): Promise<void> {
  for (const s of sockets) s.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Proxy HTTP CONNECT ; `password` posé : 407 sans `Proxy-Authorization` correct. */
export async function startConnectProxy(options: { password?: string } = {}): Promise<UpstreamTestProxy> {
  const log: UpstreamLogEntry[] = [];
  const sockets = new Set<Socket | Duplex>();
  const server = createHttpServer((_req, res) => res.writeHead(405).end('connect_only'));
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on('error', () => client.destroy());
    const header = req.headers['proxy-authorization'];
    let username: string | null = null;
    let password: string | null = null;
    if (typeof header === 'string' && header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      username = decoded.slice(0, decoded.indexOf(':'));
      password = decoded.slice(decoded.indexOf(':') + 1);
    }
    log.push({ target: req.url ?? '', username, password });
    if (options.password !== undefined && password !== options.password) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const match = /^(.+):(\d+)$/.exec(req.url ?? '');
    const address = match === null ? undefined : localTarget(match[1] as string);
    if (match === null || address === undefined) {
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = connect({ host: address, port: Number(match[2]) });
    sockets.add(upstream);
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client).pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    upstream.once('close', () => client.destroy());
    client.once('close', () => upstream.destroy());
  });
  const port = await listen(server as unknown as Server);
  return { url: `http://127.0.0.1:${port}`, port, log, close: () => closeServer(server as unknown as Server, sockets) };
}

/** Proxy SOCKS5 ; `username`/`password` posés : authentification RFC 1929 exigée. */
export async function startSocks5Proxy(options: { username?: string; password?: string } = {}): Promise<UpstreamTestProxy> {
  const log: UpstreamLogEntry[] = [];
  const sockets = new Set<Socket | Duplex>();
  const server = createTcpServer((client) => {
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    let buffer = Buffer.alloc(0);
    let stage: 'greeting' | 'auth' | 'request' | 'done' = 'greeting';
    let username: string | null = null;
    let password: string | null = null;
    const needAuth = options.username !== undefined;
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (stage === 'greeting') {
          if (buffer.length < 2 || buffer.length < 2 + (buffer[1] ?? 0)) return;
          const methods = [...buffer.subarray(2, 2 + (buffer[1] ?? 0))];
          buffer = buffer.subarray(2 + (buffer[1] ?? 0));
          const method = needAuth ? (methods.includes(2) ? 2 : 0xff) : methods.includes(0) ? 0 : 0xff;
          client.write(Buffer.from([5, method]));
          if (method === 0xff) return client.end();
          stage = method === 2 ? 'auth' : 'request';
        } else if (stage === 'auth') {
          const ulen = buffer[1];
          if (ulen === undefined || buffer.length < 2 + ulen + 1) return;
          const plen = buffer[2 + ulen] as number;
          if (buffer.length < 3 + ulen + plen) return;
          username = buffer.subarray(2, 2 + ulen).toString('utf8');
          password = buffer.subarray(3 + ulen, 3 + ulen + plen).toString('utf8');
          buffer = buffer.subarray(3 + ulen + plen);
          const ok = username === options.username && password === options.password;
          client.write(Buffer.from([1, ok ? 0 : 1]));
          if (!ok) {
            log.push({ target: '(auth refusée)', username, password });
            return client.end();
          }
          stage = 'request';
        } else if (stage === 'request') {
          if (buffer.length < 5) return;
          const atyp = buffer[3];
          let host: string;
          let offset: number;
          if (atyp === 1) {
            if (buffer.length < 10) return;
            host = [...buffer.subarray(4, 8)].join('.');
            offset = 8;
          } else if (atyp === 3) {
            const len = buffer[4] as number;
            if (buffer.length < 5 + len + 2) return;
            host = buffer.subarray(5, 5 + len).toString('utf8');
            offset = 5 + len;
          } else {
            client.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
            return;
          }
          const port = buffer.readUInt16BE(offset);
          buffer = buffer.subarray(offset + 2);
          log.push({ target: `${host}:${port}`, username, password });
          stage = 'done';
          client.off('data', onData);
          const address = localTarget(host);
          if (address === undefined) {
            client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
            return;
          }
          const upstream = connect({ host: address, port });
          sockets.add(upstream);
          upstream.once('connect', () => {
            client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            if (buffer.length > 0) upstream.write(buffer);
            upstream.pipe(client).pipe(upstream);
          });
          upstream.on('error', () => client.destroy());
          upstream.once('close', () => client.destroy());
          client.once('close', () => upstream.destroy());
          return;
        } else return;
      }
    };
    client.on('data', onData);
  });
  const port = await listen(server);
  return { url: `socks5://127.0.0.1:${port}`, port, log, close: () => closeServer(server, sockets) };
}
