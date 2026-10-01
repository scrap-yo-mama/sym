// SPDX-License-Identifier: AGPL-3.0-only
// Harnais E2 de l'extension : PostgreSQL jetable (Testcontainers), instance réelle en écoute sur un port éphémère,
// sites de fixtures `zz-test-*.example` servis en boucle locale (résolus par --host-resolver-rules, aucun site réel),
// Chromium en contexte persistant avec l'extension construite (dist/chrome-mv3).
// assert_no_csp_violation (tâche 3.15, E2) : chaque page du contexte (popup, pages de l'extension, sites de fixtures) relève
// ses événements `securitypolicyviolation` dans `cspViolations` ; chaque fichier de la suite échoue un test qui en a laissé
// un (`expectNoCspViolation` en afterEach). Les pages internes du navigateur (chrome://) ne sont pas les nôtres : écartées.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { generateMasterKey, hashPassword } from '@runtime/core';
import { migrateUp } from '@runtime/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { prepareServer } from '../../server/dist/start.js';

export const EXTENSION_DIR = new URL('../dist/chrome-mv3', import.meta.url).pathname;
const SITES = ['zz-test-shop.example', 'zz-test-forum.example'] as const;

export type User = { id: string; email: string; password: string; cookie: string };

export type Harness = {
  dbUrl: string;
  masterKey: string;
  publicUrl: string;
  sitePort: number;
  /** Requêtes reçues par les sites de fixtures (hôte + chemin + requête). */
  siteHits: string[];
  context: BrowserContext;
  /** Profil Chromium (persistant) et arguments de lancement : relance HORS Playwright (aucun CDP attaché). */
  profile: string;
  chromiumArgs: readonly string[];
  extensionId: string;
  serviceWorker: () => Promise<Worker>;
  owner: User;
  createMember: (email: string) => Promise<User>;
  console: (cookie: string, method: string, path: string, body?: unknown) => Promise<{ status: number; data: unknown }>;
  sql: <T extends Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;
  grantHosts: (patterns: string[]) => Promise<void>;
  popup: () => Promise<Page>;
  /** Violations de CSP relevées depuis le dernier `expectNoCspViolation` (« URL de la page — directive : ressource »). */
  cspViolations: string[];
  close: () => Promise<void>;
};

/** À appeler en afterEach : le test échoue s'il a laissé au moins une violation de CSP ; le relevé repart à vide. */
export function expectNoCspViolation(h: Harness | undefined): void {
  const violations = h?.cspViolations.splice(0) ?? [];
  if (violations.length > 0) throw new Error(`violations de la CSP (assert_no_csp_violation) :\n${violations.join('\n')}`);
}

/**
 * assert_sym_signature_rendering sur la page ouverte (tâche 3.15) : aucun nœud texte ne contient l'emoji ni « sym » en
 * minuscules ; chaque signature est l'icône en aria-hidden à côté du texte « SYM », sans deux-points (badge), jamais dans
 * un statut, une alerte ou une boîte de dialogue. Renvoie les problèmes et le nombre de signatures.
 */
export async function auditSymSignature(page: Page): Promise<{ problems: string[]; signatures: number }> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      if (text.includes('\u{1F47B}')) problems.push(`emoji dans un nœud texte : ${text.trim()}`);
      if (/\bsym\b/.test(text)) problems.push(`« sym » en minuscules : ${text.trim()}`);
    }
    for (const element of document.querySelectorAll('*')) {
      for (const attribute of element.attributes) if (attribute.value.includes('\u{1F47B}')) problems.push(`emoji dans l'attribut ${attribute.name}`);
    }
    const signatures = [...document.querySelectorAll('[data-sym-signature]')];
    for (const sig of signatures) {
      const icons = sig.querySelectorAll('svg');
      if (icons.length !== 1 || icons[0]?.getAttribute('aria-hidden') !== 'true') problems.push('icône : un svg aria-hidden attendu');
      if (sig.querySelector('.sym-signature__text')?.textContent !== 'SYM') problems.push('texte « SYM » attendu à côté de l’icône');
      if (sig.querySelector('span[aria-hidden="true"]')) problems.push('badge : pas de deux-points');
      if (sig.closest('[role="alert"], [role="status"], [role="dialog"]')) problems.push('signature dans une zone interdite');
    }
    return { problems, signatures: signatures.length };
  });
}

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/** Défi simulé (07 § 5) : page de vérification générique, comme la fixture `challenge` de 0.5. */
const CHALLENGE_PAGE =
  '<!doctype html><html><head><title>Security check</title></head><body><main id="zz-test-challenge"><h1>Security check</h1><p>Please verify you are human to continue.</p><label><input type="checkbox" disabled> I am not a robot</label></main></body></html>';

/**
 * Sites de fixtures : `/login` pose des cookies de session propres à l'hôte (valeurs `zz_test_*`). Tunnel (tâche 2.7) :
 * `/api/items?page=N&pages=P` liste JSON paginée (10 éléments par page, P pages) ; sous `/guarded/`, la page 2 et les
 * suivantes affichent un défi (403) ; `/catalog` est un catalogue HTML de 10 articles. Chaque requête reçue est consignée
 * (`hits` : hôte + chemin).
 */
