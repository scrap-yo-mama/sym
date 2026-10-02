// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.6 (04c § 2.3, 04 § 6) : egress d'une session branché sur un proxy amont. À la création, l'hôte du proxy est résolu
// et épinglé, le tunnel authentifié testé par le point d'écho (`exitIp`, `latencyMs`) ; tout échec donne 502
// `proxy_unreachable` (motif dans `details`) sans egress démarré. En cours de session, l'egress sort uniquement par cet amont
// (jamais de repli direct ni d'autre proxy après un refus) et compte les octets échangés avec lui.
import { connect, type Socket } from 'node:net';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { MasterKey, kekFor } from '@sym-browser/core';
import { PROXY_HTTP_CREDENTIALS, PROXY_SOCKS5_CREDENTIALS } from '../../../../../fixtures/src/config.ts';
import { startHttpProxy } from '../../../../../fixtures/src/http-proxy.ts';
import { startSite, type SiteHandle } from '../../../../../fixtures/src/site.ts';
import { startSocks5Proxy } from '../../../../../fixtures/src/socks5-proxy.ts';
import { startCountingRelay, type CountingRelay } from '../../testing/egress-fixtures.js';
import { createEgressGuard, startSessionEgress, type EgressEvent } from '../index.js';
import { ProxyUnreachableError, UpstreamError, createMemoryProxyProfileStore, createProxyProfiles, startUpstreamSessionEgress, type UpstreamSession } from './index.js';

type ProxyHandle = Awaited<ReturnType<typeof startHttpProxy>>;
const TENANT = '00000000-0000-4000-8000-0000000000a1';

let site: SiteHandle;
let httpProxy: ProxyHandle;
let socksProxy: ProxyHandle;
let httpRelay: CountingRelay;
const sessions: UpstreamSession[] = [];

const guard = () => createEgressGuard({ privateHosts: ['127.0.0.1'] });
const echoUrl = () => `http://127.0.0.1:${site.port}/__ip`;

beforeAll(async () => {
  site = await startSite({ host: '127.0.0.1' });
  httpProxy = await startHttpProxy({ host: '127.0.0.1', credentials: PROXY_HTTP_CREDENTIALS });
  socksProxy = await startSocks5Proxy({ host: '127.0.0.1', credentials: PROXY_SOCKS5_CREDENTIALS });
  httpRelay = await startCountingRelay(httpProxy.port);
});
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.egress.close();
});
afterAll(async () => {
  await httpRelay.close();
  await socksProxy.close();
  await httpProxy.close();
  await site.close();
});

