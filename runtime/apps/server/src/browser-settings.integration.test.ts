// SPDX-License-Identifier: AGPL-3.0-only
// Réglages > Navigateur (tâche 4.7 ; cdc/sym-browser 04g §3) sur base réelle : le fournisseur que le worker publie (`local`,
// `sym-browser`, `cdp` et ses capacités côté navigateur, activation du CDP générique) est rendu en lecture seule à l'admin ;
// jamais à un membre ni à une clé d'API ; jamais une adresse ni un secret.
import { publishBrowserProvider } from '@runtime/db';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { withClient } from '../../../tests/helpers/pg.js';
import { createKey, createUser, runSetup, signIn, startTestServer, type TestServer, type TestUser } from '../../../tests/helpers/server.js';

let srv: TestServer;
let owner: TestUser;
let admin: TestUser;
let adminCookie: string;
let memberCookie: string;
const get = (cookie: string) => srv.app.inject({ method: 'GET', url: '/api/settings/browser', headers: { cookie } });
const none = { egressPolicy: false, launchArgs: false, freshContextPerRun: false, killBeforeDetach: false, sandboxProbe: false, engineUserAgent: false, privateLatency: false };

beforeAll(async () => {
  srv = await startTestServer('browser_settings');
  owner = await runSetup(srv);
  await signIn(srv, owner);
  admin = await createUser(srv, 'zz_test_browser_admin@example.test', 'admin');
  adminCookie = await signIn(srv, admin);
  memberCookie = await signIn(srv, await createUser(srv, 'zz_test_browser_member@example.test', 'member'));
}, 120_000);

afterAll(async () => {
  await srv?.close();
});

describe('cdp_requires_explicit_opt_in : écran Réglages > Navigateur (G5)', () => {
  test('aucun worker n’a publié : rien d’inventé (null)', async () => {
    const res = await get(adminCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ kind: null, capabilities: null, generic_cdp_enabled: null });
  });

  test('fournisseur cdp publié : genre, capacités absentes et activation lus par l’admin', async () => {
    await withClient(srv.db.url, (c) => publishBrowserProvider(c, { kind: 'cdp', capabilities: none, genericCdpEnabled: true }));
    const res = await get(adminCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ kind: 'cdp', capabilities: none, generic_cdp_enabled: true });
    expect(res.body).not.toMatch(/token|key|secret|ws:|http/i);
  });

  test('un membre reçoit 403, une clé d’API aussi (session d’interface seulement)', async () => {
    expect((await get(memberCookie)).statusCode).toBe(403);
    const key = await createKey(srv, adminCookie, admin, ['apis:read']);
    expect((await srv.app.inject({ method: 'GET', url: '/api/settings/browser', headers: { authorization: `Bearer ${key.key}` } })).statusCode).toBe(403);
  });
});
