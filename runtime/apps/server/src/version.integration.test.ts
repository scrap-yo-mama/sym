// SPDX-License-Identifier: AGPL-3.0-only
// Compatibilité des versions (tâche 4.9, 16 §3) : `GET /api/version` servi localement, appairage refusé sous
// `min_extension` avec un message qui nomme la version requise, sans consommer le code d'appairage.
import { randomBytes } from 'node:crypto';
import { generateMasterKey, MCP_SPEC_VERSION, MIN_EXTENSION_VERSION } from '@runtime/core';
import { expectedSchemaVersion, migrateUp } from '@runtime/db';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase } from '../../../tests/helpers/pg.js';
import { PUBLIC_URL, runSetup, serverEnv, sessionCookie, type TestUser } from '../../../tests/helpers/server.js';
import { prepareServer, type Started } from './start.js';

const MIN = '0.4.0';
let started: Started;
let drop: () => Promise<void>;
let owner: TestUser;
let cookie: string;

beforeAll(async () => {
  const db = await createTestDatabase('ver');
  drop = db.drop;
  await migrateUp({ connectionString: db.url });
  const bootstrapToken = randomBytes(32).toString('base64url');
  started = await prepareServer(serverEnv(db.url, generateMasterKey(), bootstrapToken, { RUNTIME_VERSION: '0.4.2' }), { minExtension: MIN });
  const srv = { app: started.app, bootstrapToken } as Parameters<typeof runSetup>[0];
  owner = await runSetup(srv);
  const res = await started.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: { origin: PUBLIC_URL }, payload: { email: owner.email, password: owner.password } });
  cookie = sessionCookie(res);
});
afterAll(async () => {
  await started.close();
  await drop();
});

async function pairingCode(): Promise<string> {
  const res = await started.app.inject({ method: 'POST', url: '/api/extension/pairing-codes', headers: { cookie, origin: PUBLIC_URL }, payload: { currentPassword: owner.password } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ code: string }>().code;
}

const pair = (code: string, deviceId: string, extensionVersion?: string) =>
  started.app.inject({ method: 'POST', url: '/api/extension/pair', payload: { code, deviceId, ...(extensionVersion === undefined ? {} : { extensionVersion }) } });

describe('GET /api/version', () => {
  test('{server, schema, min_extension, mcp_spec}, public, sans autre champ (aucune version de dépendance)', async () => {
    const res = await started.app.inject({ method: 'GET', url: '/api/version' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ server: '0.4.2', schema: expectedSchemaVersion(), min_extension: MIN, mcp_spec: MCP_SPEC_VERSION });
    expect(MIN_EXTENSION_VERSION).toBeDefined();
  });
});

describe('appairage et version minimale de l’extension', () => {
  test('extension sous min_extension : refus 426, le message nomme la version requise, le code reste utilisable', async () => {
    const code = await pairingCode();
    const refused = await pair(code, 'zz_test_dev_old_1', '0.3.9');
    expect(refused.statusCode).toBe(426);
    expect(refused.json()).toEqual({ error: { code: 'extension_outdated', message: expect.stringContaining(MIN) } });
    expect(refused.json<{ error: { message: string } }>().error.message).toContain('0.3.9');
    // Version illisible : refusée aussi.
    expect((await pair(code, 'zz_test_dev_old_2', 'dev-build')).statusCode).toBe(426);
    // Le refus n'a pas consommé le code : l'extension mise à jour s'appaire avec le même.
    const ok = await pair(code, 'zz_test_dev_new_1', MIN);
    expect(ok.statusCode, ok.body).toBe(201);
  });

  test('version absente alors que min_extension > 0.0.0 : refus 426 (sinon un client qui omet le champ contourne le refus)', async () => {
    const code = await pairingCode();
    const refused = await pair(code, 'zz_test_dev_nover_1');
    expect(refused.statusCode, refused.body).toBe(426);
    expect(refused.json()).toEqual({ error: { code: 'extension_outdated', message: expect.stringContaining(MIN) } });
    // Le code n'a pas été consommé.
    expect((await pair(code, 'zz_test_dev_nover_2', MIN)).statusCode).toBe(201);
  });

  test('version égale, supérieure ou pré-version supérieure : acceptée', async () => {
    for (const [i, version] of [MIN, '0.5.0', '1.0.0-beta.1'].entries()) {
      const res = await pair(await pairingCode(), `zz_test_dev_ok_${i}`, version);
      expect(res.statusCode, `${version}: ${res.body}`).toBe(201);
    }
  });

  test('un code invalide reste 400 même avec une version à jour', async () => {
    expect((await pair('ZZZZZ-ZZZZZ', 'zz_test_dev_bad_1', '0.9.0')).statusCode).toBe(400);
  });
});
