// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.6 : proxy d'egress de Chromium chaîné au proxy BYO de 1.4 (CONNECT et SOCKS5), cible contrôlée par la garde
// AVANT le tunnel, connexion au proxy sous sa propre garde, coût proxy compté ; proxy de lancement fermé.
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { startClient, type Client } from '../../fixtures/src/test-helpers.ts';
import { Secret } from '../../packages/core/src/crypto/index.ts';
import {
  createUpstreamDialer,
  DomainNotAllowedError,
  openBrowserEgress,
  openNetworkSession,
  parseProxyDefinition,
  ProxyBudgetExceededError,
  SsrfBlockedError,
  startEgressProxy,
  UpstreamProxyError,
  type ProxyCredentials,
} from '../../packages/core/src/net/index.ts';
import { fixtureGuard } from '../helpers/fixture-net.ts';
import { startConnectProxy, startSocks5Proxy, type UpstreamTestProxy } from '../helpers/upstream-proxies.ts';

const SPA = 'zz_test_spa.localhost';
let client: Client;
let connectProxy: UpstreamTestProxy;
let socksProxy: UpstreamTestProxy;
const creds: ProxyCredentials = { username: new Secret('zz_test_user'), password: new Secret('zz_test_pass') };
const wrong: ProxyCredentials = { username: new Secret('zz_test_user'), password: new Secret('zz_test_nope') };

const proxyDef = (url: string, allowPrivate = true) =>
  parseProxyDefinition({
    id: 'zz_test_dc',
    type: 'dc',
    url,
    credentials_secret_id: 'zz_test_secret',
    username_template: '{username}[-country-{country}]',
    allow_private_address: allowPrivate,
    price: { per_gb_usd: 10, per_request_usd: 0.001 },
  });

/** Requête HTTP brute dans un tunnel déjà ouvert. */
function httpOverSocket(socket: Socket, host: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.once('error', reject);
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  });
}

