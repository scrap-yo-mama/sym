// SPDX-License-Identifier: AGPL-3.0-only
// Console servie par le serveur (03 « Serveur HTTP » : REST + MCP + tunnel + console dans un seul service ; constat
// F-20261002-09) : build de apps/web (dist) à la racine, repli SPA vers index.html pour les routes du routeur côté client,
// jamais pour les préfixes du serveur. Aucune route Fastify n'est déclarée (registre INV12) : la console passe par le
// gestionnaire 404, après le garde (chemin inconnu : ni base ni identité). En-têtes de sécurité de 08b § 2 sur toute réponse.
import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** CSP stricte de la console (08b § 2) : aucune source tierce, ni script ni style en ligne. */
const CONSOLE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

/**
 * Préfixes du serveur : jamais de repli vers la console (404 JSON uniforme), même sous un segment exact (`/api`), quelle que
 * soit la casse (`/API/x`) et avec un paramètre de chemin (`/api;x`) : comparés en minuscules, premier segment coupé au `;`.
 */
const SERVER_PREFIXES = ['/api', '/mcp', '/tunnel', '/hooks', '/.well-known', '/metrics'];

/** Fichiers hachés par Vite (nom changé à chaque contenu) : cache long immuable. */
const HASHED_PREFIX = '/assets/';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Emplacement du build de la console : apps/web/dist, voisin du serveur (image : /app/apps/web/dist, deploy/Dockerfile). */
export function defaultConsoleDir(): string {
  return fileURLToPath(new URL('../../web/dist', import.meta.url));
}

/**
 * En-têtes de 08b § 2 : CSP, Referrer-Policy, COOP, nosniff, aucun cadre ; HSTS seulement si PUBLIC_URL est en HTTPS.
 * Posés à la main (hook onSend de app.ts) au lieu de @fastify/helmet : liste exacte de 08b § 2, sans les autres en-têtes par
 * défaut de helmet (décision D-FCS-1 du journal). `X-Frame-Options: DENY` et `frame-ancestors 'none'` valent pour toute
 * réponse : un futur aperçu HTML de dataset (08b § 2, `<iframe sandbox>`) sera servi par une origine distincte, ou sa seule
 * route posera ses propres en-têtes (le hook garde un en-tête déjà posé).
 */
export function securityHeaders(publicUrl: string): Record<string, string> {
  return {
    'content-security-policy': CONSOLE_CSP,
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...(publicUrl.startsWith('https://') ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

/**
 * Chemin de la console demandé (décodé, sans requête), ou null : préfixe du serveur, segment `.`/`..`, fichier caché,
 * octet nul, barre oblique inverse ou encodage invalide.
 */
function consolePath(url: string): string | null {
  const raw = url.split('?')[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter((s) => s !== '');
  if (segments.some((s) => s.startsWith('.'))) return null;
  const path = '/' + segments.join('/');
  const probe = path.toLowerCase().split(';')[0] ?? '';
  if (SERVER_PREFIXES.some((prefix) => probe === prefix || probe.startsWith(prefix + '/'))) return null;
  return path;
}

async function regularFileUnder(root: string, path: string): Promise<boolean> {
  try {
    const real = await realpath(join(root, path));
    return real.startsWith(root + sep) && (await stat(real)).isFile();
  } catch {
    return false;
  }
}

/**
 * Prépare la console : `serveConsole` sert un fichier du build, ou index.html pour une route du routeur côté client ;
 * renvoie false si la requête n'est pas pour la console (le 404 JSON s'applique). Sans build (dossier sans index.html) :
 * toujours false, et un avertissement au démarrage.
 */
export function registerConsole(app: FastifyInstance, consoleDir: string | null): (request: FastifyRequest, reply: FastifyReply) => Promise<boolean> {
  if (consoleDir === null) return async () => false;
  if (!existsSync(join(consoleDir, 'index.html'))) {
    app.log.warn({ consoleDir }, 'console absente (build de apps/web introuvable) : seule l’API répond');
    return async () => false;
  }
  // `serve: false` : aucune route déclarée, seulement `reply.sendFile` (type, ETag, Range, HEAD, chemin borné à la racine).
  void app.register(fastifyStatic, { root: consoleDir, serve: false, dotfiles: 'deny', index: false, cacheControl: false });
  let root: string | null = null;
  const tried = new WeakSet<FastifyRequest>();
  return async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
    // `sendFile` rappelle le gestionnaire 404 si le fichier disparaît entre-temps : une seule tentative par requête.
    if (tried.has(request)) return false;
    const path = consolePath(request.url);
    if (path === null) return false;
    root ??= await realpath(consoleDir);
    let file = 'index.html';
    if (await regularFileUnder(root, path)) file = path.slice(1);
    // Fichier absent avec extension (script, feuille, image) : 404, jamais du HTML à la place.
    else if (/\.[^/]*$/.test(path)) return false;
    tried.add(request);
    if (path.startsWith(HASHED_PREFIX) && file !== 'index.html') {
      reply.sendFile(file, root, { cacheControl: true, maxAge: ONE_YEAR_MS, immutable: true });
    } else {
      reply.header('cache-control', 'no-cache');
      reply.sendFile(file, root, { cacheControl: false });
    }
    return true;
  };
}
