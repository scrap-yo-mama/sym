// INV10 (tâche 0.7) : garde SSRF sur fetch et sur Chromium (Playwright via le proxy d'egress local).
// Critère : métadonnées cloud, localhost, IP privées, rebinding, redirection vers IP privée → refus, et le faux
// service de métadonnées ne reçoit aucune connexion.
import { createSocket } from 'node:dgram';
import { connect as netConnect, type Socket } from 'node:net';
import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  assertWebhookUrlAllowed,
  chromiumEgressLaunchOptions,
  createGuardedDispatcher,
  deliverWebhook,
  guardedFetch,
  guardedGoto,
  SsrfBlockedError,
  startEgressProxy,
  type EgressProxy,
} from '../../packages/core/src/net/index.ts';
import { startSsrfHarness, ssrfUrlVectors, ZZ_PUBLIC_ADDRESS, type SsrfHarness } from './ssrf-harness.ts';

async function blockedReason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'allowed';
  } catch (error) {
    if (!(error instanceof SsrfBlockedError)) throw error;
    // Le membre ne voit qu'un code générique ; le détail reste pour le journal admin.
    expect(error.message).toBe('ssrf_blocked');
    expect(error.code).toBe('ssrf_blocked');
    return error.detail.reason;
  }
}

let h: SsrfHarness;
beforeAll(async () => {
  h = await startSsrfHarness();
});
afterAll(async () => {
  await h.close();
});