/** GET en forme absolue vers un proxy d'egress (comme Chromium pour une URL http). */
function viaEgress(egressPort: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request({ host: '127.0.0.1', port: egressPort, method: 'GET', path: url, headers: { host: target.host }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  client = await startClient();
  connectProxy = await startConnectProxy({ password: 'zz_test_pass' });
  socksProxy = await startSocks5Proxy({ username: 'zz_test_user-country-fr', password: 'zz_test_pass' });
});
afterAll(async () => {
  await connectProxy.close();
  await socksProxy.close();
  await client.close();
});
beforeEach(() => {
  connectProxy.log.length = 0;
  socksProxy.log.length = 0;
});

describe('createUpstreamDialer', () => {
  test('CONNECT : tunnel vers la cible par le proxy, identité fournisseur rendue, octets comptés', async () => {
    const dialer = createUpstreamDialer({ proxy: proxyDef(connectProxy.url), params: { country: 'fr' }, credentials: creds });
    const socket = await dialer.dial(SPA, client.server.port);
    const raw = await httpOverSocket(socket, `${SPA}:${client.server.port}`, '/api/items.json');
    expect(raw).toMatch(/^HTTP\/1\.1 200/);
    expect(raw).toContain('"items"');
    expect(connectProxy.log).toEqual([{ target: `${SPA}:${client.server.port}`, username: 'zz_test_user-country-fr', password: 'zz_test_pass' }]);
    expect(dialer.usage().tunnels).toBe(1);
    expect(dialer.usage().bytes).toBeGreaterThan(raw.length);
  });

  test('SOCKS5 (RFC 1928, authentification RFC 1929) : même tunnel', async () => {
    const dialer = createUpstreamDialer({ proxy: proxyDef(socksProxy.url), params: { country: 'fr' }, credentials: creds });
    const socket = await dialer.dial(SPA, client.server.port);
    const raw = await httpOverSocket(socket, `${SPA}:${client.server.port}`, '/api/items.json');
    expect(raw).toContain('"items"');
    expect(socksProxy.log[0]).toEqual({ target: `${SPA}:${client.server.port}`, username: 'zz_test_user-country-fr', password: 'zz_test_pass' });
  });

  test('identifiants refusés → proxy_auth_failed (CONNECT 407 et SOCKS5)', async () => {
    for (const url of [connectProxy.url, socksProxy.url]) {
      const dialer = createUpstreamDialer({ proxy: proxyDef(url), params: { country: 'fr' }, credentials: wrong });
      const error = await dialer.dial(SPA, client.server.port).catch((e: unknown) => e);
      expect(error, url).toBeInstanceOf(UpstreamProxyError);
      expect((error as UpstreamProxyError).code).toBe('proxy_auth_failed');
      expect(String((error as Error).message)).not.toContain('zz_test_nope');
    }
  });

  test('proxy en adresse privée sans dérogation admin (`allow_private_address`) → refus de la garde du proxy', async () => {
    const dialer = createUpstreamDialer({ proxy: proxyDef(connectProxy.url, false), params: {}, credentials: creds });
    await expect(dialer.dial(SPA, client.server.port)).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(connectProxy.log).toHaveLength(0);
  });
});

describe('assert_browser_egress_chained : openBrowserEgress (proxy d’egress du contexte Chromium)', () => {
  test('dc_proxy : la requête du navigateur sort par le proxy BYO, coût proxy imputé', async () => {
    const egress = await openBrowserEgress({
      rung: { mode: 'dc_proxy', proxy: proxyDef(connectProxy.url), params: { country: 'fr' } },
      guard: fixtureGuard(client.server.port, [SPA]),
      credentials: creds,
    });
    try {
      const res = await viaEgress(Number(new URL(egress.server).port), `http://${SPA}:${client.server.port}/api/items.json`);
      expect(res.status).toBe(200);
      expect(res.body).toContain('"items"');
      expect(connectProxy.log.map((e) => e.target)).toEqual([`${SPA}:${client.server.port}`]);
      const usage = egress.usage();
      expect(usage).toMatchObject({ mode: 'dc_proxy', proxyId: 'zz_test_dc', requests: 1 });
      expect(usage.bytes).toBeGreaterThan(0);
      expect(usage.costUsd).toBeGreaterThan(0);
    } finally {
      await egress.close();
    }
  });

  test('cible refusée par la garde : 403 ssrf_blocked, le proxy BYO ne voit rien passer', async () => {
    const egress = await openBrowserEgress({
      rung: { mode: 'dc_proxy', proxy: proxyDef(connectProxy.url), params: {} },
      guard: fixtureGuard(client.server.port, [SPA]),
      credentials: creds,
    });
    try {
      const res = await viaEgress(Number(new URL(egress.server).port), `http://zz_test_dom.localhost:${client.server.port}/`);
      expect(res).toEqual({ status: 403, body: 'ssrf_blocked' });
      expect(egress.blocked.map((b) => b.reason)).toEqual(['unresolvable']);
      expect(connectProxy.log).toHaveLength(0);
    } finally {
      await egress.close();
    }
  });

  test('direct : aucun coût proxy', async () => {
    const egress = await openBrowserEgress({ rung: { mode: 'direct' }, guard: fixtureGuard(client.server.port, [SPA]) });
    try {
      expect((await viaEgress(Number(new URL(egress.server).port), `http://${SPA}:${client.server.port}/`)).status).toBe(200);
      expect(egress.usage()).toMatchObject({ mode: 'direct', proxyId: null, bytes: 0, costUsd: 0, requests: 1 });
    } finally {
      await egress.close();
    }
  });
});

test('proxy de lancement fermé : toute demande refusée (403 egress_closed) et comptée, aucune connexion sortante', async () => {
  const seen: string[] = [];
  const closed = await startEgressProxy({ guard: fixtureGuard(client.server.port, [SPA]), refuseAll: true, onRequest: (t) => seen.push(`${t.via} ${t.host}`) });
  try {
    await client.reset();
    expect(await viaEgress(closed.port, `http://${SPA}:${client.server.port}/`)).toEqual({ status: 403, body: 'egress_closed' });
    expect(closed.requests()).toBe(1);
    expect(seen).toEqual([`http ${SPA}`]);
    expect((await client.stats()).hosts[SPA]?.total ?? 0).toBe(0);
  } finally {
    await closed.close();
  }
});

/** CONNECT brut vers un proxy d'egress (comme Chromium pour https et ws) : ligne de statut et corps de la réponse. */
function connectVia(egressPort: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: egressPort, method: 'CONNECT', path: authority, agent: false });
    req.on('connect', (res, socket, head) => {
      if (res.statusCode === 200) {
        socket.destroy();
        resolve('200');
        return;
      }
      // Refus : Node remet aussi la réponse non 200 d'un CONNECT par « connect » ; le corps suit sur le socket.
      const chunks: Buffer[] = [head];
      socket.on('data', (c: Buffer) => chunks.push(c));
      socket.on('close', () => resolve(`${res.statusCode} ${Buffer.concat(chunks).toString('utf8')}`));
    });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(`${res.statusCode} ${Buffer.concat(chunks).toString('utf8')}`));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('assert_domain_lock_redirects : politique de domaines de l’API dans le proxy d’egress et la session réseau', () => {
  const SSRF = 'zz_test_ssrf.localhost';
  const INTERNAL = 'zz_test_internal.localhost';

  test('proxy d’egress : http et CONNECT vers un hôte hors API → 403 domain_not_allowed, journalisé, 0 requête reçue', async () => {
    await client.reset();
    const egress = await openBrowserEgress({ rung: { mode: 'direct' }, guard: fixtureGuard(client.server.port, [SSRF, INTERNAL]), allowedHosts: [SSRF] });
    try {
      const port = Number(new URL(egress.server).port);
      const seen: string[] = [];
      const unsubscribe = egress.onDomainBlocked((t) => {
        seen.push(t.host);
        unsubscribe();
      });
      // Le saut de redirection que Chromium suivrait : la première réponse (302) passe, la suivante est refusée.
      const hop1 = await viaEgress(port, `http://${SSRF}:${client.server.port}/to-internal`);
      expect(hop1.status).toBe(302);
      expect(await viaEgress(port, `http://${INTERNAL}:${client.server.port}/secret`)).toEqual({ status: 403, body: 'domain_not_allowed' });
      expect(await connectVia(port, `${INTERNAL}:${client.server.port}`)).toBe('403 domain_not_allowed');
      expect(await connectVia(port, `${INTERNAL.toUpperCase()}.:${client.server.port}`)).toBe('403 domain_not_allowed');
      expect(egress.domainBlocked.map((d) => d.host)).toEqual([INTERNAL, INTERNAL, INTERNAL]);
      // Abonnement (E3 en script : refus du verrou relié au guet du bac à sable) et compte non plafonné.
      expect(seen).toEqual([INTERNAL]);
      expect(egress.domainBlockedCount()).toBe(3);
      expect((await client.stats()).hosts[INTERNAL]?.total ?? 0).toBe(0);
    } finally {
      await egress.close();
    }
  });

  test.each([[302], [307]] as const)('session réseau (E1, ctx.fetch) : redirection %i vers un hôte hors API refusée avant toute requête', async (status) => {
    await client.reset();
    const session = openNetworkSession({ rung: { mode: 'direct' }, guard: fixtureGuard(client.server.port, [SSRF, INTERNAL]), allowedHosts: [SSRF] });
    try {
      const init = status === 307 ? { method: 'POST', body: 'zz_test_exfil' } : {};
      const error = await session.fetch(`http://${SSRF}:${client.server.port}/to-internal?status=${status}`, init).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DomainNotAllowedError);
      expect((error as DomainNotAllowedError).host).toBe(INTERNAL);
      await expect(session.fetch(`http://${INTERNAL}:${client.server.port}/secret`)).rejects.toBeInstanceOf(DomainNotAllowedError);
      expect((await client.stats()).hosts[INTERNAL]?.total ?? 0).toBe(0);
      expect((await client.stats()).hosts[SSRF]?.total ?? 0).toBe(1);
    } finally {
      await session.close();
    }
  });
});

