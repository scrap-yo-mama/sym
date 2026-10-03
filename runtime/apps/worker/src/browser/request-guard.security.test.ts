// SPDX-License-Identifier: AGPL-3.0-only
// Garde des contextes de run (revue de 1.11), étage S : le contrôle CDP de chaque requête (`installRequestGuard`) voit
// les sauts de redirection que `context.route` ne voit pas, y compris dans un cadre HORS PROCESSUS (isolation des sites
// forcée) et dans un worker dédié. Chromium réel, serveur local, deux noms de test résolus vers 127.0.0.1 par Chromium
// lui-même (aucun site réel). Le refus porte ici sur tout chemin `/prive/` : 0 requête reçue par le serveur.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { installPageGuard } from './page-guard.js';
import { GUARD_DISABLED_FEATURES, PLAYWRIGHT_DISABLED_FEATURES } from './launch.js';
import { blockBackgroundWorkers, installRequestGuard, type BrowserRequestCheck } from './request-guard.js';

const A = 'aaa.zz-test';
const B = 'bbb.zz-test';
/** Hôte en contexte sécurisé (`*.localhost`, résolu vers la boucle locale par Chromium) : service workers possibles. */
const S = 'sw.localhost';
let server: Server;
let port = 0;
let browser: Browser;
const hits: string[] = [];
/** Code de worker : WebSocket vers `path` de son origine. */
const ws = (path: string) => `try { new WebSocket(location.origin.replace(/^http/, 'ws') + '${path}'); } catch (e) {}`;
/** Cadres de documents locaux (data:, srcdoc) dont le code crée un worker blob: qui ouvre un WebSocket vers /prive/. */
const localFrames = () => {
  const code = `<script>try { new Worker(URL.createObjectURL(new Blob([${JSON.stringify(`try { new WebSocket('ws://${A}:${port}/prive/localframews'); } catch (e) {}`)}]))); } catch (e) {}</script>`;
  return `<iframe src="data:text/html,${encodeURIComponent(code)}"></iframe><iframe srcdoc="${code.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>`;
};
/** Workers dédiés d'un document : blob, http classique, module. */
const workers = (name: string) =>
  [`new Worker(URL.createObjectURL(new Blob([${JSON.stringify(ws(`/prive/${name}`))}])))`, "new Worker('/ww.js')", "new Worker('/wm.js', { type: 'module' })"].map((c) => `try { ${c}; } catch (e) {}`).join(' ');

