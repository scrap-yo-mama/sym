// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.5 (04c § 1.3 à § 1.5) : proxy d'egress de session piloté par des clients TCP bruts (forme absolue et CONNECT),
// contre la fixture locale qui compte connexions et octets côté destination.
import { connect, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { EgressPolicy } from '@sym/contracts/browser';
import { startFixtureSite, type FixtureSite } from '../testing/egress-fixtures.js';
import { createEgressGuard, startClosedEgress, startSessionEgress, type EgressEvent, type SessionEgress, type SessionEgressDeps } from './index.js';

type Reply = { status: number; body: string; raw: Buffer };

function parseReply(raw: Buffer): Reply {
  const text = raw.toString('latin1');
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? '0');
  const split = text.indexOf('\r\n\r\n');
  return { status, body: split === -1 ? '' : text.slice(split + 4), raw };
}

/** Lit tout jusqu'à la fermeture (ou l'erreur) du socket. */
function readAll(socket: Socket): Promise<Buffer> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    socket.on('data', (part: Buffer) => parts.push(part));
    const done = () => resolve(Buffer.concat(parts));
    socket.once('close', done);
    socket.on('error', () => {});
  });
}

function open(egress: SessionEgress): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(egress.port, '127.0.0.1', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** Requête en forme absolue (`GET http://hôte:port/chemin`), connexion fermée après la réponse. */
async function viaHttp(egress: SessionEgress, target: string, extra = ''): Promise<Reply> {
  const socket = await open(egress);
  const url = new URL(target);
  const reading = readAll(socket);
  socket.write(`GET ${target} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n${extra}\r\n`);
  return parseReply(await reading);
}

/** CONNECT hôte:port puis requête HTTP dans le tunnel ; rend la réponse du CONNECT et celle de la destination. */
async function viaConnect(egress: SessionEgress, authority: string, path = '/'): Promise<{ connect: Reply; inner?: Reply }> {
  const socket = await open(egress);
  const parts: Buffer[] = [];
  let established = false;
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.on('error', () => {});
  socket.on('data', (part: Buffer) => {
    parts.push(part);
    if (!established && Buffer.concat(parts).includes('\r\n\r\n')) {
      established = true;
      const head = parseReply(Buffer.concat(parts));
      if (head.status === 200) {
        parts.length = 0;
        socket.write(`GET ${path} HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
      }
    }
  });
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  await closed;
  const all = Buffer.concat(parts);
  if (all.toString('latin1').startsWith('HTTP/1.1 403') || all.toString('latin1').startsWith('HTTP/1.1 502') || all.length === 0) {
    return { connect: parseReply(all) };
  }
  return { connect: { status: 200, body: '', raw: Buffer.alloc(0) }, inner: parseReply(all) };
}

const NAMES = { 'site-a.test': ['127.0.0.1'], 'site-b.test': ['127.0.0.1'], 'piege.test': ['127.0.0.1'], 'meta.test': ['169.254.169.254'], 'prive.test': ['10.0.0.7'] } as Record<string, string[]>;
const resolver = async (host: string) => {
  const list = NAMES[host];
  if (list === undefined) throw new Error('ENOTFOUND');
  return list.map((address) => ({ address, family: 4 as const }));
};

let site: FixtureSite;
const started: SessionEgress[] = [];

beforeEach(async () => {
  site = await startFixtureSite();
});
afterEach(async () => {
  for (const egress of started.splice(0)) await egress.close();
  await site.close();
  vi.useRealTimers();
});

async function egressFor(policy: EgressPolicy, deps: Partial<SessionEgressDeps> = {}): Promise<{ egress: SessionEgress; events: EgressEvent[] }> {
  const events: EgressEvent[] = [];
  const egress = await startSessionEgress(
    { ports: [site.port], ...policy },
    {
      guard: createEgressGuard({ privateHosts: ['site-a.test', 'site-b.test'], resolver }),
      onEvent: (event) => events.push(event),
      ...deps,
    },
  );
  started.push(egress);
  return { egress, events };
}

const settle = async (check: () => boolean, ms = 2_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

describe('proxy d’egress de session', () => {
  test('écoute sur 127.0.0.1, port éphémère, un par session', async () => {
    const { egress: a } = await egressFor({});
    const { egress: b } = await egressFor({});
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(a.port).not.toBe(b.port);
  });

  test('forme absolue et CONNECT admis : octets comptés à l’octet près contre la fixture', async () => {
    const { egress } = await egressFor({ allowedHosts: ['site-a.test'] });
    const http = await viaHttp(egress, `http://site-a.test:${site.port}/bytes?n=50000`);
    expect(http.status).toBe(200);
    expect(http.body.length).toBe(50_000);
    const tunnel = await viaConnect(egress, `site-a.test:${site.port}`, '/bytes?n=30000');
    expect(tunnel.inner?.status).toBe(200);
    expect(tunnel.inner?.body.length).toBe(30_000);
    await settle(() => egress.state().bytesIn === site.bytesWritten() && egress.state().bytesOut === site.bytesRead());
    const state = egress.state();
    expect(site.connections()).toBe(2);
    expect(state).toMatchObject({ epoch: 1, requests: 2, blocked: 0, budgetExceeded: false });
    expect(state.bytesIn).toBe(site.bytesWritten());
    expect(state.bytesOut).toBe(site.bytesRead());
    expect(egress.connections().map((c) => c.localPort).sort()).toEqual([...site.remotePorts].sort());
  });

  test('hôte hors politique : 403 domain_not_allowed, 0 connexion sortante, événement egress.blocked', async () => {
    const { egress, events } = await egressFor({ allowedHosts: ['site-a.test'] });
    const http = await viaHttp(egress, `http://site-b.test:${site.port}/`);
    expect(http).toMatchObject({ status: 403, body: 'domain_not_allowed' });
    const tunnel = await viaConnect(egress, `site-b.test:${site.port}`);
    expect(tunnel.connect).toMatchObject({ status: 403, body: 'domain_not_allowed' });
    expect(site.connections()).toBe(0);
    expect(egress.state()).toMatchObject({ requests: 2, blocked: 2 });
    expect(events[0]).toEqual({ type: 'egress.blocked', data: { host: 'site-b.test', reason: 'domain_not_allowed', port: site.port, count: 1 } });
  });

  test('port hors politique : 403 port_not_allowed', async () => {
    const { egress, events } = await egressFor({ ports: [443] });
    expect(await viaHttp(egress, `http://site-a.test:${site.port}/`)).toMatchObject({ status: 403, body: 'port_not_allowed' });
    expect(site.connections()).toBe(0);
    expect(events[0]?.data).toMatchObject({ reason: 'port_not_allowed', host: 'site-a.test' });
  });

  test.each([
    ['piege.test', 'boucle locale'],
    ['meta.test', 'métadonnées cloud'],
    ['prive.test', 'adresse privée'],
    ['127.0.0.1', 'IP littérale'],
  ])('%s (%s) : 403 address_not_public, 0 paquet vers la fixture', async (host) => {
    const { egress, events } = await egressFor({});
    expect(await viaHttp(egress, `http://${host}:${site.port}/`)).toMatchObject({ status: 403, body: 'address_not_public' });
    expect((await viaConnect(egress, `${host}:${site.port}`)).connect).toMatchObject({ status: 403, body: 'address_not_public' });
    expect(site.connections()).toBe(0);
    expect(events[0]?.data).toMatchObject({ reason: 'address_not_public' });
  });

  test('nom introuvable : 403 unresolvable', async () => {
    const { egress } = await egressFor({});
    expect(await viaHttp(egress, `http://absent.test:${site.port}/`)).toMatchObject({ status: 403, body: 'unresolvable' });
  });

  test('résolution unique par demande (pas de seconde résolution exploitable par rebinding)', async () => {
    const answers = ['127.0.0.1', '169.254.169.254'];
    const calls: string[] = [];
    const { egress } = await egressFor(
      {},
      {
        guard: createEgressGuard({
          privateHosts: ['rebind.test'],
          resolver: async (host) => {
            calls.push(host);
            return [{ address: answers[(calls.length - 1) % 2] ?? '', family: 4 }];
          },
        }),
      },
    );
    expect((await viaHttp(egress, `http://rebind.test:${site.port}/`)).status).toBe(200);
    expect(calls).toEqual(['rebind.test']);
    expect((await viaHttp(egress, `http://rebind.test:${site.port}/`)).status).toBe(403);
    expect(calls).toHaveLength(2);
    expect(site.connections()).toBe(1);
  });

  test('requêtes mal formées : 400 sans connexion sortante', async () => {
    const { egress } = await egressFor({});
    expect((await viaHttp(egress, `https://site-a.test:${site.port}/`)).status).toBe(400);
    expect((await viaConnect(egress, 'site-a.test')).connect.status).toBe(400);
    expect(site.connections()).toBe(0);
  });

  test('identifiants dans l’URL absolue refusés (400)', async () => {
    const { egress } = await egressFor({});
    expect((await viaHttp(egress, `http://u:p@site-a.test:${site.port}/`)).status).toBe(400);
  });
});

describe('budget d’octets (04c § 1.4)', () => {
  test('C4 : 1 Mo pour un budget de 100 000 → tunnel coupé avant budget + 1 bloc, événement unique, demandes suivantes 403', async () => {
    const ended: string[] = [];
    const { egress, events } = await egressFor({ budgetBytes: 100_000 }, { onBudgetEnd: () => ended.push('end') });
    const download = await viaConnect(egress, `site-a.test:${site.port}`, '/bytes?n=1000000');
    expect(download.inner?.body.length ?? 0).toBeLessThan(1_000_000);
    await settle(() => egress.state().budgetExceeded);
    const state = egress.state();
    expect(state.budgetExceeded).toBe(true);
    expect(state.bytesIn + state.bytesOut).toBeGreaterThanOrEqual(100_000);
    expect(state.bytesIn + state.bytesOut).toBeLessThan(100_000 + 65_536);
    expect(await viaHttp(egress, `http://site-a.test:${site.port}/`)).toMatchObject({ status: 403, body: 'budget_exceeded' });
    expect((await viaConnect(egress, `site-a.test:${site.port}`)).connect).toMatchObject({ status: 403, body: 'budget_exceeded' });
    const exceeded = events.filter((e) => e.type === 'egress.budget_exceeded');
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0]?.data).toMatchObject({ budgetBytes: 100_000, action: 'cut' });
    expect(events.some((e) => e.type === 'egress.blocked' && e.data.reason === 'budget_exceeded')).toBe(true);
    expect(ended).toEqual([]);
  });

  test('envoi : le sens sortant compte aussi et coupe au franchissement', async () => {
    const { egress } = await egressFor({ budgetBytes: 20_000 });
    const socket = await open(egress);
    const reading = readAll(socket);
    socket.write(`POST http://site-a.test:${site.port}/echo HTTP/1.1\r\nHost: site-a.test\r\nContent-Length: 500000\r\nConnection: close\r\n\r\n`);
    const chunk = Buffer.alloc(10_000, 0x62);
    for (let i = 0; i < 50 && !socket.destroyed; i++) {
      socket.write(chunk);
      await new Promise((r) => setTimeout(r, 2));
    }
    await reading;
    await settle(() => egress.state().budgetExceeded);
    expect(egress.state().budgetExceeded).toBe(true);
    expect(site.bytesRead()).toBeLessThan(20_000 + 65_536);
  });

  test('onBudgetExceeded: end → fin de session demandée (raison budget_exceeded)', async () => {
    const ended: string[] = [];
    const { egress, events } = await egressFor({ budgetBytes: 1_000, onBudgetExceeded: 'end' }, { onBudgetEnd: () => ended.push('budget_exceeded') });
    await viaHttp(egress, `http://site-a.test:${site.port}/bytes?n=10000`);
    await settle(() => ended.length > 0);
    expect(ended).toEqual(['budget_exceeded']);
    expect(events.find((e) => e.type === 'egress.budget_exceeded')?.data).toMatchObject({ action: 'end' });
  });

  test('budget effectif : le plus petit du budget de session et du reste du quota mensuel', async () => {
    const { egress } = await egressFor({ budgetBytes: 1_000_000 }, { remainingQuotaBytes: () => 0 });
    expect(await viaHttp(egress, `http://site-a.test:${site.port}/`)).toMatchObject({ status: 403, body: 'budget_exceeded' });
    expect(egress.state().budgetBytes).toBe(0);
    expect(site.connections()).toBe(0);
  });

  test('budget 0 : aucune connexion admise', async () => {
    const { egress } = await egressFor({ budgetBytes: 0 });
    expect(await viaHttp(egress, `http://site-a.test:${site.port}/`)).toMatchObject({ status: 403, body: 'budget_exceeded' });
    expect(site.connections()).toBe(0);
  });
});

describe('époques, fermeture, événements', () => {
  test('replace() ouvre une nouvelle époque : compteurs remis à zéro, nouvelle politique, tunnels de l’ancienne coupés', async () => {
    const { egress, events } = await egressFor({ allowedHosts: ['site-a.test'], budgetBytes: 1_000 });
    await viaHttp(egress, `http://site-a.test:${site.port}/bytes?n=5000`);
    await settle(() => egress.state().budgetExceeded);
    const next = egress.replace({ allowedHosts: ['site-b.test'], ports: [site.port] });
    expect(next).toMatchObject({ epoch: 2, requests: 0, blocked: 0, bytesIn: 0, bytesOut: 0, budgetExceeded: false });
    expect((await viaHttp(egress, `http://site-b.test:${site.port}/`)).status).toBe(200);
    expect((await viaHttp(egress, `http://site-a.test:${site.port}/`)).body).toBe('domain_not_allowed');
    expect(egress.state()).toMatchObject({ epoch: 2, requests: 2, blocked: 1 });
    expect(events.filter((e) => e.type === 'egress.budget_exceeded')).toHaveLength(1);
  });

  test('replace() avec une politique invalide : refus, époque inchangée', async () => {
    const { egress } = await egressFor({});
    expect(() => egress.replace({ ports: [0] })).toThrow(/ports/);
    expect(egress.state().epoch).toBe(1);
  });

  test('shut() (destruction, étape 2) : tunnels coupés, puis 403 egress_closed comptées', async () => {
    const { egress, events } = await egressFor({});
    const socket = await open(egress);
    const reading = readAll(socket);
    socket.write(`CONNECT site-a.test:${site.port} HTTP/1.1\r\nHost: site-a.test\r\n\r\n`);
    await settle(() => site.connections() === 1);
    egress.shut();
    await reading;
    expect(socket.destroyed).toBe(true);
    expect(await viaHttp(egress, `http://site-a.test:${site.port}/`)).toMatchObject({ status: 403, body: 'egress_closed' });
    expect(egress.state()).toMatchObject({ blocked: 1 });
    expect(events.at(-1)?.data).toMatchObject({ reason: 'egress_closed' });
    expect(site.connections()).toBe(1);
  });

  test('proxy de lancement fermé (shared) : toute demande reçoit 403 egress_closed et est comptée', async () => {
    const closed = await startClosedEgress({ guard: createEgressGuard({ resolver }) });
    started.push(closed);
    const egress = closed;
    expect(await viaHttp(egress, `http://site-a.test:${site.port}/`)).toMatchObject({ status: 403, body: 'egress_closed' });
    expect((await viaConnect(egress, `site-a.test:${site.port}`)).connect).toMatchObject({ status: 403, body: 'egress_closed' });
    expect(closed.state()).toMatchObject({ requests: 2, blocked: 2 });
    expect(site.connections()).toBe(0);
  });

  test('close() libère le port', async () => {
    const { egress } = await egressFor({});
    await egress.close();
    await expect(open(egress)).rejects.toThrow();
  });

  test('egress.blocked : première occurrence aussitôt, répétitions agrégées par fenêtre dans count', async () => {
    const { egress, events } = await egressFor({ allowedHosts: [] }, { blockedWindowMs: 300 });
    for (let i = 0; i < 5; i++) await viaHttp(egress, `http://site-b.test:${site.port}/`);
    await viaHttp(egress, `http://site-a.test:${site.port}/`);
    const blocked = () => events.filter((e) => e.type === 'egress.blocked').map((e) => e.data);
    expect(blocked()).toEqual([
      { host: 'site-b.test', reason: 'domain_not_allowed', port: site.port, count: 1 },
      { host: 'site-a.test', reason: 'domain_not_allowed', port: site.port, count: 1 },
    ]);
    await settle(() => blocked().length === 3, 1_000);
    expect(blocked()[2]).toEqual({ host: 'site-b.test', reason: 'domain_not_allowed', port: site.port, count: 4 });
    await new Promise((r) => setTimeout(r, 400));
    await viaHttp(egress, `http://site-b.test:${site.port}/`);
    expect(blocked().at(-1)).toMatchObject({ host: 'site-b.test', count: 1 });
    expect(egress.state().blocked).toBe(7);
  });

  test('compteurs poussés périodiquement (accroche de la persistance, tâche 0.2) et à la fermeture', async () => {
    const pushed: number[] = [];
    const { egress } = await egressFor({}, { countersIntervalMs: 50, onCounters: (state) => pushed.push(state.requests) });
    await viaHttp(egress, `http://site-a.test:${site.port}/`);
    await settle(() => pushed.length >= 2, 1_000);
    await egress.close();
    expect(pushed.at(-1)).toBe(1);
  });
});

describe('proxy amont (accroche de la tâche 1.6)', () => {
  test('politique avec upstream sans relais amont branché : démarrage refusé', async () => {
    await expect(egressFor({ upstream: { type: 'http', host: 'proxy.test', port: 8080 } })).rejects.toThrow(/upstream/);
  });

  test('dnsViaProxy vrai : le nom est contrôlé puis transmis à l’amont sans résolution locale ; faux : adresse épinglée', async () => {
    const seen: { host: string; port: number; address?: string }[] = [];
    const calls: string[] = [];
    const guard = createEgressGuard({
      privateHosts: ['site-a.test'],
      resolver: async (host) => {
        calls.push(host);
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });
    const dialUpstream: SessionEgressDeps['dialUpstream'] = (target) => {
      seen.push(target);
      return new Promise((resolve, reject) => {
        const socket = connect(site.port, '127.0.0.1', () => resolve(socket));
        socket.once('error', reject);
      });
    };
    const upstream = { type: 'http' as const, host: 'proxy.test', port: 8080 };
    const { egress } = await egressFor({ upstream }, { guard, dialUpstream });
    expect((await viaHttp(egress, `http://site-a.test:${site.port}/`)).status).toBe(200);
    expect(seen.at(-1)).toEqual({ host: 'site-a.test', port: site.port });
    expect(calls).toEqual([]);
    expect(await viaHttp(egress, `http://localhost:${site.port}/`)).toMatchObject({ status: 403, body: 'address_not_public' });
    egress.replace({ upstream, dnsViaProxy: false, ports: [site.port] });
    expect((await viaHttp(egress, `http://site-a.test:${site.port}/`)).status).toBe(200);
    expect(seen.at(-1)).toEqual({ host: 'site-a.test', port: site.port, address: '127.0.0.1' });
    expect(calls).toEqual(['site-a.test']);
    await settle(() => egress.state().bytesIn === site.bytesWritten());
    expect(egress.state().bytesIn).toBe(site.bytesWritten());
  });
});
