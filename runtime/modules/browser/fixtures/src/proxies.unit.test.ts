// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { getViaHttpProxy, getViaHttpConnect, getViaSocks5, socks5Handshake } from './client.ts';
import { PROXY_HTTP_CREDENTIALS, PROXY_SOCKS5_CREDENTIALS } from './config.ts';
import { startHttpProxy, type ProxyHandle } from './http-proxy.ts';
import { startSite, type SiteHandle } from './site.ts';
import { startSocks5Proxy } from './socks5-proxy.ts';

let site: SiteHandle;
let http: ProxyHandle;
let socks: ProxyHandle;
beforeAll(async () => {
  site = await startSite({ port: 0, host: '127.0.0.1' });
  http = await startHttpProxy({ port: 0, host: '127.0.0.1', credentials: PROXY_HTTP_CREDENTIALS });
  socks = await startSocks5Proxy({ port: 0, host: '127.0.0.1', credentials: PROXY_SOCKS5_CREDENTIALS });
});
afterAll(async () => {
  await Promise.all([site.close(), http.close(), socks.close()]);
});

const target = (): { host: string; port: number } => ({ host: '127.0.0.1', port: site.port });

describe('proxy HTTP avec identifiants', () => {
  test('sans identifiants ou avec un mauvais mot de passe : 407 et rien n’atteint le site', async () => {
    site.journal.reset();
    const none = await getViaHttpProxy({ port: http.port }, undefined, target(), '/__ip');
    expect(none.status).toBe(407);
    expect(none.headers['proxy-authenticate']).toContain('Basic');
    const bad = await getViaHttpProxy({ port: http.port }, { username: PROXY_HTTP_CREDENTIALS.username, password: 'faux' }, target(), '/__ip');
    expect(bad.status).toBe(407);
    expect(site.journal.entries()).toHaveLength(0);
    expect(http.journal.entries().map((e) => e.outcome)).toEqual(['auth_failed', 'auth_failed']);
  });

  test('requête absolue et tunnel CONNECT avec identifiants : le site répond, le journal du proxy garde cible et utilisateur', async () => {
    const viaForward = await getViaHttpProxy({ port: http.port }, PROXY_HTTP_CREDENTIALS, target(), '/__ip');
    expect(viaForward.status).toBe(200);
    expect(JSON.parse(viaForward.body)).toEqual({ ip: '127.0.0.1' });
    const viaConnect = await getViaHttpConnect({ port: http.port }, PROXY_HTTP_CREDENTIALS, target(), '/static/about.html');
    expect(viaConnect.status).toBe(200);
    expect(viaConnect.body).toContain('À propos');
    const ok = http.journal.entries().filter((e) => e.outcome === 'ok');
    expect(ok.map((e) => e.method)).toEqual(['GET', 'CONNECT']);
    expect(ok[1]).toMatchObject({ user: PROXY_HTTP_CREDENTIALS.username, target: `127.0.0.1:${site.port}`, clientIp: '127.0.0.1' });
    expect(JSON.stringify(http.journal.entries())).not.toContain(PROXY_HTTP_CREDENTIALS.password);
  });

  test('cible injoignable : 502', async () => {
    const res = await getViaHttpConnect({ port: http.port }, PROXY_HTTP_CREDENTIALS, { host: '127.0.0.1', port: 1 }, '/');
    expect(res.status).toBe(502);
  });
});

describe('proxy SOCKS5 avec identifiants', () => {
  test('méthode « sans authentification » refusée (0xFF), mauvais mot de passe refusé', async () => {
    expect(await socks5Handshake({ port: socks.port }, 'none')).toBe('no_acceptable_method');
    expect(await socks5Handshake({ port: socks.port }, { username: PROXY_SOCKS5_CREDENTIALS.username, password: 'faux' })).toBe('auth_failed');
    expect(socks.journal.entries().map((e) => e.outcome)).toEqual(['no_acceptable_method', 'auth_failed']);
  });

  test('CONNECT par adresse IPv4 et par nom : le site répond ; le mot de passe n’est jamais journalisé', async () => {
    site.journal.reset();
    const byIp = await getViaSocks5({ port: socks.port }, PROXY_SOCKS5_CREDENTIALS, target(), '/__ip');
    expect(byIp.status).toBe(200);
    expect(JSON.parse(byIp.body)).toEqual({ ip: '127.0.0.1' });
    const byName = await getViaSocks5({ port: socks.port }, PROXY_SOCKS5_CREDENTIALS, { host: 'localhost', port: site.port }, '/static/about.html');
    expect(byName.status).toBe(200);
    const ok = socks.journal.entries().filter((e) => e.outcome === 'ok');
    expect(ok).toHaveLength(2);
    expect(ok[1]).toMatchObject({ user: PROXY_SOCKS5_CREDENTIALS.username, target: `localhost:${site.port}` });
    expect(JSON.stringify(socks.journal.entries())).not.toContain(PROXY_SOCKS5_CREDENTIALS.password);
  });

  test('cible injoignable : réponse SOCKS5 échec (0x04 ou 0x05)', async () => {
    await expect(getViaSocks5({ port: socks.port }, PROXY_SOCKS5_CREDENTIALS, { host: '127.0.0.1', port: 1 }, '/')).rejects.toThrow(/socks5 reply 0x0[45]/);
  });
});
