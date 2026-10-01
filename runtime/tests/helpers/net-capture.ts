// Intercepteur réseau global (INV9, 15 § 7) : enregistre chaque connexion sortante (sockets, fetch, undici, http) avec sa
// destination hôte:port, et refuse toute destination non locale. Sert à prouver « 0 requête vers un collecteur sans opt-in »
// et « 0 destination hors {cibles, LLM, SMTP, webhooks, OTLP configurés} ». Les tests d'un même fichier s'y abonnent en série.
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import diagnostics from 'node:diagnostics_channel';
import type { AddressInfo } from 'node:net';
import net from 'node:net';

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);

export type NetCapture = {
  /** Destinations (`hôte:port`) de toutes les connexions ouvertes depuis `start`, locales ou non. */
  connections: string[];
  /** Destinations non locales (refusées : la connexion échoue). */
  nonLocal: string[];
  stop: () => void;
};

export function captureNetwork(): NetCapture {
  const connections: string[] = [];
  const nonLocal: string[] = [];
  const originalConnect = net.Socket.prototype.connect;
  const originalFetch = globalThis.fetch;
  const note = (host: string | undefined | null, port: number | string | undefined, what: string): boolean => {
    const h = (host ?? '').toLowerCase();
    if (h.startsWith('/')) return false; // socket Unix
    const label = `${h || 'localhost'}:${port ?? ''}`;
    connections.push(`${what} ${label}`);
    if (LOCAL.has(h)) return false;
    nonLocal.push(`${what} ${label}`);
    return true;
  };
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    // `net.connect` passe les arguments déjà normalisés : `[options, callback]`.
    const raw = args[0] as unknown;
    const first = (Array.isArray(raw) ? raw[0] : raw) as { host?: string; port?: number; path?: string } | number | string;
    if (typeof first === 'object' && first.path) return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
    const host = typeof first === 'object' ? (first.host ?? 'localhost') : typeof args[1] === 'string' ? args[1] : 'localhost';
    const port = typeof first === 'object' ? first.port : first;
    if (note(host, port, 'socket')) throw new Error(`INV9 : connexion sortante bloquée vers ${host}`);
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    if (!LOCAL.has(url.hostname)) {
      nonLocal.push(`fetch ${url.host}`);
      throw new Error(`INV9 : requête sortante bloquée vers ${url.hostname}`);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  const onHttp = (m: unknown) => {
    const r = (m as { request?: { host?: string } }).request;
    if (r?.host && !LOCAL.has(r.host.toLowerCase())) nonLocal.push(`http ${r.host}`);
  };
  diagnostics.subscribe('http.client.request.start', onHttp);
  return {
    connections,
    nonLocal,
    stop: () => {
      net.Socket.prototype.connect = originalConnect;
      globalThis.fetch = originalFetch;
      diagnostics.unsubscribe('http.client.request.start', onHttp);
    },
  };
}

export type RecordedRequest = { method: string; url: string; headers: IncomingHttpHeaders; body: Buffer };

/** Serveur HTTP local qui enregistre tout ce qu'il reçoit (cible, faux LLM ou collecteur OTLP de test). */
export async function startRecorder(respond: (req: RecordedRequest) => { status?: number; body?: string; type?: string } = () => ({ body: 'ok' })): Promise<{
  port: number;
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(recorded);
      const out = respond(recorded);
      // `connection: close` : chaque appel ouvre sa propre connexion (les destinations de deux scénarios se comparent).
      res.writeHead(out.status ?? 200, { 'content-type': out.type ?? 'text/plain', connection: 'close' });
      res.end(out.body ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export type RecordedProxyRequest = { method: string; url: string; headers: IncomingHttpHeaders };

/**
 * Proxy HTTP de test (comme un proxy BYO d'admin) : forme absolue (`GET http://hôte/chemin`, relayée) et tunnel `CONNECT`.
 * Enregistre la ligne de requête et les en-têtes reçus PAR LE PROXY : un `traceparent` envoyé au proxy y apparaîtrait.
 */
export async function startProxy(): Promise<{ port: number; url: string; requests: RecordedProxyRequest[]; close: () => Promise<void> }> {
  const requests: RecordedProxyRequest[] = [];
  const sockets = new Set<net.Socket>();
  const server: Server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    const target = new URL(req.url ?? '');
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = httpRequest(
      { host: target.hostname, port: target.port, method: req.method, path: `${target.pathname}${target.search}`, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  server.on('connect', (req: IncomingMessage, client: net.Socket, head: Buffer) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    const [host, port] = (req.url ?? '').split(':');
    const upstream = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
      s.on('error', () => s.destroy());
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Destinations (`hôte:port`) distinctes des connexions relevées, sans le type de connexion. */
export function destinations(capture: NetCapture): Set<string> {
  return new Set(capture.connections.map((c) => c.slice(c.indexOf(' ') + 1)));
}
