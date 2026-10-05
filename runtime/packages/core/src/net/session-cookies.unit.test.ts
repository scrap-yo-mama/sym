// SPDX-License-Identifier: AGPL-3.0-only
// Cookies de session rejoués côté serveur (A2) : sélection RFC 6265 par URL, jamais hors du domaine de la session, jamais
// après une redirection hors domaine, `secure` jamais en http, valeurs au registre de masquage (INV5, INV8, INV10).
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { SiteCookie } from '../auth/extension.js';
import { secretValues } from '../crypto/index.js';
import { fixtureGuard } from '../../../../tests/helpers/fixture-net.ts';
import { guardedFetch } from './fetch.js';
import { cookieHeaderFor, createSessionCookies } from './session-cookies.js';

const c = (over: Partial<SiteCookie>): SiteCookie => ({ name: 'sid', value: 'zz_test_sid_value', domain: '.site-a.test', path: '/', secure: false, httpOnly: true, ...over });

describe('cookieHeaderFor', () => {
  test('domaine, sous-domaine, chemin, secure, expiration', () => {
    const cookies = [
      c({}),
      c({ name: 'host', value: 'zz_test_h', domain: 'www.site-a.test' }),
      c({ name: 'api', value: 'zz_test_api', path: '/api' }),
      c({ name: 'sec', value: 'zz_test_sec', secure: true }),
      c({ name: 'old', value: 'zz_test_old', expirationDate: 1 }),
    ];
    expect(cookieHeaderFor(cookies, new URL('https://www.site-a.test/api/x'), 'site-a.test')).toBe('api=zz_test_api; sid=zz_test_sid_value; host=zz_test_h; sec=zz_test_sec');
    // host-only : pas pour un autre sous-domaine ; chemin /api : pas pour /apix ; secure : pas en http.
    expect(cookieHeaderFor(cookies, new URL('http://m.site-a.test/apix'), 'site-a.test')).toBe('sid=zz_test_sid_value');
  });

  test('assert_session_never_cross_origin : hôte hors du domaine de la session, même avec un cookie au domaine large', () => {
    const cookies = [c({ domain: '.site-a.test' }), c({ name: 'wide', domain: '.test' })];
    expect(cookieHeaderFor(cookies, new URL('https://evil.test/'), 'site-a.test')).toBeNull();
    expect(cookieHeaderFor(cookies, new URL('https://site-a.test.evil.test/'), 'site-a.test')).toBeNull();
    expect(cookieHeaderFor(cookies, new URL('https://notsite-a.test/'), 'site-a.test')).toBeNull();
    // un cookie dont le domaine n'est pas celui de la session n'est jamais posé
    expect(cookieHeaderFor([c({ domain: '.other.test' })], new URL('https://site-a.test/'), 'site-a.test')).toBeNull();
  });

  test('valeur ou nom qui casserait l’en-tête : écarté', () => {
    expect(cookieHeaderFor([c({ value: 'a; b=c' }), c({ name: 'x y' })], new URL('https://site-a.test/'), 'site-a.test')).toBeNull();
  });
});

describe('createSessionCookies et guardedFetch (redirections)', () => {
  const seen: { host: string; cookie: string | undefined; path: string }[] = [];
  let port = 0;
  const server = createServer((req: IncomingMessage, res) => {
    const host = (req.headers.host ?? '').split(':')[0]!;
    seen.push({ host, cookie: req.headers.cookie, path: req.url ?? '' });
    if (req.url === '/to-other') {
      res.writeHead(302, { location: `http://zz-other.test:${port}/landing` }).end();
    } else if (req.url === '/to-sub') {
      res.writeHead(302, { location: `http://www.site-a.test:${port}/landing` }).end();
    } else if (req.url === '/back') {
      res.writeHead(302, { location: `http://site-a.test:${port}/after` }).end();
    } else res.writeHead(200).end('ok');
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const run = async (url: string, jar = createSessionCookies('site-a.test', [c({ value: 'zz_test_jar_value_1' })])) => {
    seen.length = 0;
    const guard = fixtureGuard(port, ['site-a.test', 'www.site-a.test', 'zz-other.test']);
    const response = await guardedFetch(url, { headers: { cookie: 'forged=1' } }, { guard, cookieFor: (u) => jar.headerFor(u) });
    await response.body?.cancel();
    return { jar, seen: [...seen] };
  };

  test('le Cookie part vers le domaine de la session (celui de l’appelant est écarté), pas vers un autre site', async () => {
    const { seen: s, jar } = await run(`http://site-a.test:${port}/x`);
    expect(s[0]!.cookie).toBe('sid=zz_test_jar_value_1');
    expect(jar.used()).toBe(true);
    expect(secretValues.redactText('x=zz_test_jar_value_1')).not.toContain('zz_test_jar_value_1');
  });

  test('défense en profondeur : aucune écriture (POST, PUT, corps) ne part avec le Cookie de la session', async () => {
    const jar = createSessionCookies('site-a.test', [c({ value: 'zz_test_jar_value_2' })]);
    const guard = fixtureGuard(port, ['site-a.test']);
    seen.length = 0;
    for (const init of [{ method: 'POST', body: 'a=1' }, { method: 'PUT' }, { method: 'GET', body: undefined }, { method: 'POST' }]) {
      const response = await guardedFetch(`http://site-a.test:${port}/w`, { ...init, headers: { cookie: 'forged=1' } }, { guard, cookieFor: (u) => jar.headerFor(u) });
      await response.body?.cancel();
    }
    expect(seen.map((r) => r.cookie)).toEqual([undefined, undefined, 'sid=zz_test_jar_value_2', undefined]);
  });

  test('redirection hors domaine : le Cookie ne suit pas ; vers un sous-domaine : recalculé', async () => {
    const out = await run(`http://site-a.test:${port}/to-other`);
    expect(out.seen.map((r) => [r.host, r.cookie])).toEqual([['site-a.test', 'sid=zz_test_jar_value_1'], ['zz-other.test', undefined]]);
    const sub = await run(`http://site-a.test:${port}/to-sub`);
    expect(sub.seen[1]).toMatchObject({ host: 'www.site-a.test', cookie: 'sid=zz_test_jar_value_1' });
  });

  test('départ hors domaine : aucun cookie, session non marquée utilisée', async () => {
    const { seen: s, jar } = await run(`http://zz-other.test:${port}/x`);
    expect(s[0]!.cookie).toBeUndefined();
    expect(jar.used()).toBe(false);
  });
});
