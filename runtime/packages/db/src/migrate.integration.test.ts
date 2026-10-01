// SPDX-License-Identifier: AGPL-3.0-only
// Protocole de 15 § 5 sur base réelle (matrice PG 16/17/18 via PG_VERSION) :
// verrou (assert_migrations_locked), aller-retour par migration, rejeu idempotent.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { createTestDatabase, dataSnapshot, schemaSnapshot, withClient, type TestDatabase } from '../../../tests/helpers/pg.js';
import { currentSchemaVersion, loadMigrations, migrateDown, migrateUp, MIGRATION_LOCK_KEY } from './migrate.js';

const migrations = loadMigrations();
let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createTestDatabase('migrate');
});
afterAll(async () => {
  await tdb.drop();
});

async function waitingAdvisoryLocks(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
  );
  return rows[0]?.n ?? 0;
}

describe(`migrations sur PostgreSQL ${inject('pgVersion')}`, () => {
  test('assert_migrations_locked : deux migrate simultanés, une seule application, l’autre attend', async () => {
    const db = await createTestDatabase('locked');
    const holder = new pg.Client({ connectionString: db.url });
    await holder.connect();
    let runs: Promise<{ applied: number[] }>[] = [];
    try {
      // Un tiers tient le verrou : les deux runners doivent attendre sans rien appliquer.
      await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      const logs: string[][] = [[], []];
      runs = [0, 1].map((i) => migrateUp({ connectionString: db.url, log: (l) => logs[i]?.push(l) }));
      for (let i = 0; i < 100 && (await waitingAdvisoryLocks(holder)) < 2; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(await waitingAdvisoryLocks(holder)).toBe(2);
      expect(await currentSchemaVersion(holder)).toBe(0);
      await holder.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);

      const results = await Promise.all(runs);
      const applied = results.map((r) => r.applied.length).sort();
      expect(applied).toEqual([0, migrations.length]);
      const { rows } = await holder.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations');
      expect(rows[0]?.n).toBe(migrations.length);
      expect(logs.flat().filter((l) => l.includes('attente du verrou'))).toHaveLength(2);
    } finally {
      await holder.end(); // libère le verrou si le test a échoué avant
      await Promise.allSettled(runs);
      await db.drop();
    }
  });

  test('deux migrate concurrents sans tiers : aucune erreur, chaque migration appliquée une fois', async () => {
    const db = await createTestDatabase('race');
    try {
      const results = await Promise.all([migrateUp({ connectionString: db.url }), migrateUp({ connectionString: db.url })]);
      expect(results.flatMap((r) => r.applied).sort((a, b) => a - b)).toEqual(migrations.map((m) => m.version));
    } finally {
      await db.drop();
    }
  });

  test('aller-retour par migration : up, down, up donnent le même schéma et les mêmes données', async () => {
    const schemas = [await withClient(tdb.url, schemaSnapshot)];
    const data = [await withClient(tdb.url, dataSnapshot)];
    for (const m of migrations) {
      const upTo = migrations.filter((x) => x.version <= m.version);
      expect((await migrateUp({ connectionString: tdb.url, migrations: upTo })).applied).toEqual([m.version]);
      const afterUp = await withClient(tdb.url, (c) => Promise.all([schemaSnapshot(c), dataSnapshot(c)]));

      expect((await migrateDown({ connectionString: tdb.url, migrations: upTo, steps: 1 })).reverted).toEqual([m.version]);
      expect(await withClient(tdb.url, schemaSnapshot)).toEqual(schemas.at(-1));
      expect(await withClient(tdb.url, dataSnapshot)).toEqual(data.at(-1));

      await migrateUp({ connectionString: tdb.url, migrations: upTo });
      const afterReUp = await withClient(tdb.url, (c) => Promise.all([schemaSnapshot(c), dataSnapshot(c)]));
      expect(afterReUp).toEqual(afterUp);
      schemas.push(afterUp[0]);
      data.push(afterUp[1]);
    }
    expect(schemas.at(-1)?.columns?.length).toBeGreaterThan(100);
  });

  test('rejeu idempotent : migrate sur base à jour ne change ni schéma ni données', async () => {
    await migrateUp({ connectionString: tdb.url });
    await withClient(tdb.url, async (c) => {
      const { rows } = await c.query<{ id: string }>("INSERT INTO users (email, role, status) VALUES ('a@example.test', 'owner', 'active') RETURNING id");
      await c.query("INSERT INTO apis (slug, owner_id) VALUES ('demo', $1)", [rows[0]?.id]);
    });
    const before = await withClient(tdb.url, (c) => Promise.all([schemaSnapshot(c), dataSnapshot(c)]));
    const logs: string[] = [];
    expect((await migrateUp({ connectionString: tdb.url, log: (l) => logs.push(l) })).applied).toEqual([]);
    expect(logs).toContain('migrate : schéma à jour');
    expect(await withClient(tdb.url, (c) => Promise.all([schemaSnapshot(c), dataSnapshot(c)]))).toEqual(before);
  });

  test('migration modifiée après application : refus', async () => {
    const tampered = migrations.map((m, i) => (i === 0 ? { ...m, checksum: 'x' } : m));
    await expect(migrateUp({ connectionString: tdb.url, migrations: tampered })).rejects.toThrow(/modifiée après son application/);
  });

  test('migrate down refusé si NODE_ENV=production', async () => {
    await expect(
      migrateDown({ connectionString: tdb.url, env: { NODE_ENV: 'production' } }),
    ).rejects.toThrow(/refusé en production/);
    expect(await withClient(tdb.url, currentSchemaVersion)).toBe(migrations.length);
  });
});
