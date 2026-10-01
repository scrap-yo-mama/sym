// SPDX-License-Identifier: AGPL-3.0-only
// Harnais E2E de la console (tâche 3.9) : la console construite par Vite est servie en boucle locale (port éphémère) par un
// faux serveur d'API qui répond avec des objets conformes à l'OpenAPI et qui tient le flux SSE de l'onglet. Aucune base,
// aucun site réel : seul le rendu et le comportement au clavier sont jugés ici ; le parcours complet contre une instance
// réelle est celui de 3.6.
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { build } from 'vite';
import { CONSOLE_CSP } from './csp.ts';

type ApiReply = { status?: number; body?: unknown };
type ApiRequest = { method: string; path: string; params: Record<string, string>; query: URLSearchParams; body: unknown };
type ApiHandler = (request: ApiRequest) => ApiReply | Promise<ApiReply>;
/** « MÉTHODE /chemin/:paramètre » → réponse. */
export type ApiRoutes = Record<string, ApiHandler | ApiReply>;

export type ConsoleApp = {
  url: string;
  /** Remplace les routes de l'API (les écrans lisent leurs données au montage). */
  setRoutes: (routes: ApiRoutes) => void;
  /** Attend que les lectures de données soient revenues et que l'écran ait eu le temps de s'afficher (le flux SSE, ouvert en permanence, ne compte pas). */
  settled: () => Promise<void>;
  /** Requêtes d'API reçues, « MÉTHODE /chemin?requête », dans l'ordre. */
  requests: string[];
  /** Requêtes d'API sans route : une console propre n'en émet pas. */
  unmatched: string[];
  /** Pousse une trame sur chaque flux `GET /api/events` ouvert. */
  pushEvent: (event: string, data: unknown, id?: string) => void;
  /** Trames rejouées par `GET /api/runs/{id}/events` pour un run (le flux se termine ensuite, comme un run fini). */
  setRunEvents: (runId: string, frames: { event: string; data: unknown }[]) => void;
  /** Coupe les flux ouverts (le client voit une fin de réponse et reconnecte). */
  dropStreams: () => void;
  /** Nombre de flux `GET /api/events` ouverts. */
  openStreams: () => number;
  close: () => Promise<void>;
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const WEB_DIR = new URL('..', import.meta.url).pathname;

function matchRoute(pattern: string, method: string, path: string): Record<string, string> | null {
  const [routeMethod, routePath] = pattern.split(' ') as [string, string];
  if (routeMethod !== method) return null;
  const want = routePath.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (const [index, part] of want.entries()) {
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(got[index] ?? '');
    else if (part !== got[index]) return null;
  }
  return params;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Construit la console dans un dossier temporaire et la sert avec un faux serveur d'API. */
export async function startConsole(): Promise<ConsoleApp> {
  const outDir = mkdtempSync(join(tmpdir(), 'zz_test_console-'));
  await build({ root: WEB_DIR, logLevel: 'silent', configFile: join(WEB_DIR, 'vite.config.ts'), build: { outDir, emptyOutDir: true } });

  let routes: ApiRoutes = {};
  const unmatched: string[] = [];
  const requests: string[] = [];
  let inFlight = 0;
  const streams = new Set<ServerResponse>();
  const runEvents = new Map<string, { event: string; data: unknown }[]>();

  const serveStatic = (path: string, res: ServerResponse): void => {
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
    let file = join(outDir, safe);
    try {
      if (!statSync(file).isFile()) throw new Error('not a file');
    } catch {
      // Chemin de la console (routeur côté client) : on rend index.html.
      file = join(outDir, 'index.html');
    }
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    // CSP stricte de la console (08b § 2) sur chaque page servie : toute violation fait échouer le test (assert_no_csp_violation).
    res.setHeader('content-security-policy', CONSOLE_CSP);
    res.end(readFileSync(file));
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
      const method = req.method ?? 'GET';
      requests.push(`${method} ${url.pathname}${url.search}`);

      if (method === 'GET' && (url.pathname === '/api/events' || /^\/api\/runs\/[^/]+\/events$/.test(url.pathname))) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': ping\n\n');
        if (url.pathname === '/api/events') {
          streams.add(res);
          res.on('close', () => streams.delete(res));
        } else {
          // Flux filtré d'un run : les trames enregistrées, puis la lecture se termine proprement.
          const runId = decodeURIComponent(url.pathname.split('/')[3] ?? '');
          const frames = (runEvents.get(runId) ?? []).map((frame, index) => `id: ${index + 1}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
          res.end(frames.join(''));
        }
        return;
      }

      inFlight += 1;
      res.on('close', () => (inFlight -= 1));
      const body = method === 'GET' || method === 'DELETE' ? null : await readBody(req);
      for (const [pattern, entry] of Object.entries(routes)) {
        const params = matchRoute(pattern, method, url.pathname);
        if (!params) continue;
        const reply = typeof entry === 'function' ? await entry({ method, path: url.pathname, params, query: url.searchParams, body }) : entry;
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        // `body: null` est une réponse JSON `null` (la sonde de session sans session) ; sans `body`, un objet vide.
        res.end(reply.status === 204 ? undefined : JSON.stringify(reply.body === undefined ? {} : reply.body));
        return;
      }
      unmatched.push(`${method} ${url.pathname}`);
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'zz_test: route absente du faux serveur' } }));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    setRoutes: (next) => {
      routes = next;
      unmatched.length = 0;
      requests.length = 0;
    },
    unmatched,
    requests,
    settled: async () => {
      // Aucune lecture en vol pendant 300 ms d'affilée : l'écran a reçu ses données et les a rendues.
      let quiet = 0;
      for (let waited = 0; quiet < 300 && waited < 15_000; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        quiet = inFlight === 0 ? quiet + 50 : 0;
      }
    },
    setRunEvents: (runId, frames) => void runEvents.set(runId, frames),
    pushEvent: (event, data, id) => {
      const frame = `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const stream of streams) stream.write(frame);
    },
    dropStreams: () => {
      for (const stream of [...streams]) stream.destroy();
      streams.clear();
    },
    openStreams: () => streams.size,
    close: async () => {
      for (const stream of streams) stream.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(outDir, { recursive: true, force: true });
    },
  };
}