/** GET en forme absolue à travers l'egress, connexion fermée après la réponse. */
function viaEgress(url: string, port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\nConnection: close\r\n\r\n`);
    });
    const parts: Buffer[] = [];
    socket.on('data', (part: Buffer) => parts.push(part));
    socket.on('error', reject);
    socket.once('close', () => {
      const text = Buffer.concat(parts).toString('utf8');
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? '0'), body: text.slice(text.indexOf('\r\n\r\n') + 4) });
    });
  });
}

async function start(upstream: Parameters<typeof startUpstreamSessionEgress>[0]['upstream'], extra: Partial<Parameters<typeof startUpstreamSessionEgress>[1]> = {}) {
  const events: EgressEvent[] = [];
  const session = await startUpstreamSessionEgress(
    { upstream, ports: [site.port] },
    { tenantId: TENANT, guard: guard(), echoUrl: echoUrl(), onEvent: (e) => events.push(e), ...extra },
  );
  sessions.push(session);
  return { session, events };
}

describe('création avec proxy amont (04c § 2.3)', () => {
  test('http avec identifiants : test de connectivité (exitIp, latencyMs), puis navigation par l’amont seulement', async () => {
    const before = httpProxy.journal.entries().length;
    const { session } = await start({ type: 'http', host: '127.0.0.1', port: httpProxy.port, ...PROXY_HTTP_CREDENTIALS });
    expect(session.exitIp).toBe('127.0.0.1');
    expect(session.latencyMs).toBeGreaterThanOrEqual(0);
    expect(session.latencyMs).toBeLessThan(10_000);
    const reply = await viaEgress(`http://127.0.0.1:${site.port}/__ip`, session.egress.port);
    expect(reply.status).toBe(200);
    const entries = httpProxy.journal.entries().slice(before);
    // Test d'écho puis navigation : deux tunnels authentifiés au nom de l'utilisateur du proxy.
    expect(entries.map((e) => [e.method, e.user, e.outcome])).toEqual([
      ['CONNECT', PROXY_HTTP_CREDENTIALS.username, 'ok'],
      ['CONNECT', PROXY_HTTP_CREDENTIALS.username, 'ok'],
    ]);
  });

  test('socks5 par profil nommé chiffré : identifiants relus en mémoire, page servie par le relais', async () => {
    const profiles = createProxyProfiles({ store: createMemoryProxyProfileStore(), keys: { current: kekFor(MasterKey.generate(), 1) } });
    const { id } = await profiles.create(TENANT, { name: 'socks', type: 'socks5', host: '127.0.0.1', port: socksProxy.port, ...PROXY_SOCKS5_CREDENTIALS });
    const before = socksProxy.journal.entries().length;
    const { session } = await start({ profileId: id }, { profiles });
    expect(session.exitIp).toBe('127.0.0.1');
    expect((await viaEgress(`http://127.0.0.1:${site.port}/__ip`, session.egress.port)).status).toBe(200);
    expect(socksProxy.journal.entries().slice(before).every((e) => e.user === PROXY_SOCKS5_CREDENTIALS.username && e.outcome === 'ok')).toBe(true);
  });

  test('octets de la session : ceux échangés avec le proxy amont (en-têtes de tunnel compris), à l’octet près', async () => {
    const { session } = await start({ type: 'http', host: '127.0.0.1', port: httpRelay.port, ...PROXY_HTTP_CREDENTIALS });
    const read = httpRelay.bytesRead();
    const written = httpRelay.bytesWritten();
    expect((await viaEgress(`http://127.0.0.1:${site.port}/heavy/payload.js?bytes=200000`, session.egress.port)).status).toBe(200);
    const end = Date.now() + 2_000;
    while (session.egress.state().bytesIn !== httpRelay.bytesWritten() - written && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    expect(session.egress.state().bytesIn).toBe(httpRelay.bytesWritten() - written);
    expect(session.egress.state().bytesOut).toBe(httpRelay.bytesRead() - read);
    expect(session.egress.state().bytesIn).toBeGreaterThan(200_000);
  });

  test.each([
    ['proxy injoignable', () => ({ type: 'http' as const, host: '127.0.0.1', port: 1, ...PROXY_HTTP_CREDENTIALS }), 'connect_failed'],
    ['mauvais mot de passe http', () => ({ type: 'http' as const, host: '127.0.0.1', port: httpProxy.port, username: PROXY_HTTP_CREDENTIALS.username, password: 'zz_test_faux_http' }), 'upstream_auth_failed'],
    ['mauvais mot de passe socks5', () => ({ type: 'socks5' as const, host: '127.0.0.1', port: socksProxy.port, username: PROXY_SOCKS5_CREDENTIALS.username, password: 'zz_test_faux_socks' }), 'upstream_auth_failed'],
    ['proxy vers une adresse non publique', () => ({ type: 'socks5' as const, host: '10.0.0.9', port: 1080 }), 'address_not_public'],
  ])('%s : 502 proxy_unreachable (motif %s), aucun egress démarré, 0 connexion directe vers la fixture', async (_name, upstream, reason) => {
    const before = site.journal.entries().length;
    let started = 0;
    const error = await startUpstreamSessionEgress(
      { upstream: upstream(), ports: [site.port] },
      { tenantId: TENANT, guard: guard(), echoUrl: echoUrl(), onEgressStarted: () => void (started += 1) },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProxyUnreachableError);
    expect(error).toMatchObject({ code: 'proxy_unreachable', status: 502, retryable: true, details: { reason } });
    expect(started).toBe(0);
    expect(site.journal.entries().length).toBe(before);
    for (const text of [String(error), JSON.stringify(error), inspect(error, { depth: 5 })]) {
      expect(text).not.toMatch(/zz_test_faux|zz_test_http_pw|zz_test_socks_pw/);
    }
  });

  test('point d’écho muet : délai borné, proxy_unreachable (timeout)', async () => {
    const { createServer } = await import('node:net');
    const mute = createServer((socket) => socket.on('data', () => {}));
    await new Promise<void>((resolve) => mute.listen(0, '127.0.0.1', () => resolve()));
    const port = (mute.address() as { port: number }).port;
    const error = await startUpstreamSessionEgress(
      { upstream: { type: 'http', host: '127.0.0.1', port: httpProxy.port, ...PROXY_HTTP_CREDENTIALS }, ports: [site.port] },
      { tenantId: TENANT, guard: guard(), echoUrl: `http://127.0.0.1:${port}/`, probeTimeoutMs: 300 },
    ).catch((e: unknown) => e);
    mute.close();
    expect(error).toMatchObject({ code: 'proxy_unreachable', details: { reason: 'timeout' } });
  });

  test('profil inconnu : invalid_option (pas un proxy injoignable)', async () => {
    const profiles = createProxyProfiles({ store: createMemoryProxyProfileStore(), keys: { current: kekFor(MasterKey.generate(), 1) } });
    await expect(start({ profileId: '00000000-0000-4000-8000-0000000000ff' }, { profiles })).rejects.toMatchObject({ code: 'invalid_option', field: 'egress.upstream.profileId' });
  });
});

