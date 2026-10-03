// SPDX-License-Identifier: AGPL-3.0-only
// Interface `AuthApi` de la console (tâche 3.5 ; 03 § 7, 04d § 5.3 et D13). La même suite de conformité tourne contre :
//   1. l'implémentation simulée (`createMockAuthApi`), qui tient lieu de serveur tant que la tâche 2.1 n'est pas fusionnée ;
//   2. le client HTTP réel (`createHttpAuthApi`) branché sur le faux serveur, qui sert la simulation sur les routes prévues.
// Quand 2.1 sera là, la suite 2 tournera contre la vraie passerelle : la console n'aura rien à changer.
import { describe, expect, test } from 'vitest';
import { createHttpClient } from './client.js';
import { AUTH_ROUTES, createHttpAuthApi, type AuthApi } from './auth.js';
import { createFakeConsoleServer } from '../testing/fake-server.js';
import { createMockAuthApi, MOCK_TOTP_CODE, type MockAuthOptions } from '../testing/mock-auth.js';

const TOKEN = 'symb_boot_0123456789abcdef';
const EMAIL = 'admin@example.test';
const PASSWORD = 'douze-caracteres-au-moins';

type Factory = (options: MockAuthOptions) => AuthApi;

const factories: Record<string, Factory> = {
  'simulation (createMockAuthApi)': (options) => createMockAuthApi(options),
  'client HTTP sur le faux serveur (createHttpAuthApi)': (options) => {
    const server = createFakeConsoleServer(createMockAuthApi(options));
    return createHttpAuthApi(createHttpClient({ baseUrl: 'http://console.test', fetch: (url, init) => server(new Request(url, init)) }));
  },
};

