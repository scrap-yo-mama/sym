// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.6 (04c § 2.1, § 2.4) : relais vers le proxy amont, contre les proxys de test de la tâche 0.5 lancés en local
// (HTTP avec identifiants Basic, SOCKS5 RFC 1928/1929) et un terminateur TLS pour le type `https`. Hôte du proxy résolu une
// fois et épinglé ; identifiants tenus par le nœud ; octets du tunnel comptés sur le fil (TLS et en-têtes compris).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect, createServer as createTcpServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Secret } from '@sym-browser/core';
import { PROXY_HTTP_CREDENTIALS, PROXY_SOCKS5_CREDENTIALS } from '../../../../../fixtures/src/config.ts';
import { startHttpProxy } from '../../../../../fixtures/src/http-proxy.ts';
import { startSite, type SiteHandle } from '../../../../../fixtures/src/site.ts';
import { startSocks5Proxy } from '../../../../../fixtures/src/socks5-proxy.ts';
import { createEgressGuard, EgressDeniedError } from '../index.js';
import { WIRE_SOCKET, UpstreamError, createUpstreamDialer, resolveUpstream, type ResolvedUpstream } from './index.js';

type ProxyHandle = Awaited<ReturnType<typeof startHttpProxy>>;

let site: SiteHandle;
let httpProxy: ProxyHandle;
let socksProxy: ProxyHandle;
let tlsDir: string;
let tlsCert: string;
let tlsProxy: TlsServer;
let tlsPort: number;

const guard = createEgressGuard({
  privateHosts: ['127.0.0.1', 'proxy.test'],
  resolver: async (host) => (host === 'proxy.test' ? [{ address: '127.0.0.1', family: 4 }] : Promise.reject(new Error('ENOTFOUND'))),
});

beforeAll(async () => {
  site = await startSite({ host: '127.0.0.1' });
  httpProxy = await startHttpProxy({ host: '127.0.0.1', credentials: PROXY_HTTP_CREDENTIALS });
  socksProxy = await startSocks5Proxy({ host: '127.0.0.1', credentials: PROXY_SOCKS5_CREDENTIALS });
  // Certificat jetable du proxy `https` (proxy.test), produit à chaque exécution : aucune clé versionnée.
  tlsDir = mkdtempSync(join(tmpdir(), 'symb-upstream-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=proxy.test',
    '-addext', 'subjectAltName=DNS:proxy.test', '-keyout', join(tlsDir, 'key.pem'), '-out', join(tlsDir, 'cert.pem')], { stdio: 'ignore' });
  tlsCert = readFileSync(join(tlsDir, 'cert.pem'), 'utf8');
  tlsProxy = createTlsServer({ key: readFileSync(join(tlsDir, 'key.pem')), cert: tlsCert }, (client) => {
    const inner = connect(httpProxy.port, '127.0.0.1');
    client.pipe(inner).pipe(client);
    client.on('error', () => inner.destroy());
    inner.on('error', () => client.destroy());
  });
  await new Promise<void>((resolve) => tlsProxy.listen(0, '127.0.0.1', () => resolve()));
  tlsPort = (tlsProxy.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => tlsProxy.close(() => resolve()));
  rmSync(tlsDir, { recursive: true, force: true });
  await socksProxy.close();
  await httpProxy.close();
  await site.close();
});

const creds = (c: { username: string; password: string }) => ({ username: c.username, password: new Secret(c.password) });

/** GET dans un tunnel déjà ouvert, réponse lue jusqu'à la fermeture. */
function getThrough(socket: Socket, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    socket.on('data', (part: Buffer) => parts.push(part));
    socket.once('close', () => {
      const text = Buffer.concat(parts).toString('utf8');
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? '0'), body: text.slice(text.indexOf('\r\n\r\n') + 4) });
    });
    socket.write(`GET ${path} HTTP/1.1\r\nHost: fixtures.local\r\nConnection: close\r\n\r\n`);
  });
}