describe('en cours de session : l’amont seul, jamais de repli', () => {
  test('amont qui refuse l’authentification : 502 upstream_auth_failed au navigateur, 0 connexion directe, aucun autre proxy', async () => {
    const dialed: string[] = [];
    const egress = await startSessionEgress(
      { upstream: { type: 'http', host: 'proxy.test', port: 3128 }, ports: [site.port] },
      {
        guard: guard(),
        dialUpstream: async (target) => {
          dialed.push(`${target.host}:${target.port}`);
          throw new UpstreamError('upstream_auth_failed');
        },
      },
    );
    try {
      const before = site.journal.entries().length;
      const reply = await viaEgress(`http://127.0.0.1:${site.port}/__ip`, egress.port);
      expect(reply).toMatchObject({ status: 502, body: 'upstream_auth_failed' });
      expect((await viaEgress(`http://127.0.0.1:${site.port}/__ip`, egress.port)).body).toBe('upstream_auth_failed');
      expect(dialed).toEqual([`127.0.0.1:${site.port}`, `127.0.0.1:${site.port}`]);
      expect(site.journal.entries().length).toBe(before);
      expect(egress.state().blocked).toBe(0);
    } finally {
      await egress.close();
    }
  });

  test('proxy amont arrêté en cours de session : 502, toujours sans sortie directe', async () => {
    const proxy = await startHttpProxy({ host: '127.0.0.1', credentials: PROXY_HTTP_CREDENTIALS });
    const { session } = await start({ type: 'http', host: '127.0.0.1', port: proxy.port, ...PROXY_HTTP_CREDENTIALS });
    await proxy.close();
    const before = site.journal.entries().length;
    expect((await viaEgress(`http://127.0.0.1:${site.port}/__ip`, session.egress.port)).status).toBe(502);
    expect(site.journal.entries().length).toBe(before);
  });

  test('événements, compteurs et refus de la session : aucun identifiant du proxy', async () => {
    const { session, events } = await start({ type: 'http', host: '127.0.0.1', port: httpProxy.port, ...PROXY_HTTP_CREDENTIALS }, { blockedWindowMs: 10 });
    await viaEgress(`http://interdit.test:${site.port}/`, session.egress.port);
    await viaEgress(`http://127.0.0.1:${site.port}/__ip`, session.egress.port);
    const seen = JSON.stringify({ events, state: session.egress.state(), session: { exitIp: session.exitIp, latencyMs: session.latencyMs }, inspected: inspect(session, { depth: 6 }) });
    expect(seen).not.toContain(PROXY_HTTP_CREDENTIALS.password);
    expect(seen).not.toContain(Buffer.from(`${PROXY_HTTP_CREDENTIALS.username}:${PROXY_HTTP_CREDENTIALS.password}`).toString('base64'));
  });

  test('PUT egress avec un nouvel amont : résolu et testé avant la nouvelle époque ; injoignable → refus, époque inchangée', async () => {
    const { session } = await start({ type: 'http', host: '127.0.0.1', port: httpProxy.port, ...PROXY_HTTP_CREDENTIALS });
    await expect(session.replace({ upstream: { type: 'http', host: '127.0.0.1', port: 1, ...PROXY_HTTP_CREDENTIALS }, ports: [site.port] })).rejects.toBeInstanceOf(ProxyUnreachableError);
    expect(session.egress.state().epoch).toBe(1);
    const before = socksProxy.journal.entries().length;
    const state = await session.replace({ upstream: { type: 'socks5', host: '127.0.0.1', port: socksProxy.port, ...PROXY_SOCKS5_CREDENTIALS }, ports: [site.port] });
    expect(state.epoch).toBe(2);
    expect(state.exitIp).toBe('127.0.0.1');
    expect((await viaEgress(`http://127.0.0.1:${site.port}/__ip`, session.egress.port)).status).toBe(200);
    expect(socksProxy.journal.entries().length).toBeGreaterThan(before);
  });

  test('sans amont : sortie directe de 1.5 inchangée, pas de test d’écho', async () => {
    const { session } = await start(undefined);
    expect(session.exitIp).toBeUndefined();
    expect((await viaEgress(`http://127.0.0.1:${site.port}/__ip`, session.egress.port)).status).toBe(200);
  });
});