function fixtureSites(hits: string[]): Server {
  return createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0] ?? '';
    const tag = host.replace(/^zz-test-/, '').replace(/\.example$/, '');
    const url = new URL(req.url ?? '/', 'http://zz-test.invalid');
    hits.push(`${host}${url.pathname}${url.search}`);
    if (url.pathname.endsWith('/api/items')) {
      const page = Number(url.searchParams.get('page') ?? '1');
      const pages = Number(url.searchParams.get('pages') ?? '3');
      if (url.pathname.startsWith('/guarded/') && page >= 2) {
        res.statusCode = 403;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(CHALLENGE_PAGE);
        return;
      }
      const items = page <= pages ? Array.from({ length: 10 }, (_, i) => ({ id: `zz_test_${tag}_${page}_${i}`, name: `Item ${page}-${i}` })) : [];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items, has_more: page < pages }));
      return;
    }
    if (url.pathname === '/catalog') {
      // Catalogue rendu côté serveur (E3 déclaratif en tunnel : navigation par le débogueur, lecture du DOM).
      const items = Array.from({ length: 10 }, (_, i) => `<article class="item"><h2>Item ${i}</h2><span class="id">zz_test_${tag}_catalog_${i}</span></article>`).join('');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><title>Catalog</title></head><body>${items}</body></html>`);
      return;
    }
    if (req.url === '/login') {
      res.setHeader('set-cookie', [`zz_test_sid=zz_test_${tag}_session; Path=/; HttpOnly; SameSite=Lax`, `zz_test_pref=${tag}; Path=/; Max-Age=86400`]);
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>${host}</title><h1>${host}</h1>`);
  });
}

async function postJson(url: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });
  return res;
}

