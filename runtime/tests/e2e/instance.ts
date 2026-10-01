// SPDX-License-Identifier: AGPL-3.0-only
// Instance réelle pour les E2E de la console (tâche 3.8) : PostgreSQL jetable (Testcontainers), serveur réel (dist) sur un port
// éphémère, et un relais local qui sert la console construite (apps/web/dist) et transmet `/api/*` au serveur : le navigateur voit une
// seule origine, comme derrière le reverse proxy d'un déploiement, et `PUBLIC_URL` est cette origine (contrôle d'Origin, 13 § 5).
// MASTER_KEY et jeton d'amorçage sont générés à l'exécution (aucun secret en dur) ; rien n'écrit hors du conteneur et du dossier système.
import { randomBytes } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { createServer, request as httpRequest, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { generateMasterKey } from '@runtime/core';
import { migrateUp } from '@runtime/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { prepareServer } from '../../apps/server/dist/start.js';

const CONSOLE_DIR = new URL('../../apps/web/dist', import.meta.url).pathname;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

export type Instance = {
  /** Origine de la console et de l'API (= `PUBLIC_URL`). */
  url: string;
  bootstrapToken: string;
  masterKey: string;
  sql: <T extends Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;
  close: () => Promise<void>;
};

/** Sert un fichier de la console ; un chemin inconnu rend `index.html` (routeur côté client). */
function serveConsole(path: string, res: ServerResponse): void {
  const safe = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '');
  let file = join(CONSOLE_DIR, safe);
  try {
    if (!statSync(file).isFile()) throw new Error('not a file');
  } catch {
    file = join(CONSOLE_DIR, 'index.html');
  }
  res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
  createReadStream(file).pipe(res);
}

/** Démarre l'instance ; `env` complète l'environnement du serveur (ex. `MFA_ENFORCED`). */
export async function startInstance(env: NodeJS.ProcessEnv = {}): Promise<Instance> {
  const cleanups: (() => Promise<void>)[] = [];
  const close = async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  };
  try {
    const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(`postgres:${process.env.PG_VERSION ?? '16'}`).start();
    cleanups.push(async () => void (await container.stop()));
    const dbUrl = container.getConnectionUri();
    await migrateUp({ connectionString: dbUrl });

    // Le relais écoute d'abord : son port fixe PUBLIC_URL, que le serveur doit connaître au démarrage.
    let apiPort = 0;
    const front: Server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      if (!path.startsWith('/api/') && !path.startsWith('/.well-known/')) return serveConsole(path, res);
      const upstream = httpRequest({ host: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers: req.headers }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      upstream.on('error', () => {
        res.statusCode = 502;
        res.end();
      });
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    });
    await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => {
      front.closeAllConnections();
      await new Promise<void>((resolve) => front.close(() => resolve()));
    });
    const url = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;

    const masterKey = generateMasterKey();
    const bootstrapToken = randomBytes(32).toString('base64url');
    const started = await prepareServer({ DATABASE_URL: dbUrl, MASTER_KEY: masterKey, PUBLIC_URL: url, ADMIN_BOOTSTRAP_TOKEN: bootstrapToken, ...env });
    cleanups.push(() => started.close());
    await started.app.listen({ port: 0, host: '127.0.0.1' });
    apiPort = (started.app.server.address() as AddressInfo).port;

    const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
    cleanups.push(() => pool.end());
    const sql = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await pool.query<T>(text, params)).rows;
    return { url, bootstrapToken, masterKey, sql, close };
  } catch (error) {
    await close();
    throw error;
  }
}
