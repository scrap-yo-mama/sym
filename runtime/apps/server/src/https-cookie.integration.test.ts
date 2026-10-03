// SPDX-License-Identifier: AGPL-3.0-only
// 08b § 2 (`assert_cookie_host_prefix`) : instance servie en HTTPS : le cookie de session porte `__Host-`, `Secure`,
// `HttpOnly`, `SameSite=Lax`, `Path=/` et aucun `Domain`, et l'en-tête HSTS est présent sur la console comme sur l'API.
// (L'instance de test n'écoute pas : `inject` ; le TLS est simulé par la seule PUBLIC_URL, comme derrière un proxy.)
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createUser, nextTestIp, runSetup, startTestServer, type TestServer } from '../../../tests/helpers/server.js';

const HTTPS_URL = 'https://runtime.zz-test.example';
let srv: TestServer;

beforeAll(async () => {
  srv = await startTestServer('https_cookie', { PUBLIC_URL: HTTPS_URL });
  await runSetup(srv);
});
afterAll(async () => {
  await srv.close();
});

describe('assert_cookie_host_prefix : cookie de session et HSTS en HTTPS', () => {
  test('connexion : __Host-sy.session, Secure, HttpOnly, SameSite=Lax, Path=/, sans Domain ; HSTS présent', async () => {
    const user = await createUser(srv, 'zz_test_https_cookie@example.test');
    const res = await srv.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      remoteAddress: nextTestIp(),
      headers: { origin: HTTPS_URL },
      payload: { email: user.email, password: user.password },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = [res.headers['set-cookie']].flat().filter((c): c is string => typeof c === 'string');
    const session = setCookie.find((c) => c.includes('sy.session='));
    expect(session, setCookie.join(' | ')).toBeDefined();
    expect(session!.startsWith('__Host-sy.session=')).toBe(true);
    const attrs = session!.split(';').map((a) => a.trim().toLowerCase());
    expect(attrs).toContain('secure');
    expect(attrs).toContain('httponly');
    expect(attrs).toContain('samesite=lax');
    expect(attrs).toContain('path=/');
    expect(attrs.some((a) => a.startsWith('domain='))).toBe(false);
    for (const url of ['/', '/api/inconnu']) {
      const page = await srv.app.inject({ method: 'GET', url });
      expect(page.headers['strict-transport-security'], url).toBe('max-age=31536000; includeSubDomains');
    }
  });
});
