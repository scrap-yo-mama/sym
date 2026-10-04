// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.7 (cdc/sym-browser 04g §3, G5 et G7) : fournisseur `cdp` contre un Chromium réel exposé en CDP (jamais un compte tiers).
// Le Chromium est lancé SANS les arguments du worker ni proxy d'egress ; la garde du worker tient le verrou de domaines et
// WebSocketStream. Seul processus tué : l'enfant lancé ici (arrêté par `Browser.close` du fournisseur, puis par son objet
// ChildProcess en dernier recours).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSsrfPolicy, SsrfGuard } from '@runtime/core/net';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createCdpProvider } from './provider-cdp.js';
import { openRunContext } from './run-context.js';

const A = 'aaa.zz-test';
const B = 'bbb.zz-test';
let server: Server;
let port = 0;
let child: ChildProcess;
let profile = '';
let cdpUrl = '';
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(`${(req.headers.host ?? '').replace(/:\d+$/, '')}${req.url ?? ''}`);
    switch ((req.url ?? '').split('?')[0]) {
      case '/go':
        return res.writeHead(302, { location: `http://${B}:${port}/prive/saut` }).end();
      case '/item':
        return res.writeHead(200, { 'content-type': 'text/html' }).end('<title>fixture</title><p id="v">conforme</p><script>document.title = typeof WebSocketStream</script>');
      default:
        return res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  profile = mkdtempSync(join(tmpdir(), 'zz_cdp_chromium_'));
  child = spawn(chromium.executablePath(), ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, '--host-resolver-rules=MAP *.zz-test 127.0.0.1', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 200 && cdpUrl === ''; i++) {
    try {
      const [p, path] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n');
      cdpUrl = `ws://127.0.0.1:${Number(p)}${path ?? ''}`;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (cdpUrl === '') throw new Error('Chromium exposé en CDP : DevToolsActivePort absent');
}, 120_000);

afterAll(async () => {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
  await new Promise((resolve) => server?.close(resolve));
});

describe('cdp_requires_explicit_opt_in : run E2 via un Chromium exposé en CDP (G5, G7)', () => {
  test('page lue conforme, WebSocketStream neutralisé, saut hors domaines coupé par le worker, 0 requête vue par le site de destination', async () => {
    const provider = createCdpProvider({ mode: { kind: 'url', url: cdpUrl }, workerId: 'zz_worker' });
    const egress = await provider.openEgress({ rung: { mode: 'direct' }, guard: new SsrfGuard({ policy: createSsrfPolicy() }), allowedHosts: [A] });
    const launched = await provider.launchShared();
    try {
      const rc = await openRunContext(launched.browser, { egressServer: egress.server, egress, allowedHosts: [A] });
      try {
        await rc.page.goto(`http://${A}:${port}/item`);
        expect(await rc.page.locator('#v').textContent()).toBe('conforme');
        expect(await rc.page.title()).toBe('undefined');
        hits.length = 0;
        await rc.page.goto(`http://${A}:${port}/go`).catch(() => undefined);
        await rc.page.waitForTimeout(500);
        expect(hits.filter((h) => h.startsWith(B))).toEqual([]);
        expect(rc.violations).toContain(B);
      } finally {
        await rc.close();
      }
    } finally {
      await egress.close();
      await launched.kill();
    }
    // Browser.close du fournisseur (URL fixe) : le Chromium exposé s'arrête de lui-même.
    for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});