beforeAll(async () => {
  server = createServer((req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    hits.push(`${host}${req.url ?? ''}`);
    const html = (body: string) => res.writeHead(200, { 'content-type': 'text/html' }).end(body);
    const redirect = (to: string) => res.writeHead(302, { location: to }).end();
    const js = (body: string) => res.writeHead(200, { 'content-type': 'text/javascript' }).end(body);
    switch ((req.url ?? '').split('?')[0]) {
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
        // Plusieurs SharedWorker distincts (URL différentes) : la course entre leur reprise et leur fermeture se joue à chacun.
        return html(`<p id="sw">sw</p><script>for (let i = 0; i < 6; i++) { try { new SharedWorker('/sw.js?n=' + i); } catch (e) {} }</script>`);
      case '/sw.js':
        return res.writeHead(200, { 'content-type': 'text/javascript' }).end("fetch('/prive/direct-sw').catch(() => 0); fetch('/swr').catch(() => 0);");
      case '/swr':
        return redirect('/prive/sw-redirect');
      case '/sw-reg-page':
        // Service worker enregistré par le prototype (la surcharge de l'instance par Playwright ne le voit pas), puis
        // commandé par postMessage : chaque message lui fait demander un chemin interdit.
        return html(
          `<p id="swreg">swreg</p><script>(async () => { try { const reg = await ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, '/sw2.js'); window.__sw = 'ok'; const w = reg.installing || reg.waiting || reg.active; const send = () => { try { (reg.active || w).postMessage(location.origin + '/prive/sw-message'); } catch (e) {} }; setTimeout(send, 300); setTimeout(send, 1200); } catch (e) { window.__sw = String(e && e.name); } })();</script>`,
        );
      case '/sw2.js':
        return js(
          "fetch('/prive/sw-top').catch(() => 0); fetch('/swr').catch(() => 0); self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('message', (e) => { fetch(String(e.data)).catch(() => 0); });",
        );
      case '/ws-workers':
        return html(
          `<iframe src="http://${B}:${port}/ws-cadre"></iframe>${localFrames()}<script>${workers('workerws')}; new WebSocket('ws://' + location.host + '/ouvert-ws');</script>`,
        );
      case '/ws-cadre':
        return html(`<p>cadre</p><script>${workers('oopifworkerws')}</script>`);
      case '/ww.js':
        return js(`${ws('/prive/httpworkerws')} ${ws('/ouvert-worker-ws')} new Worker(URL.createObjectURL(new Blob([${JSON.stringify(ws('/prive/nestedws'))}]))); fetch('/temoin-ww').catch(() => 0);`);
      case '/wm.js':
        return js(`import '/wdep.js'; ${ws('/prive/moduleworkerws')}`);
      case '/wdep.js':
        return js(ws('/prive/moduledepws'));
      default:
        return res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    }
  });
  // Poignée de main WebSocket : comptée comme une requête (UPGRADE), puis coupée.
  server.on('upgrade', (req, socket) => {
    hits.push(`${(req.headers.host ?? '').replace(/:\d+$/, '')}${req.url ?? ''} UPGRADE`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  browser = await chromium.launch({
    headless: true,
    args: [`--host-resolver-rules=MAP *.zz-test 127.0.0.1`, '--site-per-process', `--disable-features=${[...PLAYWRIGHT_DISABLED_FEATURES, ...GUARD_DISABLED_FEATURES].join(',')}`],
  });
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
// (cible `shared_worker` hors de l'attachement automatique de la page). Échec fermé, deux couches (`openRunContext` les pose
// toutes deux sur chaque contexte de run) : la garde des documents refuse tout constructeur `SharedWorker` ; le blocage du
// navigateur (`blockBackgroundWorkers`) ferme ceux qui naîtraient quand même. Playwright relance chaque cible jointe : seule la
// garde des documents est sans course pour un worker blob: (script local), le blocage seul ne l'est que si le script se fait
// attendre (premier test : script servi tard ; il ne peut pas démarrer avant d'être fermé).
test('SharedWorker, garde des documents : script du site et blob créé depuis evaluate refusés (SecurityError), 0 requête sur /prive/ ou /swr', async () => {
  const { context, page } = await runLikeContext();
  const block = await blockBackgroundWorkers(browser);
  try {
    await page.goto(`http://${A}:${port}/sw-page`);
    const refused = await page.evaluate((origin) => {
      // Code exécuté dans la page (DOM) : le tsconfig du worker ne charge pas la lib DOM, d'où ce type local minimal.
      const { SharedWorker: PageSharedWorker } = globalThis as unknown as { SharedWorker: new (url: string) => unknown };
      const attempt = (url: string): string => {
        try {
          new PageSharedWorker(url);
          return 'créé';
        } catch (error) {
          return (error as { name?: string }).name ?? 'erreur';
        }
      };
      return [attempt('/sw.js'), attempt(URL.createObjectURL(new Blob([`fetch('${origin}/prive/blob').catch(() => 0); fetch('${origin}/swr?blob').catch(() => 0);`], { type: 'text/javascript' })))];
    }, `http://${A}:${port}`);
    expect(refused).toEqual(['SecurityError', 'SecurityError']);
    // Témoin : une requête permise de la page arrive (le serveur répond), les SharedWorker n'ont rien envoyé.
    await page.evaluate((origin) => fetch(`${origin}/temoin`).then(() => 0), `http://${A}:${port}`);
    await page.waitForTimeout(1500);
    expect(hits).toContain(`${A}/temoin`);
    expect(hits.filter((h) => h.includes('/prive/') || h.includes('/swr') || h.endsWith('/sw.js'))).toEqual([]);
  } finally {
    await context.close();
    await block.close();
  }
}, 120_000);

// Couche du navigateur seule, sans la garde des documents : tout SharedWorker, script du site comme blob, est coupé
// (interception `Fetch` du navigateur, sans course avec la reprise de Playwright).
test('SharedWorker, blocage du navigateur seul (sans garde des documents) : script du site puis blobs créés depuis evaluate, 0 requête sur /prive/, fetch direct ou redirigé', async () => {
  const context = await browser.newContext();
  const block = await blockBackgroundWorkers(browser);
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
      // Plusieurs blobs distincts : la course entre la reprise et la fermeture se joue à chacun.
      for (let i = 0; i < 6; i++) {
        try {
          new PageSharedWorker(URL.createObjectURL(new Blob([`fetch('${origin}/prive/blob${i}').catch(() => 0); fetch('${origin}/swr?blob${i}').catch(() => 0);`], { type: 'text/javascript' })));
        } catch {
          // SharedWorker refusé : rien ne part.
        }
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

// Revue de fix-inv11-agent : `serviceWorkers: 'block'` de Playwright ne remplace que `register` de l'INSTANCE
// `navigator.serviceWorker` ; `ServiceWorkerContainer.prototype.register.call(...)` enregistrait le worker. Ses requêtes
// (script compris) ne passaient ni par `context.route`, ni par le contrôle CDP de la page, et la page pouvait lui commander
// des requêtes par postMessage. Échec fermé au niveau CDP du navigateur, sans la garde des documents (couche seule) : dans
// un contexte comme ceux du pool (`block`) et comme le contexte par défaut du Chromium dédié (`allow`).
for (const serviceWorkers of ['block', 'allow'] as const) {
  test(`ServiceWorker enregistré par le prototype puis commandé par postMessage (contexte serviceWorkers: ${serviceWorkers}, couche CDP seule) : 0 requête sur /prive/`, async () => {
    const context = await browser.newContext({ serviceWorkers });
    const block = await blockBackgroundWorkers(browser);
    try {
      await context.route('**/*', (route) => route.continue());
      const page = await context.newPage();
      await installRequestGuard(context, page, (url) => [A, B, S].includes(new URL(url).hostname), async (request) => !new URL(request.url).pathname.startsWith('/prive/'));
      await page.goto(`http://${S}:${port}/sw-reg-page`);
      await page.waitForTimeout(2500);
      // Témoin : une requête permise de la page arrive ; ni le service worker ni son script n'ont rien obtenu.
      await page.evaluate(`fetch('/temoin-sw').then(() => 0)`);
      expect(hits).toContain(`${S}/temoin-sw`);
      expect(hits.filter((h) => h.startsWith(S) && (h.includes('/prive/') || h.includes('/swr')))).toEqual([]);
    } finally {
      await context.close();
      await block.close();
    }
  }, 120_000);
}

test('garde des documents : ServiceWorkerContainer.prototype.register refusé et figé (prototype, instance, cadre about:blank) ; SharedWorker blob: et data: refusés', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    await installPageGuard(context);
    const page = await context.newPage();
    await page.goto(`http://${S}:${port}/x`);
    const out = await page.evaluate(`(async () => {
      const proto = ServiceWorkerContainer.prototype;
      const d = Object.getOwnPropertyDescriptor(proto, 'register');
      const r = [String(d.configurable), String(d.writable)];
      try { Object.defineProperty(proto, 'register', { value: () => 0 }); r.push('redéfini'); } catch (e) { r.push('figé'); }
      const frame = document.createElement('iframe');
      document.body.append(frame);
      const calls = [
        () => proto.register.call(navigator.serviceWorker, '/sw2.js'),
        () => navigator.serviceWorker.register('/sw2.js'),
        () => frame.contentWindow.ServiceWorkerContainer.prototype.register.call(frame.contentWindow.navigator.serviceWorker, '/sw2.js'),
      ];
      for (const call of calls) {
        try { await call(); r.push('enregistré'); } catch (e) { r.push(e.name); }
      }
      // SharedWorker blob: et data: : leurs WebSocket échapperaient à tout contrôle (CSP du document, aucune interception).
      const code = "try { new WebSocket('ws://" + location.host + "/prive/sharedws'); } catch (e) {}";
      for (const url of [URL.createObjectURL(new Blob([code], { type: 'text/javascript' })), 'data:text/javascript,' + encodeURIComponent(code)]) {
        try { new SharedWorker(url); r.push('créé'); } catch (e) { r.push(e.name); }
      }
      return r.join(',');
    })()`);
    expect(out).toBe('false,false,figé,SecurityError,SecurityError,SecurityError,SecurityError,SecurityError');
    await page.waitForTimeout(500);
    expect(hits.filter((h) => h.startsWith(S) && (h.includes('/prive/') || h.includes('/sw2.js')))).toEqual([]);
  } finally {
    await context.close();
  }
}, 120_000);

// Revue de 1.11 : la poignée de main d'un WebSocket ouvert depuis un worker dédié n'était vue par aucun contrôle
// (`routeWebSocket` ne remplace `WebSocket` que dans les cadres, CDP Fetch n'intercepte pas les WebSocket, le proxy
// d'egress ne voit qu'un CONNECT), et la suspension au démarrage ne tient pas : Playwright relance lui-même chaque worker.
// Échec fermé : aucun worker blob: ou data: créé par un document (garde des documents), aucun WebSocket dans un worker http
// (classique ou module) ni dans ses workers imbriqués (CSP posée par le contrôle CDP), qu'il vienne de la page ou d'un cadre
// (hors processus ou non, data:, srcdoc) ; WebSocketStream est coupé au lancement (comme `chromiumLaunchOptions`).

/** Contexte comme celui d'un run : route, routeWebSocket contrôlé (chemin /prive/ refusé), contrôle CDP. */
async function runLikeContext() {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const refused = (url: string) => new URL(url).pathname.startsWith('/prive/');
  await context.route('**/*', (route) => route.continue());
  await context.routeWebSocket(/.*/, async (socket) => {
    if (refused(socket.url())) await socket.close({ code: 1008, reason: 'request_refused' });
    else socket.connectToServer();
  });
  await installPageGuard(context);
  const page = await context.newPage();
  await installRequestGuard(context, page, (url) => [A, B].includes(new URL(url).hostname), async (request) => !refused(request.url));
  return { context, page };
}

test('WebSocket ouvert depuis des workers dédiés (page, cadre hors processus, blob, data:, http, module, imbriqué, evaluate) et WebSocketStream : 0 requête sur /prive/, upgrade compris', async () => {
  const { context, page } = await runLikeContext();
  try {
    await page.goto(`http://${A}:${port}/ws-workers`);
    // Le code du script (evaluate) : workers blob:, data:, module, imbriqué, depuis un cadre about:blank qu'il crée, par le
    // constructeur natif cherché par le prototype ou par Reflect.construct, avec Blob, URL et itérateurs remplacés ;
    // WebSocketStream depuis la page. Chaque tentative est refusée.
    const outcome = await page.evaluate(
      ({ code, origin }) => {
        // Code exécuté dans la page (DOM) : types locaux minimaux (le tsconfig du worker ne charge pas la lib DOM).
        type WorkerCtor = new (url: string, options?: unknown) => unknown;
        const g = globalThis as unknown as Record<string, unknown> & { Worker: WorkerCtor; WebSocketStream?: new (url: string) => { opened: Promise<unknown> }; document: { createElement(n: string): { contentWindow: { Worker: WorkerCtor } }; body: { append(n: unknown): void } } };
        const blob = (text: string, type?: string) => URL.createObjectURL(new Blob([text], type === undefined ? undefined : { type }));
        const frame = g.document.createElement('iframe');
        g.document.body.append(frame);
        const attempts: [string, () => unknown][] = [
          ['blob', () => new g.Worker(blob(code.blob))],
          ['imbriqué', () => new g.Worker(blob(code.nested))],
          ['module', () => new g.Worker(blob(code.module, 'text/javascript'), { type: 'module' })],
          ['data', () => new g.Worker(`data:text/javascript,${encodeURIComponent(code.data)}`)],
          ['WebSocketStream', () => new g.Worker(blob(code.stream))],
          ['prototype', () => new ((g.Worker as unknown as { prototype: { constructor: WorkerCtor } }).prototype.constructor)(blob(code.blob))],
          ['Reflect', () => Reflect.construct(g.Worker, [blob(code.blob)])],
          ['cadre', () => new frame.contentWindow.Worker(blob(code.blob))],
          ['objet', () => new g.Worker({ toString: () => blob(code.blob) } as unknown as string)],
        ];
        // Détournements posés par la page après la garde : Blob, URL.createObjectURL, itérateurs.
        const native = blob(code.blob);
        Object.defineProperty(Array.prototype, Symbol.iterator, { value: function* () {}, configurable: true, writable: true });
        (URL as unknown as Record<string, unknown>)['createObjectURL'] = () => native;
        attempts.push(['détourné', () => new g.Worker(URL.createObjectURL(new Blob([code.blob])))]);
        const refused: string[] = [];
        for (let i = 0; i < attempts.length; i++) {
          try {
            attempts[i]![1]();
          } catch {
            refused.push(attempts[i]![0]);
          }
        }
        // Rétablis pour que Playwright puisse lire le résultat.
        Object.defineProperty(Array.prototype, Symbol.iterator, { value: Array.prototype.values, configurable: true, writable: true });
        try {
          if (g.WebSocketStream !== undefined) new g.WebSocketStream(`${origin.replace(/^http/, 'ws')}/prive/pagewsstream`).opened.catch(() => 0);
        } catch {
          // WebSocketStream refusé : rien ne part.
        }
        return { refused: refused.join(','), total: attempts.length, stream: typeof g.WebSocketStream };
      },
      {
        code: {
          blob: ws('/prive/evalworkerws'),
          nested: `new Worker(URL.createObjectURL(new Blob([${JSON.stringify(ws('/prive/evalnestedws'))}])));`,
          module: ws('/prive/evalmodulews'),
          data: `try { new WebSocket('ws://${A}:${port}/prive/evaldataws'); } catch (e) {}`,
          stream: `try { new WebSocketStream(location.origin.replace(/^blob:/, '').replace(/^http/, 'ws') + '/prive/workerwsstream').opened.catch(() => 0); } catch (e) {}`,
        },
        origin: `http://${A}:${port}`,
      },
    );
    expect(outcome.refused.split(',')).toHaveLength(outcome.total);
    expect(outcome.stream).toBe('undefined');
    const cdp = await browser.newBrowserCDPSession();
    const targets = ((await cdp.send('Target.getTargets')) as { targetInfos: { type: string; url: string }[] }).targetInfos;
    await cdp.detach();
    expect(targets.some((t) => t.type === 'iframe' && t.url.includes(B))).toBe(true);
    // Témoins : les workers http de la page et du cadre ont exécuté leur code (fetch permis reçu) ; le WebSocket permis de
    // la page, contrôlé par routeWebSocket, passe.
    await expect.poll(() => hits.filter((h) => h.endsWith('/temoin-ww')).length, { timeout: 10_000 }).toBe(2);
    await expect.poll(() => hits.includes(`${A}/ouvert-ws UPGRADE`), { timeout: 10_000 }).toBe(true);
    await page.waitForTimeout(1500);
    expect(hits.filter((h) => h.includes('/prive/'))).toEqual([]);
    // Échec fermé : aucun WebSocket de worker, même vers un chemin permis.
    expect(hits.filter((h) => h.includes('/ouvert-worker-ws'))).toEqual([]);
  } finally {
    await context.close();
  }
}, 120_000);

test('WebSocket de workers après une navigation du cadre principal vers un autre site (changement de processus, cadre du même processus) : 0 requête sur /prive/', async () => {
  const { context, page } = await runLikeContext();
  try {
    await page.goto(`http://${A}:${port}/`);
    await page.goto(`http://${B}:${port}/ws-workers`);
    await expect.poll(() => hits.filter((h) => h === `${B}/temoin-ww`).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    await expect.poll(() => hits.includes(`${B}/ouvert-ws UPGRADE`), { timeout: 10_000 }).toBe(true);
    await page.waitForTimeout(1500);
    expect(hits.filter((h) => h.includes('/prive/'))).toEqual([]);
  } finally {
    await context.close();
  }
}, 120_000);

// Règles de spéculation (revue de 1.11) : leur préchargement part du navigateur, hors de toute interception ; la garde des
// documents les retire. Elle capture ses fonctions natives avant tout code de la page : un code qui remplace les
// itérateurs, MutationObserver, `remove`, `getAttribute` ou les accesseurs ne la détourne pas.
test('règles de spéculation insérées par une page qui remplace itérateurs, MutationObserver et méthodes du DOM : 0 requête sur /prive/', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    await installPageGuard(context);
    const page = await context.newPage();
    await installRequestGuard(context, page, (url) => [A, B].includes(new URL(url).hostname), async (request) => !new URL(request.url).pathname.startsWith('/prive/'));
    await page.goto(`http://${A}:${port}/`);
    const errors = await page.evaluate((origin) => {
      // Code exécuté dans la page (DOM) : accès dynamiques (le tsconfig du worker ne charge pas la lib DOM).
      type Bag = Record<string | symbol, unknown>;
      const g = globalThis as unknown as Record<string, { prototype: Bag } & Bag>;
      const d = (globalThis as unknown as { document: Bag & { createElement(n: string): Bag; head: { append(n: unknown): void }; body: { append(n: unknown): void } } }).document;
      const rules = (n: string) => JSON.stringify({ prefetch: [{ source: 'list', urls: [`${origin}/prive/${n}`], eagerness: 'immediate' }] });
      const out: string[] = [];
      // Détournements (rétablis après le passage de la garde, pour que Playwright puisse lire le résultat).
      const saved = {
        iterator: Object.getOwnPropertyDescriptor(g['Array']!.prototype, Symbol.iterator)!,
        observe: g['MutationObserver']!.prototype['observe'],
        remove: g['Element']!.prototype['remove'],
        getAttribute: g['Element']!.prototype['getAttribute'],
        nodeType: Object.getOwnPropertyDescriptor(g['Node']!.prototype, 'nodeType')!,
      };
      Object.defineProperty(g['Array']!.prototype, Symbol.iterator, { value: function* () {}, configurable: true, writable: true });
      g['MutationObserver']!.prototype['observe'] = () => undefined;
      g['Element']!.prototype['remove'] = () => undefined;
      g['Element']!.prototype['getAttribute'] = () => 'text/javascript';
      Object.defineProperty(g['Node']!.prototype, 'nodeType', { get: () => 0, configurable: true });
      const append = (parent: { append(n: unknown): void }, n: string) => {
        const s = d.createElement('script');
        s['type'] = 'speculationrules';
        s['textContent'] = rules(n);
        parent.append(s);
      };
      try {
        append(d.head, 'hostile');
        const host = d.createElement('div');
        d.body.append(host);
        append((host['attachShadow'] as (o: unknown) => { append(n: unknown): void }).call(host, { mode: 'closed' }), 'hostile-shadow');
      } catch (e) {
        out.push(`insertion: ${String(e)}`);
      }
      const html = `<div><template shadowrootmode="closed"><script type="speculationrules">${rules('unsafe')}</script></template></div>`;
      try {
        const h = d.createElement('div');
        d.body.append(h);
        (h['setHTMLUnsafe'] as (html: string) => void).call(h, html);
      } catch (e) {
        out.push(String(e));
      }
      try {
        (g['Document'] as unknown as { parseHTMLUnsafe(h: string): unknown }).parseHTMLUnsafe(html);
      } catch (e) {
        out.push(String(e));
      }
      return new Promise<string>((resolve) =>
        setTimeout(() => {
          Object.defineProperty(g['Array']!.prototype, Symbol.iterator, saved.iterator);
          g['MutationObserver']!.prototype['observe'] = saved.observe;
          g['Element']!.prototype['remove'] = saved.remove;
          g['Element']!.prototype['getAttribute'] = saved.getAttribute;
          Object.defineProperty(g['Node']!.prototype, 'nodeType', saved.nodeType);
          resolve(out.join('\n'));
        }, 300),
      );
    }, `http://${A}:${port}`).then((text) => text.split('\n').filter((line) => line !== ''));
    // Les deux racines fantômes déclaratives sont refusées (setHTMLUnsafe, parseHTMLUnsafe) ; le reste est retiré sans bruit.
    expect(errors).toHaveLength(2);
    for (const e of errors) expect(e).toMatch(/shadowrootmode/);
    await page.evaluate((origin) => fetch(`${origin}/temoin-spec`).then(() => 0), `http://${A}:${port}`);
    await page.waitForTimeout(1500);
    expect(hits).toContain(`${A}/temoin-spec`);
    expect(hits.filter((h) => h.includes('/prive/'))).toEqual([]);
  } finally {
    await context.close();
  }
}, 120_000);
