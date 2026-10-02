// SPDX-License-Identifier: AGPL-3.0-only
// Clés d'API en base (cdc/sym-browser 03 § 5, 04 § 1, tâche 2.1) sur PostgreSQL migré : seule l'empreinte argon2id est
// stockée, recherche par préfixe affiché, révocation sans suppression, last_used_at, première clé au démarrage.
// assert_access_authenticated (BINV7, partie REST) de bout en bout : authentificateur de @sym-browser/core sur ce magasin.
import { ApiKeyAuthenticator, authorizeRequest, bootstrapApiKeyRecord, generateApiKey, newApiKey } from '@sym-browser/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/helpers/pg.js';
import { ensureFirstApiKey, insertApiKey, listApiKeys, pgApiKeyStore, revokeApiKey } from './api-keys.js';
import { migrateUp } from './migrate.js';

let tdb: TestDatabase;
let pool: pg.Pool;

beforeAll(async () => {
  tdb = await createTestDatabase('keys');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 6 });
});
afterAll(async () => {
  await pool.end();
  await tdb.drop();
});

const tenant = async (name: string): Promise<string> =>
  (await pool.query<{ id: string }>('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [name])).rows[0]!.id;

async function createKey(tenantId: string, scopes: Array<'sessions:write' | 'sessions:read' | 'profiles:write' | 'admin'>, expiresAt: Date | null = null) {
  const created = await newApiKey({ scopes, ...(expiresAt ? { expiresAt } : {}) });
  const { id } = await insertApiKey(pool, { tenantId, prefix: created.prefix, keyHash: created.keyHash, scopes: created.scopes, expiresAt: created.expiresAt });
  return { id, key: created.key.reveal(), prefix: created.prefix };
}

describe('magasin des clés (PostgreSQL)', () => {
  test('seule l’empreinte est stockée : aucune colonne ne contient la clé ni son secret', async () => {
    const t = await tenant('stockage');
    const { id, key } = await createKey(t, ['sessions:read']);
    const { rows } = await pool.query('SELECT to_jsonb(k)::text AS row FROM api_keys k WHERE id = $1', [id]);
    const row = rows[0].row as string;
    expect(row).not.toContain(key);
    expect(row).not.toContain(key.split('_').at(-1)!.slice(0, 16));
    expect(row).toMatch(/\$argon2id\$v=19\$/);
  });

  test('findByPrefix : ligne complète ; préfixe inconnu : null', async () => {
    const t = await tenant('recherche');
    const { id, prefix } = await createKey(t, ['sessions:write', 'sessions:read']);
    const store = pgApiKeyStore(pool);
    expect(await store.findByPrefix(prefix)).toMatchObject({ id, tenantId: t, scopes: ['sessions:write', 'sessions:read'], expiresAt: null, revokedAt: null, lastUsedAt: null });
    expect(await store.findByPrefix(generateApiKey().prefix)).toBeNull();
  });

  test('listApiKeys : préfixe, scopes, dates, jamais l’empreinte ; limité au client', async () => {
    const a = await tenant('liste-a');
    const b = await tenant('liste-b');
    const { prefix } = await createKey(a, ['admin']);
    await createKey(b, ['admin']);
    const list = await listApiKeys(pool, a);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ prefix, scopes: ['admin'], revokedAt: null });
    expect(JSON.stringify(list)).not.toMatch(/argon2/);
  });

  test('revokeApiKey : la ligne reste (référencée par le comptage), idempotente, jamais sur la clé d’un autre client', async () => {
    const a = await tenant('revoke-a');
    const b = await tenant('revoke-b');
    const { id } = await createKey(a, ['sessions:read']);
    expect(await revokeApiKey(pool, { tenantId: b, id })).toBe(false);
    expect(await revokeApiKey(pool, { tenantId: a, id })).toBe(true);
    const first = (await pool.query('SELECT revoked_at FROM api_keys WHERE id = $1', [id])).rows[0].revoked_at as Date;
    expect(first).toBeInstanceOf(Date);
    expect(await revokeApiKey(pool, { tenantId: a, id })).toBe(true);
    expect((await pool.query('SELECT revoked_at FROM api_keys WHERE id = $1', [id])).rows[0].revoked_at).toEqual(first);
  });

  test('touch : last_used_at avance, ne recule jamais', async () => {
    const t = await tenant('touch');
    const { id } = await createKey(t, ['sessions:read']);
    const store = pgApiKeyStore(pool);
    const later = new Date('2030-01-01T00:00:00Z');
    await store.touch(id, later);
    await store.touch(id, new Date('2029-01-01T00:00:00Z'));
    expect((await pool.query('SELECT last_used_at FROM api_keys WHERE id = $1', [id])).rows[0].last_used_at).toEqual(later);
  });

  test('scope hors liste refusé par la base elle-même (CHECK)', async () => {
    const t = await tenant('scope-ferme');
    const created = await newApiKey({ scopes: ['sessions:read'] });
    await expect(insertApiKey(pool, { tenantId: t, prefix: created.prefix, keyHash: created.keyHash, scopes: ['root' as never], expiresAt: null })).rejects.toMatchObject({ code: '23514' });
  });
});

