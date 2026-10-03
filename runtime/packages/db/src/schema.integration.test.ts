// SPDX-License-Identifier: AGPL-3.0-only
// Concordance schéma Drizzle ↔ base migrée (colonnes, types, nullabilité, ensemble des tables),
// owner_id NOT NULL indexé sur les tables métier, contraintes structurelles (INV5, INV11, 13 § 2 et § 8).
import { eq, getTableName, is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { migrateUp } from './migrate.js';
import * as schema from './schema.js';

let tdb: TestDatabase;
let client: pg.Client;

beforeAll(async () => {
  tdb = await createTestDatabase('schema');
  await migrateUp({ connectionString: tdb.url });
  client = new pg.Client({ connectionString: tdb.url });
  await client.connect();
});
afterAll(async () => {
  await client.end();
  await tdb.drop();
});

const tables = Object.values(schema as Record<string, unknown>).filter((v): v is PgTable => is(v, PgTable));
const norm = (type: string) => type.replace(/,\s+/g, ',');

/** Tables métier : owner_id + project_id obligatoires (03 § Schéma). secrets : owner_id NULL = secret d'instance. */
const BUSINESS_TABLES = [
  'apis', 'strategy_versions', 'runs', 'run_attempts', 'run_logs', 'run_artifacts', 'investigation_events',
  'status_events', 'datasets', 'dataset_items', 'dedup_keys', 'schedules', 'site_sessions', 'tunnels', 'tunnel_jobs',
  'webhook_subscriptions', 'webhook_deliveries', 'run_rejected_items', 'run_profiles', 'strategy_version_memory_refs',
];

async function expectRejected(sql: string, params: unknown[] = []): Promise<void> {
  await client.query('SAVEPOINT s');
  await expect(client.query(sql, params)).rejects.toThrow();
  await client.query('ROLLBACK TO SAVEPOINT s');
}

describe(`schéma sur PostgreSQL ${inject('pgVersion')}`, () => {
  test('mêmes tables en base et dans le schéma Drizzle', async () => {
    const { rows } = await client.query<{ t: string }>(`
      SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relname <> 'schema_migrations'`);
    expect(rows.map((r) => r.t).sort()).toEqual(tables.map((t) => getTableName(t)).sort());
  });

  test.each(tables.map((t) => [getTableName(t), t] as const))('%s : colonnes, types et nullabilité concordent', async (name, table) => {
    const { rows } = await client.query<{ col: string; type: string; notnull: boolean }>(
      `SELECT a.attname AS col, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull
       FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attname`,
      [`public.${name}`],
    );
    const expected = getTableConfig(table)
      .columns.map((c) => ({ col: c.name, type: norm(c.getSQLType()), notnull: c.notNull || c.primary }))
      .sort((a, b) => a.col.localeCompare(b.col));
    // Les clés primaires composées rendent leurs colonnes NOT NULL : Drizzle les déclare déjà notNull.
    expect(rows.map((r) => ({ ...r, type: norm(r.type) }))).toEqual(expected);
  });

  test('tables métier : owner_id NOT NULL et indexé, project_id NOT NULL', async () => {
    for (const t of BUSINESS_TABLES) {
      const { rows } = await client.query<{ col: string; notnull: boolean }>(
        `SELECT attname AS col, attnotnull AS notnull FROM pg_attribute
         WHERE attrelid = $1::regclass AND attname IN ('owner_id', 'project_id') ORDER BY attname`,
        [`public.${t}`],
      );
      expect(rows, t).toEqual([
        { col: 'owner_id', notnull: true },
        { col: 'project_id', notnull: true },
      ]);
      const idx = await client.query(
        `SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
         WHERE i.indrelid = $1::regclass AND a.attname = 'owner_id'`,
        [`public.${t}`],
      );
      expect(idx.rowCount, `${t} : index sur owner_id`).toBeGreaterThan(0);
    }
  });

  test('Drizzle lit et écrit sur la base migrée', async () => {
    const db = drizzle({ client, schema });
    const [owner] = await db.insert(schema.users).values({ email: 'Owner@Example.test', role: 'owner', status: 'active' }).returning();
    const [api] = await db.insert(schema.apis).values({ slug: 'drizzle-demo', ownerId: owner!.id }).returning();
    expect(api?.projectId).toBe(schema.DEFAULT_PROJECT_ID);
    expect(api?.accessPolicy).toEqual(schema.DEFAULT_ACCESS_POLICY);
    // citext : e-mail insensible à la casse.
    const found = await db.select().from(schema.users).where(eq(schema.users.email, 'owner@example.test'));
    expect(found).toHaveLength(1);
  });

  test('contraintes structurelles refusées en base', async () => {
    await client.query('BEGIN');
    try {
      const { rows } = await client.query<{ id: string }>("SELECT id FROM users WHERE role = 'owner'");
      const ownerId = rows[0]?.id;
      // Un seul owner.
      await expectRejected("INSERT INTO users (email, role) VALUES ('second@example.test', 'owner')");
      // INV11 : robots n'a qu'une valeur.
      await expectRejected(`INSERT INTO apis (slug, owner_id, access_policy) VALUES ('x', $1, '{"robots": "ignore"}')`, [ownerId]);
      // API à session : privée seulement.
      await expectRejected("INSERT INTO apis (slug, owner_id, requires_session, visibility) VALUES ('y', $1, true, 'instance')", [ownerId]);
      // Scope jamais accordable.
      await expectRejected(
        "INSERT INTO api_keys (user_id, label, prefix, key_hash, scopes, expires_at) VALUES ($1, 'k', 'sy_live_x', 'h', '{users:invite}', now() + interval '90 days')",
        [ownerId],
      );
      // INV5 : pas de cookie stocké sans server_use_allowed.
      await expectRejected("INSERT INTO site_sessions (owner_id, domain, ciphertext) VALUES ($1, 'example.com', '\\x00')", [ownerId]);
      // failure_class : liste fermée + llm_*.
      const api = await client.query<{ id: string }>("INSERT INTO apis (slug, owner_id) VALUES ('fc', $1) RETURNING id", [ownerId]);
      const run = "INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, failure_class) VALUES ($1, $2, $2, 'rest', $3)";
      await client.query(run, [api.rows[0]?.id, ownerId, 'llm_timeout']);
      await expectRejected(run, [api.rows[0]?.id, ownerId, 'schema_mismatch']);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