for (const [name, make] of Object.entries(factories)) {
  describe(`AuthApi : ${name}`, () => {
    test('premier démarrage : mauvais jeton refusé, 0 compte créé ; bon jeton : admin créé, jeton consommé (D13)', async () => {
      const api = make({ bootstrapToken: TOKEN });
      expect(await api.status()).toEqual({ ok: true, status: 200, data: { initialized: false, admin: null, totpPending: false } });

      const wrong = await api.setup({ token: 'symb_boot_mauvais', email: EMAIL, password: PASSWORD });
      expect(wrong).toMatchObject({ ok: false, code: 'invalid_bootstrap_token' });
      expect((await api.status()).ok && (await api.status())).toMatchObject({ data: { initialized: false } });

      const right = await api.setup({ token: TOKEN, email: EMAIL, password: PASSWORD });
      expect(right).toMatchObject({ ok: true, data: { admin: { email: EMAIL } } });
      expect(await api.status()).toMatchObject({ ok: true, data: { initialized: true, admin: null } });

      // Jeton consommé : un second passage est refusé.
      expect(await api.setup({ token: TOKEN, email: 'autre@example.test', password: PASSWORD })).toMatchObject({ ok: false, code: 'already_initialized' });
    });

    test('premier démarrage : mot de passe de moins de 12 caractères ou e-mail invalide refusés, 0 compte créé', async () => {
      const api = make({ bootstrapToken: TOKEN });
      expect(await api.setup({ token: TOKEN, email: EMAIL, password: 'court' })).toMatchObject({ ok: false, code: 'weak_password' });
      expect(await api.setup({ token: TOKEN, email: 'pas-un-email', password: PASSWORD })).toMatchObject({ ok: false, code: 'invalid_email' });
      expect(await api.status()).toMatchObject({ data: { initialized: false } });
    });

    test('connexion : compte inconnu et mauvais mot de passe reçoivent le même code ; bon couple : connecté', async () => {
      const api = make({ bootstrapToken: TOKEN, admin: { email: EMAIL, password: PASSWORD } });
      expect(await api.login({ email: 'inconnu@example.test', password: PASSWORD })).toMatchObject({ ok: false, code: 'invalid_credentials' });
      expect(await api.login({ email: EMAIL, password: 'mauvais-mot-de-passe' })).toMatchObject({ ok: false, code: 'invalid_credentials' });
      expect(await api.login({ email: EMAIL, password: PASSWORD })).toMatchObject({ ok: true, data: { step: 'done', admin: { email: EMAIL } } });
      expect(await api.status()).toMatchObject({ data: { initialized: true, admin: { email: EMAIL } } });
      expect(await api.logout()).toMatchObject({ ok: true });
      expect(await api.status()).toMatchObject({ data: { admin: null } });
    });

    test('connexion avant le premier démarrage : `not_initialized`', async () => {
      const api = make({ bootstrapToken: TOKEN });
      expect(await api.login({ email: EMAIL, password: PASSWORD })).toMatchObject({ ok: false, code: 'not_initialized' });
    });

    test('2FA TOTP (option) : le mot de passe ouvre l’étape du code, le bon code connecte', async () => {
      const api = make({ bootstrapToken: TOKEN, admin: { email: EMAIL, password: PASSWORD, totp: true } });
      expect(await api.login({ email: EMAIL, password: PASSWORD })).toMatchObject({ ok: true, data: { step: 'totp' } });
      expect(await api.status()).toMatchObject({ data: { admin: null, totpPending: true } });
      expect(await api.verifyTotp({ code: '000000' })).toMatchObject({ ok: false, code: 'invalid_code' });
      expect(await api.verifyTotp({ code: MOCK_TOTP_CODE })).toMatchObject({ ok: true, data: { admin: { email: EMAIL } } });
      expect(await api.status()).toMatchObject({ data: { admin: { email: EMAIL }, totpPending: false } });
    });

    test('code TOTP sans connexion en attente : `no_pending_login`', async () => {
      const api = make({ bootstrapToken: TOKEN, admin: { email: EMAIL, password: PASSWORD, totp: true } });
      expect(await api.verifyTotp({ code: MOCK_TOTP_CODE })).toMatchObject({ ok: false, code: 'no_pending_login' });
    });

    test('5 échecs de suite : `rate_limited`, même avec le bon mot de passe', async () => {
      const api = make({ bootstrapToken: TOKEN, admin: { email: EMAIL, password: PASSWORD } });
      for (let i = 0; i < 5; i += 1) await api.login({ email: EMAIL, password: 'mauvais-mot-de-passe' });
      expect(await api.login({ email: EMAIL, password: PASSWORD })).toMatchObject({ ok: false, status: 429, code: 'rate_limited' });
    });
  });
}

describe('routes et statuts HTTP prévus pour la tâche 2.1', () => {
  test('routes de la console sous /v1/console, chemins absolus', () => {
    expect(AUTH_ROUTES).toEqual({
      status: '/v1/console/auth/status',
      login: '/v1/console/auth/login',
      totp: '/v1/console/auth/totp',
      logout: '/v1/console/auth/logout',
      setup: '/v1/console/setup',
    });
  });

  test('codes d’erreur portés par les statuts attendus', async () => {
    const server = createFakeConsoleServer(createMockAuthApi({ bootstrapToken: TOKEN }));
    const post = (path: string, body: unknown): Promise<Response> =>
      server(new Request(`http://console.test${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
    expect((await post(AUTH_ROUTES.setup, { token: 'x', email: EMAIL, password: PASSWORD })).status).toBe(401);
    expect((await post(AUTH_ROUTES.setup, { token: TOKEN, email: EMAIL, password: 'court' })).status).toBe(400);
    expect((await post(AUTH_ROUTES.login, { email: EMAIL, password: PASSWORD })).status).toBe(409);
    expect((await post(AUTH_ROUTES.setup, { token: TOKEN, email: EMAIL, password: PASSWORD })).status).toBe(201);
    expect((await post(AUTH_ROUTES.setup, { token: TOKEN, email: EMAIL, password: PASSWORD })).status).toBe(409);
    expect((await post(AUTH_ROUTES.login, { email: EMAIL, password: 'non' })).status).toBe(401);
    const unknown = await server(new Request('http://console.test/v1/console/inconnu'));
    expect(unknown.status).toBe(404);
  });
});
