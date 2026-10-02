// SPDX-License-Identifier: AGPL-3.0-only
// Serveur statique qui reproduit GitHub Pages (22 § 2.9, préproduction) : le build de production servi sous son chemin de base
// (`/sym/`), SANS aucun en-tête de sécurité (ni CSP, ni nosniff : seule la balise meta de chaque page protège), URL propres
// (`/page` sert `page.html`), `404.html` pour une page absente, compression gzip des textes. Aucun déploiement : un port éphémère
// de la boucle locale. Partagé par les tests E2E de la landing et par la sonde hebdomadaire (scripts/vitrine/landing-probe.ts).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { gzipSync } from 'node:zlib';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.md': 'text/markdown; charset=utf-8',
};
const COMPRESSIBLE = /^(text\/|application\/(json|xml)|image\/svg)/;

export type PagesServer = {
  /** Adresse de la racine du site (avec le chemin de base), sans barre finale : `http://127.0.0.1:PORT/sym`. */
  url: string;
  origin: string;
  /** Chemins demandés, dans l'ordre (pour compter les requêtes d'un test). */
  requests: string[];
  close: () => Promise<void>;
};

function resolveFile(dist: string, path: string): string | undefined {
  const clean = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '');
  const candidates = [clean, `${clean}.html`, join(clean, 'index.html')].map((candidate) => join(dist, candidate));
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

export async function startPagesServer(dist: string, base = '/sym/'): Promise<PagesServer> {
  const prefix = base.replace(/\/$/, '');
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push(url.pathname);
    // Hors du chemin de base, GitHub Pages ne sert rien : 404 sans corps du site.
    const inside = url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
    const relative = inside ? url.pathname.slice(prefix.length) || '/' : undefined;
    let file = relative === undefined ? undefined : resolveFile(dist, relative);
    let status = 200;
    if (!file) {
      status = 404;
      file = inside && existsSync(join(dist, '404.html')) ? join(dist, '404.html') : undefined;
    }
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    let body: Buffer = readFileSync(file);
    const headers: Record<string, string> = { 'content-type': type, 'cache-control': 'max-age=600' };
    if (COMPRESSIBLE.test(type) && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      body = gzipSync(body);
      headers['content-encoding'] = 'gzip';
    }
    headers['content-length'] = String(body.length);
    res.writeHead(status, headers).end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${prefix}`,
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
