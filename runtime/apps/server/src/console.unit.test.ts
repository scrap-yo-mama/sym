// SPDX-License-Identifier: AGPL-3.0-only
// assert_console_served (constat F-20261002-09, 03 « Serveur HTTP » : REST + MCP + tunnel + console dans un seul service) : le
// serveur sert le build de la console (apps/web/dist) à la racine, avec repli SPA vers index.html pour les routes de la console,
// jamais pour /api, /mcp, /tunnel, /hooks, /.well-known ni /metrics ; cache long sur les fichiers hachés, no-cache sur index.html.
// assert_csp_headers (08b § 2) : CSP stricte, Referrer-Policy, COOP, nosniff ; HSTS seulement si PUBLIC_URL est en HTTPS.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildServer } from './app.js';
import { defaultConsoleDir } from './console.js';
import type { ServerContext } from './context.js';

/** CSP stricte de la console, texte de 08b § 2 (même valeur que apps/web/e2e/csp.ts, CONSOLE_CSP). */
const CSP_08B =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
const INDEX = '<!doctype html><html><head><title>zz_test_console</title><script type="module" src="/assets/index-zzTest01.js"></script></head><body><div id="app"></div></body></html>';
const HASHED_JS = 'console.log("zz_test_hashed");';
const ONE_YEAR = 31_536_000;

let scratch = '';
let consoleDir = '';
const apps: FastifyInstance[] = [];

/** Contexte minimal : une requête hors registre ne touche ni la base ni l'authentification (garde : chemin inconnu). */
const fakeCtx = (publicUrl: string) => ({ publicUrl, tunnel: null }) as unknown as ServerContext;

async function server(options: { publicUrl?: string; consoleDir?: string | null } = {}): Promise<FastifyInstance> {
  const app = buildServer(fakeCtx(options.publicUrl ?? 'http://localhost:3000'), { consoleDir: options.consoleDir === undefined ? consoleDir : options.consoleDir });
  apps.push(app);
  await app.ready();
  return app;
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zz_test_console-'));
  consoleDir = join(scratch, 'dist');
  mkdirSync(join(consoleDir, 'assets'), { recursive: true });
  writeFileSync(join(consoleDir, 'index.html'), INDEX);
  writeFileSync(join(consoleDir, 'assets', 'index-zzTest01.js'), HASHED_JS);
  writeFileSync(join(consoleDir, 'assets', 'index-zzTest01.css'), 'body{color:red}');
  writeFileSync(join(consoleDir, 'theme-init.js'), 'void 0;');
  writeFileSync(join(consoleDir, '.env'), 'ZZ_TEST_DOTFILE=1');
  // Fichier voisin du dossier servi : jamais atteignable par un chemin de la console.
  writeFileSync(join(scratch, 'zz_test_secret.txt'), 'zz_test_outside');
});

afterAll(async () => {
  for (const app of apps) await app.close();
  rmSync(scratch, { recursive: true, force: true });
});

const expectIndex = (res: { statusCode: number; headers: Record<string, unknown>; body: string }, what: string) => {
  expect(res.statusCode, what).toBe(200);
  expect(String(res.headers['content-type']), what).toMatch(/^text\/html/);
  expect(res.body, what).toBe(INDEX);
  expect(res.headers['cache-control'], what).toBe('no-cache');
};

const expectNotFoundJson = (res: { statusCode: number; headers: Record<string, unknown>; body: string }, what: string) => {
  expect(res.statusCode, what).toBe(404);
  expect(String(res.headers['content-type']), what).toMatch(/^application\/json/);
  expect(JSON.parse(res.body), what).toEqual({ error: { code: 'not_found', message: 'ressource introuvable' } });
};

