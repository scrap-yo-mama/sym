// SPDX-License-Identifier: MIT
// Serveur bouchon des tests du SDK : journalise chaque requête (méthode, chemin, en-têtes, corps) et répond par le
// gestionnaire du test. Aucun processus lancé, écoute sur 127.0.0.1 seulement.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type SeenRequest = { method: string; path: string; query: URLSearchParams; headers: IncomingMessage['headers']; body: string };
export type StubHandler = (request: SeenRequest, response: ServerResponse) => void | Promise<void>;

export type StubServer = { url: string; requests: SeenRequest[]; handle(handler: StubHandler): void; close(): Promise<void> };

export async function startStubServer(initial: StubHandler = (_req, res) => void res.writeHead(404).end()): Promise<StubServer> {
  let handler = initial;
  const requests: SeenRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stub.invalid');
      const seen: SeenRequest = { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      requests.push(seen);
      Promise.resolve(handler(seen, res)).catch(() => res.writeHead(500).end());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    handle(next) {
      handler = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-request-id': 'req_stub', ...headers });
  res.end(payload);
}