describe('assert_ssrf_guard', () => {
  describe('fetch (undici, connecteur gardé)', () => {
    test('cible autorisée atteinte, redirection interne suivie', async () => {
      const dispatcher = createGuardedDispatcher(h.guard);
      const ok = await guardedFetch(`http://fixture.zz-test:${h.fixturePort}/redirect-ok`, {}, { guard: h.guard, dispatcher });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe('zz_test_ok');
      await dispatcher.close();
    });

    test('métadonnées cloud, localhost, IP privées, encodages d’IP → ssrf_blocked', async () => {
      const dispatcher = createGuardedDispatcher(h.guard);
      for (const url of ssrfUrlVectors(h.metaPort)) {
        expect(await blockedReason(guardedFetch(url, {}, { guard: h.guard, dispatcher })), url).not.toBe('allowed');
      }
      await dispatcher.close();
      expect(h.metaHits()).toBe(0);
    });

    test('redirection vers la boucle locale, les métadonnées ou un nom privé → refus au saut', async () => {
      const dispatcher = createGuardedDispatcher(h.guard);
      const base = `http://fixture.zz-test:${h.fixturePort}`;
      const expected: Record<string, string> = {
        '/redirect-meta': 'loopback',
        '/redirect-meta-name': 'loopback',
        '/redirect-imds': 'cloud_metadata',
        '/redirect-localhost': 'blocked_hostname',
        '/redirect-decimal': 'loopback',
        '/redirect-loop': 'too_many_redirects',
      };
      for (const [path, reason] of Object.entries(expected)) {
        expect(await blockedReason(guardedFetch(`${base}${path}`, {}, { guard: h.guard, dispatcher })), path).toBe(reason);
      }
      await dispatcher.close();
      expect(h.metaHits()).toBe(0);
    });

    test('redirection inter-origines : en-têtes en liste blanche, corps jamais renvoyé', async () => {
      const response = await guardedFetch(
        `http://fixture.zz-test:${h.fixturePort}/redirect-cross`,
        {
          method: 'POST',
          body: 'zz_test_secret_body',
          headers: { authorization: 'Bearer zz_test', cookie: 'a=b', 'x-api-key': 'zz_test_key', accept: 'text/plain', 'user-agent': 'zz-test-agent' },
        },
        { guard: h.guard },
      );
      const echo = (await response.json()) as { method: string; headers: Record<string, string>; body: string };
      expect(echo.body).toBe('');
      expect(echo.method).toBe('GET');
      expect(echo.headers).not.toHaveProperty('authorization');
      expect(echo.headers).not.toHaveProperty('cookie');
      expect(echo.headers).not.toHaveProperty('x-api-key');
      expect(echo.headers.accept).toBe('text/plain');
      expect(echo.headers['user-agent']).toBe('zz-test-agent');
    });

    test('rebinding : validée publique, résolue privée à la connexion → refus', async () => {
      const url = `http://rebind.zz-test:${h.metaPort}/latest/meta-data/`;
      h.setRebindPhase('validate');
      expect((await h.guard.checkUrl(url)).address).toBe(ZZ_PUBLIC_ADDRESS);
      h.setRebindPhase('connect');
      const before = h.resolverCalls.get('rebind.zz-test') ?? 0;
      expect(await blockedReason(guardedFetch(url, {}, { guard: h.guard }))).toBe('loopback');
      expect(h.resolverCalls.get('rebind.zz-test')).toBe(before + 1);
      expect(h.metaHits()).toBe(0);
    });
  });

  describe('Chromium (Playwright 1.63) via le proxy d’egress', () => {
    let proxy: EgressProxy;
    let browser: Browser;

    beforeAll(async () => {
      proxy = await startEgressProxy({ guard: h.guard, onBlocked: (detail) => h.blocked.push(detail) });
      const { proxy: proxyOption, args } = chromiumEgressLaunchOptions(proxy.url, {});
      browser = await chromium.launch({ proxy: proxyOption, args: [...args] });
    }, 120_000);
    afterAll(async () => {
      await browser?.close();
      await proxy?.close();
    });

    /** Chaque cas repart d'un journal vide et exige au moins un refus journalisé PAR LE PROXY. */
    async function expectProxyRefusal(label: string, action: () => Promise<unknown>): Promise<void> {
      h.blocked.length = 0;
      await action().catch(() => undefined);
      expect(h.blocked.length, `${label} : aucun refus journalisé par le proxy`).toBeGreaterThan(0);
      expect(h.metaHits(), label).toBe(0);
    }

    test('cible autorisée atteinte par le proxy (le DNS de Chromium est coupé)', async () => {
      const page = await browser.newPage();
      const response = await page.goto(`http://fixture.zz-test:${h.fixturePort}/`);
      expect(response?.status()).toBe(200);
      expect(await page.textContent('body')).toBe('zz_test_ok');
      await page.close();
    });

    test('ws:// vers une cible autorisée passe par le proxy (tunnel CONNECT)', async () => {
      const page = await browser.newPage();
      await page.goto(`http://fixture.zz-test:${h.fixturePort}/`);
      const before = h.wsOpens();
      const state = await page.evaluate(
        (u) =>
          new Promise<string>((resolve) => {
            const ws = new WebSocket(u);
            ws.onopen = () => resolve('open');
            ws.onerror = () => resolve('error');
          }),
        `ws://fixture.zz-test:${h.fixturePort}/ws`,
      );
      expect(state).toBe('open');
      expect(h.wsOpens()).toBe(before + 1);
      await page.close();
    });

    test('navigations vers métadonnées, localhost, IP privées, encodages → refus du proxy, URL par URL', async () => {
      const page = await browser.newPage();
      for (const url of ssrfUrlVectors(h.metaPort)) {
        await expectProxyRefusal(url, async () => {
          const response = await page.goto(url);
          expect(response?.status(), url).toBe(403);
        });
      }
      // HTTPS : le tunnel CONNECT est refusé.
      for (const url of ['https://169.254.169.254/', `https://127.0.0.1:${h.metaPort}/`, `https://[::1]:${h.metaPort}/`]) {
        await expectProxyRefusal(url, () => page.goto(url));
      }
      await page.close();
    });

    test('redirection vers IP privée, rebinding → refus du proxy', async () => {
      const page = await browser.newPage();
      const base = `http://fixture.zz-test:${h.fixturePort}`;
      for (const path of ['/redirect-meta', '/redirect-meta-name', '/redirect-imds', '/redirect-decimal', '/redirect-localhost']) {
        await expectProxyRefusal(path, () => page.goto(`${base}${path}`));
      }
      h.setRebindPhase('validate');
      await h.guard.checkUrl(`http://rebind.zz-test:${h.metaPort}/`);
      h.setRebindPhase('connect');
      await expectProxyRefusal('rebind', () => page.goto(`http://rebind.zz-test:${h.metaPort}/`));
      expect(h.blocked).toEqual([expect.objectContaining({ host: 'rebind.zz-test', reason: 'loopback', via: 'http' })]);
      await page.close();
    });

    test('sous-ressources, fetch, WebSocket (ws et wss) → refus du proxy, aucun canal ouvert', async () => {
      const page = await browser.newPage();
      h.blocked.length = 0;
      await page.goto(`http://fixture.zz-test:${h.fixturePort}/page`);
      const results = await page.evaluate(() => (globalThis as unknown as { done: Promise<string[]> }).done);
      expect(results).toHaveLength(6);
      expect(results.filter((r) => r === 'open')).toEqual([]);
      await page.waitForLoadState('load');
      await page.close();
      expect(h.metaHits()).toBe(0);
      expect(h.blocked).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ host: 'metadata.zz-test', reason: 'loopback' }),
          expect.objectContaining({ host: '169.254.169.254', reason: 'cloud_metadata' }),
          expect.objectContaining({ host: '127.0.0.1', reason: 'loopback', via: 'connect' }),
        ]),
      );
    });

    test('navigation gardée : file:, view-source:, chrome:, data: refusés avant Chromium', async () => {
      const page = await browser.newPage();
      await page.goto(`http://fixture.zz-test:${h.fixturePort}/`);
      for (const url of ['file:///proc/self/environ', 'file:///etc/passwd', `view-source:http://fixture.zz-test:${h.fixturePort}/`, 'chrome://version', 'data:text/html,zz_test']) {
        await expect(guardedGoto(page, url, h.guard), url).rejects.toBeInstanceOf(SsrfBlockedError);
      }
      expect(page.url()).toBe(`http://fixture.zz-test:${h.fixturePort}/`);
      const ok = await guardedGoto(page, `http://fixture.zz-test:${h.fixturePort}/`, h.guard);
      expect(ok?.status()).toBe(200);
      await page.close();
    });

    const gatherIce = (udpPort: number) => `(async () => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udpPort}' }] });
      pc.createDataChannel('zz_test');
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((resolve) => {
        pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && resolve(null);
        setTimeout(resolve, 3000);
      });
      pc.close();
    })()`;

    test('WebRTC : aucun paquet UDP hors proxy (STUN vers 127.0.0.1)', async () => {
      const page = await browser.newPage();
      await page.goto(`http://fixture.zz-test:${h.fixturePort}/`);
      await page.evaluate(gatherIce(h.udpPort));
      await page.close();
      expect(h.udpPackets()).toBe(0);
    });

    test('témoin WebRTC : sans la politique, le même STUN reçoit des paquets (le test sait voir un échec)', async () => {
      const { proxy: proxyOption, args } = chromiumEgressLaunchOptions(proxy.url, {});
      const control = await chromium.launch({ proxy: proxyOption, args: args.filter((a) => !a.startsWith('--force-webrtc')) });
      let packets = 0;
      const udp = createSocket('udp4');
      udp.on('message', () => (packets += 1));
      await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', () => resolve()));
      try {
        const page = await control.newPage();
        await page.goto(`http://fixture.zz-test:${h.fixturePort}/`);
        await page.evaluate(gatherIce(udp.address().port));
        expect(packets).toBeGreaterThan(0);
      } finally {
        await control.close();
        await new Promise<void>((resolve) => udp.close(() => resolve()));
      }
    });
  });
});

