// SPDX-License-Identifier: AGPL-3.0-only
// assert_robots_respected (INV11, revue de 1.11), étage S : le contrôle CDP de chaque requête (`installRequestGuard`) voit
// les sauts de redirection que `context.route` ne voit pas, y compris dans un cadre HORS PROCESSUS (isolation des sites
// forcée) et dans un worker dédié. Chromium réel, serveur local, deux noms de test résolus vers 127.0.0.1 par Chromium
// lui-même (aucun site réel). Le refus porte ici sur tout chemin `/prive/` : 0 requête reçue par le serveur.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { blockSharedWorkers, installRequestGuard, type BrowserRequestCheck } from './request-guard.js';

const A = 'aaa.zz-test';
const B = 'bbb.zz-test';
let server: Server;
let port = 0;
let browser: Browser;
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    hits.push(`${host}${req.url ?? ''}`);
    const html = (body: string) => res.writeHead(200, { 'content-type': 'text/html' }).end(body);
    const redirect = (to: string) => res.writeHead(302, { location: to }).end();
    switch (req.url) {
      case '/':
        return html(`<iframe src="http://${B}:${port}/cadre"></iframe><script>new Worker('/w.js');</script>`);
      case '/cadre':
        return html(`<img src="/img"><script>fetch('/api').catch(() => 0)</script>`);
      case '/w.js':
        return res.writeHead(200, { 'content-type': 'text/javascript' }).end("fetch('/wapi').catch(() => 0)");
      case '/img':
        return redirect('/prive/img');
      case '/api':
        return redirect('/prive/api');
      case '/wapi':
        return redirect('/prive/wapi');
      case '/go':
        return redirect('/prive/go');
      case '/sw-page':
        return html(`<p id="sw">sw</p><script>try { new SharedWorker('/sw.js'); } catch (e) {}</script>`);
      case '/sw.js':
        return res.writeHead(200, { 'content-type': 'text/javascript' }).end("fetch('/prive/direct-sw').catch(() => 0); fetch('/swr').catch(() => 0);");
      case '/swr':
        return redirect('/prive/sw-redirect');
      default:
        return res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP *.zz-test 127.0.0.1`, '--site-per-process'] });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

test('chaque saut contrôlé : cadre hors processus, worker dédié, navigation du cadre principal — 0 requête sur /prive/', async () => {
  const context = await browser.newContext();
  try {
    // Comme le contexte d'un run : `context.route` actif (il ne voit que la première URL de chaque chaîne).
    await context.route('**/*', (route) => route.continue());
    const page = await context.newPage();
    const seen: BrowserRequestCheck[] = [];
    await installRequestGuard(
      context,
      page,
      (url) => [A, B].includes(new URL(url).hostname),
      async (request) => {
        seen.push(request);
        return !new URL(request.url).pathname.startsWith('/prive/');
      },
    );
    await page.goto(`http://${A}:${port}/`);
    // Le cadre de B est bien hors processus (sinon ce test ne prouverait rien sur ce chemin).
    const cdp = await browser.newBrowserCDPSession();
    const targets = ((await cdp.send('Target.getTargets')) as { targetInfos: { type: string; url: string }[] }).targetInfos;
    await cdp.detach();
    expect(targets.some((t) => t.type === 'iframe' && t.url.includes(B))).toBe(true);
    await expect.poll(() => hits.filter((h) => !h.includes('/prive/') && ['/img', '/api', '/wapi'].some((p) => h.endsWith(p))).length, { timeout: 10_000 }).toBe(3);
    await expect(page.goto(`http://${A}:${port}/go`)).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
    await page.waitForTimeout(300);
    expect(hits.filter((h) => h.includes('/prive/'))).toEqual([]);
    // Sauts présentés au contrôle avec la racine de leur chaîne ; navigation du cadre principal marquée.
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: `http://${B}:${port}/prive/img`, redirect: true, rootUrl: `http://${B}:${port}/img`, mainFrame: false }),
        expect.objectContaining({ url: `http://${B}:${port}/prive/api`, redirect: true, rootUrl: `http://${B}:${port}/api` }),
        expect.objectContaining({ url: `http://${A}:${port}/prive/wapi`, redirect: true }),
        expect.objectContaining({ url: `http://${A}:${port}/prive/go`, redirect: true, rootUrl: `http://${A}:${port}/go`, resourceType: 'Document', mainFrame: true }),
      ]),
    );
  } finally {
    await context.close();
  }
}, 120_000);

// Revue de 1.11 : les requêtes d'un SharedWorker ne passent ni par `context.route` ni par l'interception CDP de la page
// (cible `shared_worker` hors de l'attachement automatique de la page). Échec fermé : tout SharedWorker est fermé avant
// d'exécuter son code (`blockSharedWorkers`, posé par `openRunContext` sur chaque contexte de run).
test('SharedWorker (script du site, puis blob créé depuis evaluate) : 0 requête sur /prive/, fetch direct ou redirigé', async () => {
  const context = await browser.newContext();
  const block = await blockSharedWorkers(browser);
  try {
    await context.route('**/*', (route) => route.continue());
    const page = await context.newPage();
    await installRequestGuard(
      context,
      page,
      (url) => [A, B].includes(new URL(url).hostname),
      async (request) => !new URL(request.url).pathname.startsWith('/prive/'),
    );
    await page.goto(`http://${A}:${port}/sw-page`);
    await page.evaluate((origin) => {
      // Code exécuté dans la page (DOM) : le tsconfig du worker ne charge pas la lib DOM, d'où ce type local minimal.
      const { SharedWorker: PageSharedWorker } = globalThis as unknown as { SharedWorker: new (url: string) => unknown };
      try {
        new PageSharedWorker(URL.createObjectURL(new Blob([`fetch('${origin}/prive/blob').catch(() => 0); fetch('${origin}/swr?blob').catch(() => 0);`], { type: 'text/javascript' })));
      } catch {
        // SharedWorker refusé : rien ne part.
      }
    }, `http://${A}:${port}`);
    // Témoin : une requête permise de la page arrive (le serveur répond), les SharedWorker n'ont rien envoyé.
    await page.evaluate((origin) => fetch(`${origin}/temoin`).then(() => 0), `http://${A}:${port}`);
    await page.waitForTimeout(1500);
    expect(hits).toContain(`${A}/temoin`);
    expect(hits.filter((h) => h.includes('/prive/') || h.includes('/swr'))).toEqual([]);
  } finally {
    await context.close();
    await block.close();
  }
}, 120_000);