async function upstreamOf(type: 'http' | 'https' | 'socks5', port: number, credentials?: { username: string; password: string }, host = '127.0.0.1'): Promise<ResolvedUpstream> {
  return resolveUpstream({ type, host, port, ...(credentials === undefined ? {} : creds(credentials)) }, guard);
}

describe('hôte du proxy amont : résolu une fois, adresse publique (ou SYMB_PRIVATE_HOSTS) exigée', () => {
  test('nom résolu et épinglé', async () => {
    expect(await resolveUpstream({ type: 'http', host: 'proxy.test', port: 3128 }, guard)).toMatchObject({ host: 'proxy.test', address: '127.0.0.1', port: 3128 });
  });

  test('proxy vers une adresse non publique hors SYMB_PRIVATE_HOSTS, ou introuvable : refusé', async () => {
    const strict = createEgressGuard({ resolver: async () => [{ address: '10.0.0.9', family: 4 }] });
    await expect(resolveUpstream({ type: 'socks5', host: 'interne.test', port: 1080 }, strict)).rejects.toBeInstanceOf(EgressDeniedError);
    await expect(resolveUpstream({ type: 'socks5', host: '169.254.169.254', port: 1080 }, guard)).rejects.toBeInstanceOf(EgressDeniedError);
    await expect(resolveUpstream({ type: 'http', host: 'absent.test', port: 3128 }, guard)).rejects.toMatchObject({ reason: 'unresolvable' });
  });

  test('mot de passe sans utilisateur, utilisateur avec « : » (Basic) ou de plus de 255 octets (RFC 1929) : refusés', async () => {
    await expect(resolveUpstream({ type: 'http', host: '127.0.0.1', port: 1, password: new Secret('x') }, guard)).rejects.toMatchObject({ field: 'egress.upstream.username' });
    await expect(resolveUpstream({ type: 'http', host: '127.0.0.1', port: 1, username: 'a:b', password: new Secret('x') }, guard)).rejects.toMatchObject({ field: 'egress.upstream.username' });
    await expect(resolveUpstream({ type: 'socks5', host: '127.0.0.1', port: 1, username: 'u', password: new Secret('p'.repeat(256)) }, guard)).rejects.toMatchObject({ field: 'egress.upstream.password' });
  });
});