describe('assert_console_served — la console est servie par le serveur, à la racine', () => {
  test('GET / → 200, index.html de la console, no-cache', async () => {
    const app = await server();
    expectIndex(await app.inject({ method: 'GET', url: '/' }), '/');
    expectIndex(await app.inject({ method: 'GET', url: '/index.html' }), '/index.html');
  });

  test('routes de la console (routeur côté client) → index.html, requête comprise', async () => {
    const app = await server();
    for (const url of ['/runs', '/apis/new/0193b1c2', '/settings/models', '/invite/zz_test_token', '/setup', '/une/route/console', '/login?sso_error=x']) {
      expectIndex(await app.inject({ method: 'GET', url }), url);
    }
  });

  test('fichiers hachés (assets/) : type exact, cache long immuable ; autres fichiers : no-cache', async () => {
    const app = await server();
    const js = await app.inject({ method: 'GET', url: '/assets/index-zzTest01.js' });
    expect(js.statusCode).toBe(200);
    expect(js.body).toBe(HASHED_JS);
    expect(String(js.headers['content-type'])).toMatch(/^(text|application)\/javascript/);
    expect(js.headers['cache-control']).toBe(`public, max-age=${ONE_YEAR}, immutable`);
    const css = await app.inject({ method: 'GET', url: '/assets/index-zzTest01.css' });
    expect(String(css.headers['content-type'])).toMatch(/^text\/css/);
    expect(css.headers['cache-control']).toBe(`public, max-age=${ONE_YEAR}, immutable`);
    const theme = await app.inject({ method: 'GET', url: '/theme-init.js' });
    expect(theme.statusCode).toBe(200);
    expect(theme.headers['cache-control']).toBe('no-cache');
  });

  test('jamais de repli SPA pour /api, /mcp, /tunnel, /hooks, /.well-known, /metrics : 404 JSON uniforme', async () => {
    const app = await server();
    for (const url of ['/api', '/api/', '/api/inconnu', '/api/une/route/inconnue?x=1', '/mcp', '/mcp/zz', '/tunnel', '/tunnel/zz', '/hooks', '/hooks/zz', '/.well-known/zz', '/metrics/zz']) {
      expectNotFoundJson(await app.inject({ method: 'GET', url }), url);
    }
  });

  test('fichier absent avec extension (asset manquant) : 404 JSON, jamais du HTML servi pour un script', async () => {
    const app = await server();
    for (const url of ['/assets/absent-zz.js', '/absent.css', '/favicon.ico']) expectNotFoundJson(await app.inject({ method: 'GET', url }), url);
  });

  test('aucune sortie du dossier servi (traversée encodée), aucun fichier caché', async () => {
    const app = await server();
    for (const url of ['/..%2fzz_test_secret.txt', '/%2e%2e/zz_test_secret.txt', '/assets/..%2f..%2fzz_test_secret.txt', '/%2e%2e%2fzz_test_secret.txt', '/.env', '/assets/%00.js']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body, url).not.toContain('zz_test_outside');
      expect(res.body, url).not.toContain('ZZ_TEST_DOTFILE');
      expect([400, 404], url).toContain(res.statusCode);
    }
  });

  test('seuls GET et HEAD : une mutation sur une route de la console répond 404 JSON', async () => {
    const app = await server();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) expectNotFoundJson(await app.inject({ method, url: '/runs' }), `${method} /runs`);
    const head = await app.inject({ method: 'HEAD', url: '/' });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
  });

  test('sans build de la console : 404 JSON, aucun repli', async () => {
    for (const dir of [null, join(scratch, 'zz_test_absent')]) {
      const app = await server({ consoleDir: dir });
      expectNotFoundJson(await app.inject({ method: 'GET', url: '/' }), `/ (${String(dir)})`);
      expectNotFoundJson(await app.inject({ method: 'GET', url: '/runs' }), `/runs (${String(dir)})`);
    }
  });

  test('emplacement par défaut : apps/web/dist, voisin du serveur (image : /app/apps/web/dist)', () => {
    expect(defaultConsoleDir()).toBe(new URL('../../web/dist', import.meta.url).pathname);
  });

  test('deploy/Dockerfile : construit @runtime/web et copie son dist à l’emplacement lu par le serveur', () => {
    const dockerfile = readFileSync(new URL('../../../deploy/Dockerfile', import.meta.url), 'utf8');
    const build = /^RUN .*pnpm -r (.*) build$/m.exec(dockerfile);
    expect(build, 'ligne de build de l’étape build').not.toBeNull();
    expect(build?.[1]).not.toMatch(/@runtime\/web/);
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
    expect(runtimeStage).toMatch(/^COPY --from=build \/app\/apps\/web\/dist apps\/web\/dist$/m);
    // Le serveur (apps/server/dist) est copié dans /app comme la console : `defaultConsoleDir` = /app/apps/web/dist.
    expect(runtimeStage).toMatch(/^WORKDIR \/app$/m);
    expect(runtimeStage).toMatch(/^COPY --from=build \/app\/apps\/server\/dist apps\/server\/dist$/m);
  });
});

describe('assert_csp_headers — CSP stricte et en-têtes de 08b § 2', () => {
  test('console : CSP de 08b, Referrer-Policy no-referrer, COOP same-origin, nosniff, aucun cadre', async () => {
    const app = await server();
    for (const url of ['/', '/runs', '/assets/index-zzTest01.js']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['content-security-policy'], url).toBe(CSP_08B);
      expect(res.headers['referrer-policy'], url).toBe('no-referrer');
      expect(res.headers['cross-origin-opener-policy'], url).toBe('same-origin');
      expect(res.headers['x-content-type-options'], url).toBe('nosniff');
      expect(res.headers['x-frame-options'], url).toBe('DENY');
      expect(res.headers['strict-transport-security'], url).toBeUndefined();
    }
  });

  test('API (404 JSON compris) : mêmes en-têtes', async () => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/api/inconnu' });
    expect(res.headers['content-security-policy']).toBe(CSP_08B);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  test('HSTS seulement si PUBLIC_URL est en HTTPS', async () => {
    const app = await server({ publicUrl: 'https://runtime.zz-test.example' });
    for (const url of ['/', '/api/inconnu']) {
      expect((await app.inject({ method: 'GET', url })).headers['strict-transport-security'], url).toBe('max-age=31536000; includeSubDomains');
    }
  });
});