describe('assert_webhook_ssrf_blocked', () => {
  // Squelette réutilisable pour la tâche 2.5 : enregistrement (assertWebhookUrlAllowed) puis envoi (deliverWebhook).
  test('enregistrement refusé pour chaque vecteur ; cible autorisée acceptée', async () => {
    await expect(assertWebhookUrlAllowed(`http://fixture.zz-test:${h.fixturePort}/hook`, h.guard)).resolves.toBeInstanceOf(URL);
    for (const url of ssrfUrlVectors(h.metaPort)) {
      expect(await blockedReason(assertWebhookUrlAllowed(url, h.guard)), url).not.toBe('allowed');
    }
  });

  test('envoi : redirection vers IP privée et rebinding après enregistrement → refus, 0 requête interne', async () => {
    const delivered = await deliverWebhook(`http://fixture.zz-test:${h.fixturePort}/hook`, { zz_test: 1 }, { guard: h.guard });
    expect(delivered.status).toBe(204);
    expect(h.fixturePosts).toContain('{"zz_test":1}');

    // Un webhook ne suit aucune redirection : la réponse 3xx est rendue telle quelle, rien n'est renvoyé.
    const posts = h.fixturePosts.length;
    for (const path of ['/redirect-meta', '/redirect-ok']) {
      const redirected = await deliverWebhook(`http://fixture.zz-test:${h.fixturePort}${path}`, { zz_test: 2 }, { guard: h.guard });
      expect(redirected.status, path).toBe(307);
    }
    expect(h.fixturePosts.length).toBe(posts + 2);
    expect(h.metaHits()).toBe(0);

    const url = `http://rebind.zz-test:${h.metaPort}/hook`;
    h.setRebindPhase('validate');
    await assertWebhookUrlAllowed(url, h.guard);
    h.setRebindPhase('connect');
    expect(await blockedReason(deliverWebhook(url, { zz_test: 3 }, { guard: h.guard }))).toBe('loopback');
    expect(h.metaHits()).toBe(0);
  });
});

