// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.6 (cdc/sym-browser 04g §4, G7 et G8) : deux correctifs du worker préalables au fournisseur `cdp`, dont le
// navigateur n'a ni l'egress de SYM ni ses arguments de lancement. Chromium réel lancé SANS les arguments de lancement du
// worker (`--disable-features` : aucun), serveur local, deux noms résolus vers 127.0.0.1 par Chromium lui-même.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { installPageGuard } from './page-guard.js';
import { installRequestGuard } from './request-guard.js';

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
    const js = (body: string) => res.writeHead(200, { 'content-type': 'text/javascript' }).end(body);
    switch ((req.url ?? '').split('?')[0]) {
      case '/go':
        return res.writeHead(302, { location: `http://${B}:${port}/prive/saut` }).end();
      case '/img-page':
        return html(`<img src="/go-img">`);
      case '/go-img':
        return res.writeHead(302, { location: `http://${B}:${port}/prive/saut-image` }).end();
      case '/wss':
        return html(`<p id="m">m</p><script>window.__doc = typeof WebSocketStream; window.__worker = 'attente'; const w = new Worker('/wss.js'); w.onmessage = (e) => { window.__worker = e.data; };</script>`);
      case '/wss.js':
        return js("postMessage(typeof WebSocketStream)");
      default:
        return res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP *.zz-test 127.0.0.1'] });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

describe('request_guard_blocks_offsite_redirect (G7)', () => {
  test('request_guard_blocks_offsite_redirect : un saut de redirection hors domaines est coupé par la garde, onDomainBlocked appelé, 0 requête vue par le site de destination', async () => {
    const context = await browser.newContext();
    try {
      await context.route('**/*', (route) => route.continue());
      const page = await context.newPage();
      const blocked: string[] = [];
      await installRequestGuard(context, page, (url) => new URL(url).hostname === A, async () => true, { cutOffsiteRedirects: true, onDomainBlocked: (url) => blocked.push(new URL(url).hostname) });
      hits.length = 0;
      await page.goto(`http://${A}:${port}/go`).catch(() => undefined);
      // Saut d'une sous-ressource (image), même règle.
      await page.goto(`http://${A}:${port}/img-page`).catch(() => undefined);
      await page.waitForTimeout(500);
      expect(hits.filter((h) => h.startsWith(`${B}`))).toEqual([]);
      expect(blocked).toEqual([B, B]);
    } finally {
      await context.close();
    }
  });

  test('un saut vers un domaine admis reste permis (le contrôle de l’appelant décide)', async () => {
    const context = await browser.newContext();
    try {
      await context.route('**/*', (route) => route.continue());
      const page = await context.newPage();
      await installRequestGuard(context, page, (url) => [A, B].includes(new URL(url).hostname), async () => true, { onDomainBlocked: () => undefined });
      hits.length = 0;
      await page.goto(`http://${A}:${port}/go`).catch(() => undefined);
      expect(hits.some((h) => h.startsWith(`${B}`))).toBe(true);
    } finally {
      await context.close();
    }
  });
});

describe('websocketstream_neutralized_by_init_script (G8)', () => {
  const read = async (neutralize: boolean) => {
    const context = await browser.newContext();
    try {
      await context.route('**/*', (route) => route.continue());
      await installPageGuard(context, { neutralizeLaunchFeatures: neutralize });
      const page = await context.newPage();
      await installRequestGuard(context, page, (url) => new URL(url).hostname === A, async () => true, { neutralizeLaunchFeatures: neutralize });
      await page.goto(`http://${A}:${port}/wss`);
      await page.waitForFunction(() => (globalThis as unknown as { __worker: string }).__worker !== 'attente', undefined, { timeout: 10_000 });
      return await page.evaluate(() => ({ doc: (globalThis as unknown as { __doc: string }).__doc, worker: (globalThis as unknown as { __worker: string }).__worker }));
    } finally {
      await context.close();
    }
  };

  test('témoin : sans la neutralisation, Chromium non durci expose WebSocketStream (page et worker)', async () => {
    expect(await read(false)).toEqual({ doc: 'function', worker: 'function' });
  });

  test('websocketstream_neutralized_by_init_script : undefined dans la page et dans son worker dédié', async () => {
    expect(await read(true)).toEqual({ doc: 'undefined', worker: 'undefined' });
  });
});

describe('saut hors domaines quand l’egress de SYM le voit (local, sym-browser)', () => {
  test('cutOffsiteRedirects: false : la garde laisse le saut à l’egress (comportement inchangé)', async () => {
    const context = await browser.newContext();
    try {
      await context.route('**/*', (route) => route.continue());
      const page = await context.newPage();
      await installRequestGuard(context, page, (url) => new URL(url).hostname === A, async () => true, { cutOffsiteRedirects: false });
      hits.length = 0;
      await page.goto(`http://${A}:${port}/go`).catch(() => undefined);
      expect(hits.some((h) => h.startsWith(`${B}`))).toBe(true);
    } finally {
      await context.close();
    }
  });
});
