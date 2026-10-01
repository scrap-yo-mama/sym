// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.4 sur base réelle : les identifiants d'un proxy BYO viennent du dépôt de secrets (0.3a), chiffrés au repos,
// et arrivent au proxy de test avec les paramètres fournisseur ; aucun ne ressort en clair dans la base ni l'usage.
import { randomBytes } from 'node:crypto';
import { generateMasterKey, MasterKey, secretValues } from '@runtime/core';
import { buildNetworkRungs, createSsrfPolicy, loadProxyCredentials, openNetworkSession, parseNetworkPolicy, parseProxyDefinitions, SsrfGuard } from '@runtime/core/net';
import { keyCheck, migrateUp, secretStore } from '@runtime/db';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { startIpFixture, startTestProxy, type IpFixture, type TestProxy } from '../helpers/test-proxy.ts';

let tdb: TestDatabase;
let client: pg.Client;
let fixture: IpFixture;
let proxy: TestProxy;
const password = `zz_test_proxy_pw_${randomBytes(8).toString('hex')}`;

beforeAll(async () => {
  tdb = await createTestDatabase('proxy');
  await migrateUp({ connectionString: tdb.url });
  client = new pg.Client({ connectionString: tdb.url });
  await client.connect();
  const registry = new Map<number, string>();
  fixture = await startIpFixture(registry);
  proxy = await startTestProxy({ exitIp: '203.0.113.77', registry, password });
});

afterAll(async () => {
  await Promise.all([fixture.close(), proxy.close()]);
  await client.end();
  await tdb.drop();
  secretValues.clear();
});

test('identifiants lus dans le dépôt de secrets, chiffrés au repos, transmis au proxy avec les paramètres', async () => {
  const keyring = { current: MasterKey.parse(generateMasterKey()) };
  const store = secretStore(client, keyring, await keyCheck(client, keyring));
  const secretId = await store.put({ ownerId: null, kind: 'proxy', label: 'zz_test proxy dc', value: JSON.stringify({ username: 'zzacct', password }) });

  const { rows } = await client.query<{ ciphertext: Buffer }>('SELECT ciphertext FROM secrets WHERE id = $1', [secretId]);
  expect(rows[0]!.ciphertext.toString('latin1')).not.toContain(password);

  const proxies = parseProxyDefinitions([
    { id: 'zz_test_dc', type: 'dc', url: proxy.url, credentials_secret_id: secretId, username_template: '{username}[-country-{country}]', allow_private_address: true },
  ]);
  const [rung] = buildNetworkRungs(parseNetworkPolicy({ allow: ['dc_proxy'], dc_proxy_params: { country: 'fr' } }), proxies);
  const credentials = await loadProxyCredentials(store, proxies[0]!);
  const guard = new SsrfGuard({ policy: createSsrfPolicy({ testAllowPrivate: true }) });
  const session = openNetworkSession({ rung: rung!, guard, ...(credentials === undefined ? {} : { credentials }) });
  const body = (await (await session.fetch(`${fixture.origin}/ip`)).json()) as { ip: string };
  await session.close();

  expect(body.ip).toBe('203.0.113.77');
  expect(proxy.log[0]).toMatchObject({ username: 'zzacct-country-fr', password, params: { country: 'fr' } });
  expect(JSON.stringify({ credentials, usage: session.usage() })).not.toContain(password);
});
