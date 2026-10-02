// SPDX-License-Identifier: AGPL-3.0-only
// Runner sur base réelle (PostgreSQL 16, 17 ou 18 selon PG_VERSION) : verrou consultatif, aller-retour up, down, up,
// rejeu idempotent, garde-fous (migration modifiée, production, version de serveur).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { createTestDatabase, dataSnapshot, schemaSnapshot, withClient, type TestDatabase } from '../test/helpers/pg.js';
import { currentSchemaVersion, loadMigrations, migrateDown, migrateUp, MIGRATION_LOCK_KEY } from './migrate.js';
import { TABLES } from './index.js';

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

async function publicTables(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ t: string }>(
    "SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'symb_schema_migrations' ORDER BY 1",
  );
  return rows.map((r) => r.t);
}

describe(`migrations de SYM Browser sur PostgreSQL ${inject('pgVersion')}`, () => {
  test('verrou consultatif : deux runners attendent un tiers qui tient le verrou, une seule application', async () => {
    const db = await createTestDatabase('locked');
    const holder = new pg.Client({ connectionString: db.url });
    await holder.connect();
    let runs: Promise<{ applied: number[] }>[] = [];
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      const logs: string[][] = [[], []];
      runs = [0, 1].map((i) => migrateUp({ connectionString: db.url, log: (l) => logs[i]?.push(l) }));
      for (let i = 0; i < 100 && (await waitingAdvisoryLocks(holder)) < 2; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(await waitingAdvisoryLocks(holder)).toBe(2);
      expect(await publicTables(holder)).toEqual([]); // rien appliqué pendant l'attente
      await holder.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);

      const results = await Promise.all(runs);
      expect(results.map((r) => r.applied.length).sort()).toEqual([0, migrations.length]);
      const { rows } = await holder.query<{ n: number }>('SELECT count(*)::int AS n FROM symb_schema_migrations');
      expect(rows[0]?.n).toBe(migrations.length);
      expect(logs.flat().filter((l) => l.includes('attente du verrou'))).toHaveLength(2);
    } finally {
      await holder.end();
      await Promise.allSettled(runs);
      await db.drop();
    }
  });

  test('deux runners concurrents sans tiers : aucune erreur, chaque migration appliquée une fois', async () => {
    const db = await createTestDatabase('race');
    try {
      const results = await Promise.all([migrateUp({ connectionString: db.url }), migrateUp({ connectionString: db.url })]);
      expect(results.flatMap((r) => r.applied).sort((a, b) => a - b)).toEqual(migrations.map((m) => m.version));
    } finally {
      await db.drop();
    }
  });

  test('aller-retour : up, down, up donnent le même schéma ; down vide la base ; les neuf tables du modèle existent', async () => {
    const empty = await withClient(tdb.url, schemaSnapshot);
    const emptyData = await withClient(tdb.url, dataSnapshot);

    expect((await migrateUp({ connectionString: tdb.url })).applied).toEqual(migrations.map((m) => m.version));
    const afterUp = await withClient(tdb.url, async (c) => ({ schema: await schemaSnapshot(c), data: await dataSnapshot(c), tables: await publicTables(c) }));
    expect(afterUp.tables).toEqual([...TABLES].sort());
    expect(afterUp.schema.columns?.length).toBeGreaterThan(80);

    expect((await migrateDown({ connectionString: tdb.url, all: true })).reverted).toEqual(migrations.map((m) => m.version).reverse());
    expect(await withClient(tdb.url, schemaSnapshot)).toEqual(empty);
    expect(await withClient(tdb.url, dataSnapshot)).toEqual(emptyData);
    expect(await withClient(tdb.url, currentSchemaVersion)).toBe(0);

    await migrateUp({ connectionString: tdb.url });
    const afterReUp = await withClient(tdb.url, async (c) => ({ schema: await schemaSnapshot(c), data: await dataSnapshot(c), tables: await publicTables(c) }));
    expect(afterReUp).toEqual(afterUp);
  });

  test('aller-retour migration par migration : chaque down restitue exactement l’état précédent', async () => {
    const db = await createTestDatabase('stepwise');
    try {
      await migrateUp({ connectionString: db.url, migrations: [] });
      let previous = await withClient(db.url, async (c) => [await schemaSnapshot(c), await dataSnapshot(c)]);
      for (const m of migrations) {
        const upTo = migrations.filter((x) => x.version <= m.version);
        expect((await migrateUp({ connectionString: db.url, migrations: upTo })).applied).toEqual([m.version]);
        const afterUp = await withClient(db.url, async (c) => [await schemaSnapshot(c), await dataSnapshot(c)]);
        expect((await migrateDown({ connectionString: db.url, migrations: upTo, steps: 1 })).reverted).toEqual([m.version]);
        expect(await withClient(db.url, async (c) => [await schemaSnapshot(c), await dataSnapshot(c)])).toEqual(previous);
        await migrateUp({ connectionString: db.url, migrations: upTo });
        expect(await withClient(db.url, async (c) => [await schemaSnapshot(c), await dataSnapshot(c)])).toEqual(afterUp);
        previous = afterUp;
      }
    } finally {
      await db.drop();
    }
  });

  test('rejeu idempotent : migrate sur une base à jour ne change ni schéma ni données', async () => {
    await migrateUp({ connectionString: tdb.url });
    await withClient(tdb.url, (c) => c.query("INSERT INTO tenants (name) VALUES ('acme')"));
    const before = await withClient(tdb.url, async (c) => [await schemaSnapshot(c), await dataSnapshot(c)]);
    const logs: string[] = [];
    expect((await migrateUp({ connectionString: tdb.url, log: (l) => logs.push(l) })).applied).toEqual([]);
    expect(logs).toContain('migrate : schéma à jour');
    expect(await withClient(tdb.url, async (c) => [await schemaSnapshot(c), await dataSnapshot(c)])).toEqual(before);
  });

  test('migration modifiée après son application : refus', async () => {
    const tampered = migrations.map((m, i) => (i === 0 ? { ...m, checksum: 'x' } : m));
    await expect(migrateUp({ connectionString: tdb.url, migrations: tampered })).rejects.toThrow(/modifiée après son application/);
  });

  test('base plus récente que le code : refus', async () => {
    await expect(migrateUp({ connectionString: tdb.url, migrations: [] })).rejects.toThrow(/inconnue de ce code/);
  });

  test('migrate down refusé si NODE_ENV=production', async () => {
    await expect(migrateDown({ connectionString: tdb.url, env: { NODE_ENV: 'production' } })).rejects.toThrow(/refusé en production/);
    expect(await withClient(tdb.url, currentSchemaVersion)).toBe(migrations.length);
  });

  test('migration en échec : annulée en bloc, version inchangée, verrou libéré', async () => {
    const db = await createTestDatabase('failing');
    try {
      const broken = [...migrations, { version: migrations.length + 1, name: 'cassee', up: 'CREATE TABLE ok_avant (id int); SELECT 1/0;', down: 'SELECT 1;', checksum: 'c' }];
      await expect(migrateUp({ connectionString: db.url, migrations: broken })).rejects.toThrow(/échec de .*cassee.*annulée/);
      await withClient(db.url, async (c) => {
        expect(await currentSchemaVersion(c)).toBe(migrations.length);
        expect(await publicTables(c)).not.toContain('ok_avant');
        const { rows } = await c.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [MIGRATION_LOCK_KEY]);
        expect(rows[0]?.locked).toBe(true);
        await c.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      });
    } finally {
      await db.drop();
    }
  });
});
