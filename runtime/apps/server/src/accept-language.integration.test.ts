// SPDX-License-Identifier: AGPL-3.0-only
// assert_accept_language_not_logged (tâche 3.20, 21b M8, 21 § 3 : « l'en-tête brut n'est jamais journalisé, vecteur d'empreinte »)
// et fuseau de compte absent des journaux (17 § 6) : un serveur réel dont le journal est capté, des requêtes qui portent un
// `Accept-Language` reconnaissable (valide, invalide, géant) et un PATCH du fuseau ; aucune ligne ne contient ni l'en-tête
// brut, ni ses poids, ni le fuseau.
import { createLogger } from '@runtime/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createUser, PUBLIC_URL, signIn, startTestServer, type TestServer, type TestUser } from '../../../tests/helpers/server.js';

let srv: TestServer;
let user: TestUser;
let cookie: string;
const lines: string[] = [];

beforeAll(async () => {
  const logger = createLogger({ name: 'server', level: 'trace', destination: { write: (chunk: string) => void lines.push(chunk) } });
  srv = await startTestServer('al_log', {}, { loggerInstance: logger as never });
  const owner = (await srv.app.inject({ method: 'POST', url: '/api/setup', payload: { token: srv.bootstrapToken, email: 'zz_test_al@example.test', password: `zz_test_${Math.random().toString(36).slice(2)}_Aa1!xyz` } })).json<{ userId: string }>();
  expect(owner.userId).toBeTruthy();
  user = await createUser(srv, 'zz_test_al_member@example.test');
  cookie = await signIn(srv, user);
}, 120_000);
afterAll(async () => {
  await srv.close();
});

describe('assert_accept_language_not_logged', () => {
  const SENTINEL = 'zz-sentinelle-AL';
  const HEADERS = [`fr-FR,fr;q=0.9,${SENTINEL};q=0.8`, `${SENTINEL}`, `${SENTINEL},`.repeat(400), '*;q=0.1'];

  test('aucune ligne de journal ne contient l’en-tête brut, ses poids ni sa valeur, qu’il soit valide, invalide ou géant', async () => {
    lines.length = 0;
    for (const header of HEADERS) {
      await srv.app.inject({ method: 'GET', url: '/api/me', headers: { 'accept-language': header } });
      await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie, 'accept-language': header } });
      await srv.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: { origin: PUBLIC_URL, 'accept-language': header }, payload: { email: user.email, password: 'mauvais' } });
      await srv.app.inject({ method: 'GET', url: '/api/inexistante', headers: { 'accept-language': header } });
    }
    expect(lines.length, 'le journal est bien capté').toBeGreaterThan(0);
    const text = lines.join('\n');
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toMatch(/accept-language/i);
    expect(text).not.toContain('q=0.9');
  });

  test('le fuseau d’un compte n’apparaît dans aucune ligne de journal', async () => {
    lines.length = 0;
    const res = await srv.app.inject({ method: 'PATCH', url: '/api/me', headers: { cookie, origin: PUBLIC_URL }, payload: { timezone: 'America/Argentina/Buenos_Aires', locale: 'fr' } });
    expect(res.statusCode, res.body).toBe(200);
    await srv.app.inject({ method: 'PATCH', url: '/api/me', headers: { cookie, origin: PUBLIC_URL }, payload: { timezone: 'Pas/UnFuseau' } });
    const text = lines.join('\n');
    expect(text).not.toContain('Buenos_Aires');
    expect(text).not.toContain('Pas/UnFuseau');
  });
});