describe('proxy d’egress : délai d’inactivité et plafond de connexions', () => {
  function rawConnect(port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = netConnect({ host: '127.0.0.1', port }, () => resolve(socket));
      socket.once('error', reject);
    });
  }
  const firstChunk = (socket: Socket) => new Promise<string>((resolve) => socket.once('data', (d: Buffer) => resolve(d.toString())));
  const closed = (socket: Socket) => new Promise<void>((resolve) => (socket.destroyed ? resolve() : socket.once('close', () => resolve())));

  test('un tunnel CONNECT inactif est fermé après idleTimeoutMs', async () => {
    const proxy = await startEgressProxy({ guard: h.guard, idleTimeoutMs: 300 });
    try {
      const socket = await rawConnect(proxy.port);
      socket.write(`CONNECT fixture.zz-test:${h.fixturePort} HTTP/1.1\r\nHost: fixture.zz-test:${h.fixturePort}\r\n\r\n`);
      expect(await firstChunk(socket)).toMatch(/^HTTP\/1\.1 200/);
      const started = Date.now();
      await closed(socket);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await proxy.close();
    }
  });

  test('CONNECT sur le port 80 explicite : jamais un 400 de parsing', async () => {
    const proxy = await startEgressProxy({ guard: h.guard });
    try {
      const socket = await rawConnect(proxy.port);
      socket.write('CONNECT fixture.zz-test:80 HTTP/1.1\r\nHost: fixture.zz-test:80\r\n\r\n');
      expect(await firstChunk(socket)).toMatch(/^HTTP\/1\.1 (200|502)/);
      socket.destroy();
    } finally {
      await proxy.close();
    }
  });

  test('au-delà de maxConnections, la connexion reçoit 503 et est fermée', async () => {
    const proxy = await startEgressProxy({ guard: h.guard, maxConnections: 2 });
    try {
      const held = [await rawConnect(proxy.port), await rawConnect(proxy.port)];
      await new Promise((resolve) => setTimeout(resolve, 100));
      const extra = await rawConnect(proxy.port);
      expect(await firstChunk(extra)).toMatch(/^HTTP\/1\.1 503/);
      await closed(extra);
      for (const socket of held) socket.destroy();
    } finally {
      await proxy.close();
    }
  });
});