describe('tunnels par le proxy amont', () => {
  test('http avec identifiants : CONNECT authentifié, page servie, le proxy journalise l’utilisateur (jamais le mot de passe)', async () => {
    const dial = createUpstreamDialer(await upstreamOf('http', httpProxy.port, PROXY_HTTP_CREDENTIALS));
    const socket = await dial({ host: '127.0.0.1', port: site.port });
    expect(await getThrough(socket, '/__ip')).toMatchObject({ status: 200 });
    const last = httpProxy.journal.entries().at(-1);
    expect(last).toMatchObject({ user: PROXY_HTTP_CREDENTIALS.username, method: 'CONNECT', outcome: 'ok' });
    expect(JSON.stringify(httpProxy.journal.entries())).not.toContain(PROXY_HTTP_CREDENTIALS.password);
  });

  test('http, mauvais mot de passe : upstream_auth_failed, aucune requête vers la cible', async () => {
    const before = site.journal.entries().length;
    const dial = createUpstreamDialer(await upstreamOf('http', httpProxy.port, { ...PROXY_HTTP_CREDENTIALS, password: 'zz_test_faux' }));
    const error = await dial({ host: '127.0.0.1', port: site.port }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ reason: 'upstream_auth_failed' });
    expect(String((error as Error).message)).not.toContain('zz_test_faux');
    expect(site.journal.entries().length).toBe(before);
  });

  test('socks5 authentifié (RFC 1929) : nom transmis tel quel (dnsViaProxy) ou adresse épinglée', async () => {
    const dial = createUpstreamDialer(await upstreamOf('socks5', socksProxy.port, PROXY_SOCKS5_CREDENTIALS));
    expect(await getThrough(await dial({ host: 'localhost', port: site.port }), '/__ip')).toMatchObject({ status: 200 });
    expect(socksProxy.journal.entries().at(-1)).toMatchObject({ user: PROXY_SOCKS5_CREDENTIALS.username, outcome: 'ok', target: `localhost:${site.port}` });
    expect(await getThrough(await dial({ host: 'fixtures.local', port: site.port, address: '127.0.0.1' }), '/__ip')).toMatchObject({ status: 200 });
    expect(socksProxy.journal.entries().at(-1)).toMatchObject({ target: `127.0.0.1:${site.port}` });
  });

  test('socks5, mauvais mot de passe : upstream_auth_failed', async () => {
    const dial = createUpstreamDialer(await upstreamOf('socks5', socksProxy.port, { ...PROXY_SOCKS5_CREDENTIALS, password: 'zz_test_faux' }));
    await expect(dial({ host: '127.0.0.1', port: site.port })).rejects.toMatchObject({ reason: 'upstream_auth_failed' });
  });

  test('socks5 exigeant des identifiants, aucun fourni : upstream_auth_failed', async () => {
    const dial = createUpstreamDialer(await upstreamOf('socks5', socksProxy.port));
    await expect(dial({ host: '127.0.0.1', port: site.port })).rejects.toMatchObject({ reason: 'upstream_auth_failed' });
  });

  test('https : TLS vers le proxy, certificat vérifié (nom du proxy), puis CONNECT authentifié', async () => {
    const upstream = await resolveUpstream({ type: 'https', host: 'proxy.test', port: tlsPort, ...creds(PROXY_HTTP_CREDENTIALS) }, guard);
    const dial = createUpstreamDialer(upstream, { ca: tlsCert });
    const socket = await dial({ host: '127.0.0.1', port: site.port });
    expect(await getThrough(socket, '/__ip')).toMatchObject({ status: 200 });
    // Le comptage de l'egress porte sur le fil : le socket TCP sous TLS.
    const wire = (socket as Socket & { [WIRE_SOCKET]?: Socket })[WIRE_SOCKET];
    expect(wire).toBeDefined();
    expect(wire?.bytesRead ?? 0).toBeGreaterThan(socket.bytesRead);
  });

  test('https, certificat non reconnu : tls_failed, sans repli en clair', async () => {
    const upstream = await resolveUpstream({ type: 'https', host: 'proxy.test', port: tlsPort, ...creds(PROXY_HTTP_CREDENTIALS) }, guard);
    await expect(createUpstreamDialer(upstream)({ host: '127.0.0.1', port: site.port })).rejects.toMatchObject({ reason: 'tls_failed' });
  });

  test('proxy injoignable : connect_failed ; muet : timeout borné', async () => {
    const closed = await upstreamOf('http', 1, PROXY_HTTP_CREDENTIALS);
    await expect(createUpstreamDialer(closed)({ host: '127.0.0.1', port: site.port })).rejects.toMatchObject({ reason: 'connect_failed' });
    const mute = createTcpServer(() => {});
    await new Promise<void>((resolve) => mute.listen(0, '127.0.0.1', () => resolve()));
    const port = (mute.address() as { port: number }).port;
    const started = Date.now();
    await expect(createUpstreamDialer(await upstreamOf('socks5', port), { connectTimeoutMs: 300 })({ host: '127.0.0.1', port: site.port })).rejects.toMatchObject({ reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2_000);
    mute.close();
  });

  test('le proxy refuse la cible (502) : upstream_refused', async () => {
    const dial = createUpstreamDialer(await upstreamOf('http', httpProxy.port, PROXY_HTTP_CREDENTIALS));
    await expect(dial({ host: '127.0.0.1', port: 1 })).rejects.toMatchObject({ reason: 'upstream_refused' });
  });

  test('aucun identifiant dans les erreurs, leur JSON ni leur inspection', async () => {
    const dial = createUpstreamDialer(await upstreamOf('socks5', socksProxy.port, { ...PROXY_SOCKS5_CREDENTIALS, password: 'zz_test_secret_unique' }));
    const error = await dial({ host: '127.0.0.1', port: site.port }).catch((e: unknown) => e);
    const { inspect } = await import('node:util');
    for (const text of [String(error), JSON.stringify(error), inspect(error, { depth: 5 })]) expect(text).not.toContain('zz_test_secret_unique');
  });
});