describe('assert_access_authenticated (BINV7) : REST de bout en bout sur PostgreSQL', () => {
  test('clé valide : principal et last_used_at écrit ; expirée, révoquée, inconnue : 401 ; scope manquant : 403', async () => {
    const t = await tenant('e2e');
    const auth = new ApiKeyAuthenticator(pgApiKeyStore(pool));
    const valid = await createKey(t, ['sessions:read']);
    const expired = await createKey(t, ['sessions:read'], new Date(Date.now() + 1500));
    const revoked = await createKey(t, ['sessions:read']);
    await revokeApiKey(pool, { tenantId: t, id: revoked.id });

    expect(await authorizeRequest(auth, { authorization: `Bearer ${valid.key}` }, 'sessions:read')).toEqual({
      ok: true, principal: { tenantId: t, apiKeyId: valid.id, scopes: ['sessions:read'] },
    });
    expect((await pool.query('SELECT last_used_at FROM api_keys WHERE id = $1', [valid.id])).rows[0].last_used_at).toBeInstanceOf(Date);
    expect(await authorizeRequest(auth, { authorization: `Bearer ${valid.key}` }, 'sessions:write')).toMatchObject({ ok: false, status: 403, requiredScope: 'sessions:write' });
    expect(await authorizeRequest(auth, { authorization: `Bearer ${revoked.key}` }, 'sessions:read')).toMatchObject({ ok: false, status: 401, reason: 'revoked' });
    expect(await authorizeRequest(auth, { authorization: `Bearer ${generateApiKey().key.reveal()}` }, 'sessions:read')).toMatchObject({ ok: false, status: 401, reason: 'unknown' });

    expect(await authorizeRequest(auth, { authorization: `Bearer ${expired.key}` }, 'sessions:read')).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(await authorizeRequest(auth, { authorization: `Bearer ${expired.key}` }, 'sessions:read')).toMatchObject({ ok: false, status: 401, code: 'unauthorized', reason: 'expired' });
  });
});

describe('première clé d’API (SYMB_BOOTSTRAP_API_KEY)', () => {
  test('table vide : client sym et clé créés une fois, même sous démarrages concurrents ; la clé authentifie', async () => {
    const fresh = await createTestDatabase('boot');
    await migrateUp({ connectionString: fresh.url });
    const bootPool = new pg.Pool({ connectionString: fresh.url, max: 8 });
    try {
      const { key } = generateApiKey();
      const record = await bootstrapApiKeyRecord(key);
      const results = await Promise.all(Array.from({ length: 6 }, () => ensureFirstApiKey(bootPool, record)));
      expect(results.filter((r) => r === 'created')).toHaveLength(1);
      expect(results.filter((r) => r === 'skipped')).toHaveLength(5);
      const { rows } = await bootPool.query('SELECT t.name, k.scopes FROM api_keys k JOIN tenants t ON t.id = k.tenant_id');
      expect(rows).toEqual([{ name: 'sym', scopes: ['sessions:write', 'sessions:read'] }]);
      const principal = await new ApiKeyAuthenticator(pgApiKeyStore(bootPool)).authenticate(key.reveal());
      expect(principal?.scopes).toEqual(['sessions:write', 'sessions:read']);
      // Une autre valeur au redémarrage : rien n'est ajouté (la table n'est plus vide).
      expect(await ensureFirstApiKey(bootPool, await bootstrapApiKeyRecord(generateApiKey().key))).toBe('skipped');
    } finally {
      await bootPool.end();
      await fresh.drop();
    }
  });
});
