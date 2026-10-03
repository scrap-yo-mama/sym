// SPDX-License-Identifier: AGPL-3.0-only
// Banc E2E de la console (tâches 3.5 et 3.6) : sert la console construite (dist/) en boucle locale, sur un port éphémère,
// avec la CSP stricte de la passerelle (04d § 5, 03 § 7), le faux serveur d'authentification (routes prévues pour 2.1) et
// la simulation des écrans (routes de 04 § 2), dont la vue en direct sur un vrai WebSocket (`/v1/sessions/{id}/live/stream`,
// jeton à usage unique, 04d § 1). Aucun réseau extérieur, aucune base. Le serveur est fermé par `close()` : aucun
// processus n'est lancé ni signalé.
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createFakeConsoleServer } from '../src/testing/fake-server.ts';
import { createMockConsoleApi } from '../src/testing/mock-console.ts';
import { createMockAuthApi, type MockAuthOptions } from '../src/testing/mock-auth.ts';

export const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

/** CSP de la console en production : aucun script ni style en ligne, aucune origine tierce. */
const CONSOLE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

export type Harness = {
  url: string;
  requests: string[];
  /** Entrées de la vue en direct reçues par le relais simulé (transmises en `rw`, écartées en `ro`). */
  liveStats: (sessionId: string) => { forwarded: number; dropped: number };
  close: () => Promise<void>;
};

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

async function staticFile(pathname: string): Promise<{ body: Buffer; type: string } | undefined> {
  const file = normalize(join(DIST, decodeURIComponent(pathname)));
  if (!file.startsWith(DIST) || file.endsWith(sep)) return undefined;
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  return { body: await readFile(file), type: TYPES[extname(file)] ?? 'application/octet-stream' };
}

export async function startConsole(options: MockAuthOptions): Promise<Harness> {
  const screens = createMockConsoleApi();
  const api = createFakeConsoleServer(createMockAuthApi(options), screens);
  const live = new WebSocketServer({ noServer: true });
  const requests: string[] = [];

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push(`${req.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname.startsWith('/v1/')) {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
      const response = await api(new Request(url, { method: req.method, headers, body: body ? new Uint8Array(body) : undefined }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const file = (await staticFile(url.pathname)) ?? (await staticFile('index.html'));
    if (!file) {
      res.writeHead(500).end('dist/ absent : lance `pnpm --filter @sym-browser/console build`');
      return;
    }
    res.writeHead(200, { 'content-type': file.type, 'content-security-policy': CONSOLE_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.end(file.body);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.writeHead(500).end());
  });
  // Vue en direct : jeton échangé contre la session et le mode, puis relais des messages de 04d § 1.2.
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = /^\/v1\/sessions\/([^/]+)\/live\/stream$/.exec(url.pathname);
    const ticket = match ? api.redeemLiveToken(url.searchParams.get('t') ?? '') : undefined;
    if (!match || !ticket || ticket.sessionId !== decodeURIComponent(match[1]!)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    live.handleUpgrade(req, socket, head, (ws) => {
      void screens.openLive(ticket.sessionId, ticket.mode).then((opened) => {
        if (!opened.ok) {
          ws.close(1008);
          return;
        }
        const connection = opened.data;
        connection.onMessage((message) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
          if (message.t === 'closed') ws.close(1000);
        });
        ws.on('message', (raw) => {
          try {
            connection.send(JSON.parse(String(raw)));
          } catch {
            // message illisible : ignoré
          }
        });
        ws.on('close', () => connection.close());
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    liveStats: (sessionId) => screens.liveStats(sessionId),
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of live.clients) client.terminate();
        live.close();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
