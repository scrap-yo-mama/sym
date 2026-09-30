// Partitions mensuelles de dataset_items : création (mois courant et suivant, idempotente) et purge (DETACH + DROP).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { migrateUp } from './migrate.js';
import { dropDatasetItemsPartition, ensureDatasetItemsPartitions, listDatasetItemsPartitions } from './partitions.js';

let tdb: TestDatabase;
let client: pg.Client;

const monthName = (d: Date) => `dataset_items_p${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

beforeAll(async () => {
  tdb = await createTestDatabase('partitions');
  await migrateUp({ connectionString: tdb.url });
  client = new pg.Client({ connectionString: tdb.url });
  await client.connect();
});
afterAll(async () => {
  await client.end();
  await tdb.drop();
});

describe(`partitions sur PostgreSQL ${inject('pgVersion')}`, () => {
  test('la migration crée les partitions du mois courant et du suivant', async () => {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const names = (await listDatasetItemsPartitions(client)).map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining([monthName(now), monthName(next)]));
    expect(await ensureDatasetItemsPartitions(client)).toEqual([]);
  });

  test('bornes exactes en UTC, quel que soit le fuseau de la session', async () => {
    await client.query("SET TimeZone = 'Europe/Paris'");
    try {
      expect(await ensureDatasetItemsPartitions(client, new Date('2021-03-15T12:00:00Z'), 1)).toEqual(['dataset_items_p202103']);
      const p = (await listDatasetItemsPartitions(client)).find((x) => x.name === 'dataset_items_p202103');
      await client.query("SET TimeZone = 'UTC'");
      const { rows } = await client.query<{ b: string }>(
        "SELECT pg_get_expr(relpartbound, oid) AS b FROM pg_class WHERE relname = 'dataset_items_p202103'",
      );
      expect(p).toBeDefined();
      expect(rows[0]?.b).toBe("FOR VALUES FROM ('2021-03-01 00:00:00+00') TO ('2021-04-01 00:00:00+00')");
    } finally {
      await client.query('RESET TimeZone');
    }
  });

  test('création puis purge d’un mois : les items partent avec la partition', async () => {
    const { rows: users } = await client.query<{ id: string }>("INSERT INTO users (email) VALUES ('p@example.test') RETURNING id");
    const ownerId = users[0]?.id;
    const { rows: apis } = await client.query<{ id: string }>("INSERT INTO apis (slug, owner_id) VALUES ('p', $1) RETURNING id", [ownerId]);
    const { rows: ds } = await client.query<{ id: string }>(
      'INSERT INTO datasets (api_id, owner_id) VALUES ($1, $2) RETURNING id',
      [apis[0]?.id, ownerId],
    );
    const insert = (at: string, seq: number) =>
      client.query(
        "INSERT INTO dataset_items (created_at, dataset_id, seq, owner_id, item, size_bytes) VALUES ($1, $2, $3, $4, '{\"a\":1}', 7)",
        [at, ds[0]?.id, seq, ownerId],
      );

    // Aucune partition par défaut : un mois non créé refuse l'écriture.
    await expect(insert('2020-01-10T00:00:00Z', 1)).rejects.toThrow(/no partition/);
    expect(await ensureDatasetItemsPartitions(client, new Date('2020-01-31T23:59:59Z'), 2)).toEqual([
      'dataset_items_p202001',
      'dataset_items_p202002',
    ]);
    await insert('2020-01-10T00:00:00Z', 1);
    await insert('2020-01-31T23:59:59Z', 2);
    await insert('2020-02-01T00:00:00Z', 3);
    const count = async () => (await client.query<{ n: number }>('SELECT count(*)::int AS n FROM dataset_items')).rows[0]?.n;
    expect(await count()).toBe(3);

    await dropDatasetItemsPartition(client, 'dataset_items_p202001');
    expect(await count()).toBe(1);
    const names = (await listDatasetItemsPartitions(client)).map((p) => p.name);
    expect(names).not.toContain('dataset_items_p202001');
    expect(names).toContain('dataset_items_p202002');
    await expect(dropDatasetItemsPartition(client, 'dataset_items; DROP TABLE users')).rejects.toThrow(/partition invalide/);
  });
});
