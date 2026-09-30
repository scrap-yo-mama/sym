// Proxy de test local (tâche 1.4) : HTTP CONNECT qui annonce une « IP de sortie » propre à chaque instance et
// journalise les paramètres fournisseur reçus (nom d'utilisateur Basic). La fixture `/ip` lit l'IP de sortie
// annoncée via le registre partagé (port local du socket sortant du proxy → IP annoncée) ; sans entrée, c'est
// l'adresse réelle du pair (mode direct). Boucle locale, ports éphémères.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

export type ExitRegistry = Map<number, string>;

type ProxyLogEntry = {
  target: string;
  username: string | null;
  password: string | null;
  /** Paramètres décodés du nom d'utilisateur (`clé-valeur` après le premier segment). */
  params: Record<string, string>;
};

export type TestProxy = {
  url: string;
  port: number;
  exitIp: string;
  log: ProxyLogEntry[];
  /** Connexions TCP reçues (même sans CONNECT). */
  connections(): number;
  close(): Promise<void>;
};

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

function parseAuth(req: IncomingMessage): { username: string | null; password: string | null; params: Record<string, string> } {
  const header = req.headers['proxy-authorization'];
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return { username: null, password: null, params: {} };
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  const username = decoded.slice(0, colon);
  const password = decoded.slice(colon + 1);
  const parts = username.split('-');
  const params: Record<string, string> = {};
  for (let i = 1; i + 1 < parts.length; i += 2) params[parts[i] as string] = parts[i + 1] as string;
  return { username, password, params };
}

export async function startTestProxy(options: { exitIp: string; registry: ExitRegistry; password?: string }): Promise<TestProxy> {
  const log: ProxyLogEntry[] = [];
  let connections = 0;
  const server = createServer((_req, res) => res.writeHead(405).end('connect_only'));
  server.on('connection', () => (connections += 1));
  server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on('error', () => client.destroy());
    const auth = parseAuth(req);
    log.push({ target: req.url ?? '', ...auth });
    if (options.password !== undefined && auth.password !== options.password) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const [host, port] = (req.url ?? '').split(':');
    const upstream: Socket = connect({ host: host === 'localhost' ? '127.0.0.1' : host, port: Number(port) });
    upstream.once('connect', () => {
      options.registry.set(upstream.localPort ?? 0, options.exitIp);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client).pipe(upstream);
    });
    upstream.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'));
    client.once('close', () => upstream.destroy());
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, port, exitIp: options.exitIp, log, connections: () => connections, close: () => stop(server) };
}

export type IpFixture = {
  origin: string;
  /** IP de sortie vue par la fixture pour chaque requête reçue, dans l'ordre. */
  seen: { path: string; ip: string }[];
  close(): Promise<void>;
};

/**
 * Fixture cible : `/ip` rend l'IP de sortie vue ; `/status/NNN` rend ce code (401, 403, 429, 451…) ;
 * `/geo` rend 451 si la requête vient en direct (IP réelle), 200 sinon.
 */
export async function startIpFixture(registry: ExitRegistry): Promise<IpFixture> {
  const seen: { path: string; ip: string }[] = [];
  const server = createServer((req, res) => {
    const ip = registry.get(req.socket.remotePort ?? -1) ?? req.socket.remoteAddress ?? '?';
    const path = req.url ?? '/';
    seen.push({ path, ip });
    const status = /^\/status\/(\d{3})$/.exec(path);
    if (status !== null) {
      const code = Number(status[1]);
      res.writeHead(code, code === 429 ? { 'retry-after': '1' } : {}).end(`status ${code}`);
      return;
    }
    if (path === '/geo') {
      const direct = !registry.has(req.socket.remotePort ?? -1);
      res.writeHead(direct ? 451 : 200, { 'content-type': 'application/json' }).end(JSON.stringify({ ip }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ip }));
  });
  const port = await listen(server);
  return { origin: `http://127.0.0.1:${port}`, seen, close: () => stop(server) };
}