describe('assert_run_cost_capped : max_cost_usd tenu pendant le run (proxy d’egress et session réseau)', () => {
  // 0,004 $ par requête, rien au Go : plafond 0,01 $ → deux requêtes, la troisième est refusée (0,012 > 0,01).
  const priced = (url: string) =>
    parseProxyDefinition({ id: 'zz_test_dc', type: 'dc', url, credentials_secret_id: 'zz_test_secret', allow_private_address: true, price: { per_gb_usd: 0, per_request_usd: 0.004 } });

  test('proxy d’egress : nouveau tunnel refusé (403 run_budget_exceeded) dès que le plafond serait dépassé', async () => {
    await client.reset();
    const egress = await openBrowserEgress({
      rung: { mode: 'dc_proxy', proxy: priced(connectProxy.url), params: {} },
      guard: fixtureGuard(client.server.port, [SPA]),
      credentials: creds,
      costCeiling: { maxUsd: 0.01 },
    });
    try {
      const port = Number(new URL(egress.server).port);
      const url = `http://${SPA}:${client.server.port}/api/items.json`;
      expect((await viaEgress(port, url)).status).toBe(200);
      expect((await viaEgress(port, url)).status).toBe(200);
      expect(egress.budgetExceeded()).toBe(false);
      expect(await viaEgress(port, url)).toEqual({ status: 403, body: 'run_budget_exceeded' });
      expect(await connectVia(port, `${SPA}:${client.server.port}`)).toBe('403 run_budget_exceeded');
      expect(egress.budgetExceeded()).toBe(true);
      expect(egress.usage().costUsd).toBeLessThanOrEqual(0.01);
      expect(connectProxy.log).toHaveLength(2);
    } finally {
      await egress.close();
    }
  });

  test('session réseau : requête refusée avant envoi (ProxyBudgetExceededError), coût imputé ≤ plafond', async () => {
    await client.reset();
    const session = openNetworkSession({
      rung: { mode: 'dc_proxy', proxy: priced(connectProxy.url), params: {} },
      guard: fixtureGuard(client.server.port, [SPA]),
      credentials: creds,
      costCeiling: { maxUsd: 0.01 },
    });
    try {
      const url = `http://${SPA}:${client.server.port}/api/items.json`;
      expect((await session.fetch(url)).status).toBe(200);
      expect((await session.fetch(url)).status).toBe(200);
      await expect(session.fetch(url)).rejects.toBeInstanceOf(ProxyBudgetExceededError);
      expect(session.usage().costUsd).toBeLessThanOrEqual(0.01);
      expect((await client.stats()).hosts[SPA]?.total ?? 0).toBe(2);
    } finally {
      await session.close();
    }
  });

  // Prix au Go (5 $/Go) et plafond de 0,002 $ : 400 ko de budget ; le corps fait 8 Mo. Le transfert est coupé au niveau
  // des octets (budget restant), pas après coup : le coût imputé reste sous le plafond.
  describe('prix au Go : gros corps coupé au niveau des octets, coût imputé ≤ plafond', () => {
    const BIG = 'zz_test_big.localhost';
    const BODY_BYTES = 8 * 1024 * 1024;
    let big: Server;
    let bigPort: number;
    const perGb = (url: string) =>
      parseProxyDefinition({ id: 'zz_test_dc', type: 'dc', url, credentials_secret_id: 'zz_test_secret', allow_private_address: true, price: { per_gb_usd: 5, per_request_usd: 0 } });
    beforeAll(async () => {
      const chunk = Buffer.alloc(64 * 1024, 120);
      big = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(BODY_BYTES) });
        let sent = 0;
        const pump = () => {
          while (sent < BODY_BYTES) {
            sent += chunk.length;
            if (!res.write(chunk)) return void res.once('drain', pump);
          }
          res.end();
        };
        res.on('error', () => undefined);
        pump();
      });
      await new Promise<void>((resolve) => big.listen(0, '127.0.0.1', () => resolve()));
      bigPort = (big.address() as AddressInfo).port;
    });
    afterAll(async () => {
      big.closeAllConnections();
      await new Promise<void>((resolve) => big.close(() => resolve()));
    });

    test('proxy d’egress (tunnel CONNECT ouvert) : coupé en cours de transfert, budgetExceeded, coût ≤ plafond', async () => {
      const egress = await openBrowserEgress({
        rung: { mode: 'dc_proxy', proxy: perGb(connectProxy.url), params: {} },
        guard: fixtureGuard(bigPort, [BIG]),
        credentials: creds,
        costCeiling: { maxUsd: 0.002 },
        // Contrôle périodique ralenti : seul le contrôle par octets peut couper à temps.
        costWatchMs: 60_000,
      });
      try {
        const port = Number(new URL(egress.server).port);
        const received = await new Promise<number>((resolve) => {
          const req = request({ host: '127.0.0.1', port, method: 'CONNECT', path: `${BIG}:${bigPort}`, agent: false });
          req.on('connect', (_res, socket: Socket) => {
            let bytes = 0;
            socket.on('data', (c: Buffer) => (bytes += c.length));
            socket.on('close', () => resolve(bytes));
            socket.on('error', () => undefined);
            socket.write(`GET /big HTTP/1.1\r\nHost: ${BIG}:${bigPort}\r\nConnection: close\r\n\r\n`);
          });
          req.on('error', () => resolve(-1));
          req.end();
        });
        expect(received).toBeGreaterThan(0);
        expect(received).toBeLessThan(BODY_BYTES);
        expect(egress.budgetExceeded()).toBe(true);
        expect(egress.usage().costUsd).toBeLessThanOrEqual(0.002);
      } finally {
        await egress.close();
      }
    });

    test('session réseau : corps coupé pendant la lecture (ProxyBudgetExceededError), coût ≤ plafond', async () => {
      const session = openNetworkSession({
        rung: { mode: 'dc_proxy', proxy: perGb(connectProxy.url), params: {} },
        guard: fixtureGuard(bigPort, [BIG]),
        credentials: creds,
        costCeiling: { maxUsd: 0.002 },
      });
      try {
        const error = await session
          .fetch(`http://${BIG}:${bigPort}/big`)
          .then((res) => res.arrayBuffer())
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(error).toBeDefined();
        expect(session.budgetExceeded()).toBe(true);
        expect(session.usage().costUsd).toBeLessThanOrEqual(0.002);
      } finally {
        await session.close();
      }
    });

    // Revue de 1.11 (lecture bornée sous plafond) : coupé dès le PREMIER bloc, le corps restait ouvert et le lecteur
    // attendait son délai (ici aucun : il attendait indéfiniment). Le signal d'abandon de la session le coupe aussitôt.
    test('session réseau : corps coupé dès le premier bloc (budget presque épuisé) → erreur immédiate, coût ≤ plafond', async () => {
      const session = openNetworkSession({
        rung: { mode: 'dc_proxy', proxy: perGb(connectProxy.url), params: {} },
        guard: fixtureGuard(bigPort, [BIG]),
        credentials: creds,
        costCeiling: { maxUsd: 0.0005 },
      });
      try {
        const started = Date.now();
        const read = (async () => {
          const response = await session.fetch(`http://${BIG}:${bigPort}/big`);
          const reader = (response.body as ReadableStream<Uint8Array>).getReader();
          for (;;) if ((await reader.read()).done) return 'fini';
        })();
        const outcome = await Promise.race([
          read.then(
            (v) => v,
            (e: unknown) => e,
          ),
          new Promise((resolve) => setTimeout(() => resolve('attente'), 3000)),
        ]);
        expect(outcome).toBeInstanceOf(ProxyBudgetExceededError);
        expect(Date.now() - started).toBeLessThan(3000);
        expect(session.budgetExceeded()).toBe(true);
        expect(session.usage().costUsd).toBeLessThanOrEqual(0.0005);
      } finally {
        await session.close();
      }
    });
  });
});