export async function startHarness(): Promise<Harness> {
  const cleanups: (() => Promise<void>)[] = [];
  const close = async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  };
  try {
    const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(`postgres:${process.env.PG_VERSION ?? '16'}`).start();
    cleanups.push(async () => void (await container.stop()));
    const dbUrl = container.getConnectionUri();
    await migrateUp({ connectionString: dbUrl });

    // Chromium d'abord : l'identifiant de l'extension décompressée est connu avant de démarrer l'instance, qui n'accepte
    // que lui à l'ouverture de la WSS du tunnel (TUNNEL_EXTENSION_IDS, origine fermée par défaut).
    const profile = mkdtempSync(join(tmpdir(), 'zz-test-ext-'));
    cleanups.push(async () => rmSync(profile, { recursive: true, force: true }));
    const chromiumArgs = [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      `--host-resolver-rules=${SITES.map((s) => `MAP ${s} 127.0.0.1`).join(', ')}`,
    ];
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', // nouveau mode headless : extensions prises en charge (07 § 7)
      headless: true,
      args: chromiumArgs,
    });
    cleanups.push(() => context.close()); // filet si le démarrage de l'instance échoue (fermer deux fois est sans effet)
    const cspViolations: string[] = [];
    await context.exposeBinding('__zzCspViolation', ({ frame }, report: string) => {
      const url = frame.url();
      if (!url.startsWith('chrome://')) cspViolations.push(`${url} — ${report}`);
    });
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        const report = `${event.violatedDirective} : ${event.blockedURI || event.sample || 'inline'}`;
        void (window as unknown as { __zzCspViolation?: (report: string) => Promise<void> }).__zzCspViolation?.(report);
      });
    });
    const serviceWorker = async () => context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://')) ?? context.waitForEvent('serviceworker');
    const extensionId = new URL((await serviceWorker()).url()).host;

    const port = await freePort();
    const publicUrl = `http://127.0.0.1:${port}`;
    const masterKey = generateMasterKey();
    const bootstrapToken = randomBytes(32).toString('base64url');
    const started = await prepareServer({ DATABASE_URL: dbUrl, MASTER_KEY: masterKey, PUBLIC_URL: publicUrl, ADMIN_BOOTSTRAP_TOKEN: bootstrapToken, TUNNEL_EXTENSION_IDS: extensionId });
    cleanups.push(() => started.close());
    await started.app.listen({ port, host: '127.0.0.1' });

    const siteHits: string[] = [];
    const sites = fixtureSites(siteHits);
    await new Promise<void>((resolve) => sites.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => sites.close(() => resolve())));
    const sitePort = (sites.address() as AddressInfo).port;

    const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
    cleanups.push(() => pool.end());
    const sql = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await pool.query<T>(text, params)).rows;
    // Navigateur fermé EN PREMIER (nettoyage en ordre inverse), comme avant : ses connexions (WSS du tunnel, keep-alive
    // vers les sites) retiendraient sinon la fermeture de l'instance et des sites de fixtures.
    cleanups.push(() => context.close());

    const signIn = async (email: string, password: string): Promise<string> => {
      const res = await postJson(`${publicUrl}/api/auth/sign-in/email`, { origin: publicUrl }, { email, password });
      if (res.status !== 200) throw new Error(`connexion ${email} : ${res.status}`);
      const cookie = res.headers.getSetCookie().find((c) => c.includes('sy.session'));
      if (!cookie) throw new Error('aucun cookie de session');
      return cookie.split(';')[0]!;
    };
    const ownerPassword = `zz_test_${randomBytes(12).toString('base64url')}`;
    const setup = await postJson(`${publicUrl}/api/setup`, {}, { token: bootstrapToken, email: 'zz_test_owner@example.test', password: ownerPassword });
    if (setup.status !== 201) throw new Error(`setup : ${setup.status}`);
    const ownerId = ((await setup.json()) as { userId: string }).userId;
    const owner: User = { id: ownerId, email: 'zz_test_owner@example.test', password: ownerPassword, cookie: await signIn('zz_test_owner@example.test', ownerPassword) };
    const createMember = async (email: string): Promise<User> => {
      const password = `zz_test_${randomBytes(12).toString('base64url')}`;
      const [row] = await sql<{ id: string }>("INSERT INTO users (email, role, status, email_verified) VALUES ($1, 'member', 'active', true) RETURNING id", [email]);
      await sql("INSERT INTO auth_accounts (user_id, provider_id, account_id, password_hash) VALUES ($1, 'credential', $2, $3)", [row!.id, row!.id, await hashPassword(password)]);
      return { id: row!.id, email, password, cookie: await signIn(email, password) };
    };
    const consoleCall = async (cookie: string, method: string, path: string, body?: unknown) => {
      const res = await fetch(`${publicUrl}${path}`, {
        method,
        headers: { cookie, origin: publicUrl, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, data: res.status === 204 ? null : await res.json().catch(() => null) };
    };


    // Page chrome://extensions : simule le clic « Autoriser » de l'invite de permission de Chrome (UI du navigateur,
    // hors d'atteinte de Playwright). `chrome.permissions.request` du popup se résout ensuite sans invite.
    // LIMITE : le parcours réel « invite de permission affichée depuis le popup d'action, acceptée, popup toujours
    // ouvert qui termine connectSite » n'est pas exercé ici (popup ouvert dans un onglet, permission accordée d'avance) ;
    // il relève d'une vérification manuelle en recette, sur le popup d'action réel.
    const admin = await context.newPage();
    await admin.goto('chrome://extensions');
    const grantHosts = async (patterns: string[]) => {
      for (const pattern of patterns) {
        const error = await admin.evaluate(
          ([id, host]) =>
            new Promise<string | null>((resolve) => {
              const dp = (globalThis as unknown as { chrome: { developerPrivate: { addHostPermission: (i: string, h: string, cb: () => void) => void }; runtime: { lastError?: { message?: string } } } }).chrome;
              dp.developerPrivate.addHostPermission(id!, host!, () => resolve(dp.runtime.lastError?.message ?? null));
            }),
          [extensionId, pattern],
        );
        if (error) throw new Error(`permission ${pattern} : ${error}`);
      }
    };
    const popup = async () => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      return page;
    };

    return { dbUrl, masterKey, publicUrl, sitePort, siteHits, context, profile, chromiumArgs, extensionId, serviceWorker, owner, createMember, console: consoleCall, sql, grantHosts, popup, cspViolations, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export type FakeInstance = {
  origin: string;
  requests: { method: string; path: string; body: string }[];
  /** Coupe (vrai) ou rétablit l'instance : coupée, chaque connexion est fermée sans réponse (« Failed to fetch »). */
  setDown: (down: boolean) => void;
  close: () => Promise<void>;
};

/**
 * Seconde instance factice (« B ») sur 127.0.0.1 (autre port que A) : accepte n'importe quel code d'appairage et prétend que `sites`
 * sont connectés en usage serveur (instance malveillante obtenue par ingénierie sociale). Enregistre chaque requête
 * reçue pendant qu'elle est en service ; `PUT /api/extension/sites/:domain` répond 201, le reste 204.
 */
export async function fakeInstance(sites: { domain: string; serverUseAllowed: boolean; hasServerCookies: boolean }[]): Promise<FakeInstance> {
  const requests: FakeInstance['requests'] = [];
  let down = false;
  const server = createServer((req, res) => {
    if (down) {
      req.socket.destroy();
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      requests.push({ method: req.method ?? '', path, body });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && path === '/api/extension/pair') {
        res.statusCode = 201;
        res.end(JSON.stringify({ token: 'sy_ext_zz_test_instance_b', email: 'zz_test_b@instance-b.test', deviceLabel: null, expiresAt: '2099-01-01T00:00:00.000Z' }));
      } else if (req.method === 'GET' && path === '/api/extension/session') {
        res.end(JSON.stringify({ email: 'zz_test_b@instance-b.test', deviceLabel: null, sites }));
      } else if (req.method === 'PUT' && /^\/api\/extension\/sites\/[^/]+$/.test(path)) {
        res.statusCode = 201;
        res.end('{}');
      } else {
        res.statusCode = 204;
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  server.on('connection', (socket) => {
    if (down) socket.destroy();
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    setDown: (value) => {
      down = value;
      // Connexions keep-alive ouvertes : fermées aussi, la prochaine requête échoue comme une instance injoignable.
      if (value) server.closeAllConnections();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
