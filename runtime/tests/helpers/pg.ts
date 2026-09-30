// Une base jetable par fichier de test d'intégration, dans le conteneur du globalSetup.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';

export type TestDatabase = { url: string; name: string; drop: () => Promise<void> };

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: inject('pgAdminUrl') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createTestDatabase(prefix = 't'): Promise<TestDatabase> {
  const name = `${prefix}_${randomBytes(5).toString('hex')}`;
  await admin((c) => c.query(`CREATE DATABASE ${name}`));
  const url = new URL(inject('pgAdminUrl'));
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    name,
    drop: () => admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)).then(() => undefined),
  };
}

/** Exécute `fn` avec un client connecté à `url`, fermé ensuite. */
export async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Empreinte du schéma public (tables, colonnes, contraintes, index, vues, fonctions, partitions), hors schema_migrations.
 * Sert au protocole aller-retour de 15 § 5.
 */
export async function schemaSnapshot(client: pg.Client): Promise<Record<string, string[]>> {
  const q = async (sql: string) => (await client.query<{ x: string }>(sql)).rows.map((r) => r.x);
  return {
    columns: await q(`
      SELECT c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
             || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
             || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '') AS x
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v') AND a.attnum > 0 AND NOT a.attisdropped
        AND c.relname <> 'schema_migrations'
      ORDER BY 1`),
    constraints: await q(`
      SELECT c.relname || '.' || k.conname || ' ' || pg_get_constraintdef(k.oid) AS x
      FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname <> 'schema_migrations' ORDER BY 1`),
    indexes: await q(`SELECT indexdef AS x FROM pg_indexes WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY 1`),
    views: await q(`SELECT viewname || ' ' || definition AS x FROM pg_views WHERE schemaname = 'public' ORDER BY 1`),
    functions: await q(`
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || md5(p.prosrc) AS x
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') -- hors extensions (citext)
      ORDER BY 1`),
    partitions: await q(`
      SELECT c.relname || ' ' || pg_get_expr(c.relpartbound, c.oid) AS x
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relispartition ORDER BY 1`),
  };
}

/**
 * Empreinte des données de toutes les tables du schéma public (hors schema_migrations). created_at et updated_at
 * sont exclus : une ligne de référence recréée par une migration (projet « default ») reçoit un nouvel horodatage.
 */
export async function dataSnapshot(client: pg.Client): Promise<Record<string, string>> {
  const { rows } = await client.query<{ t: string }>(`
    SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relname <> 'schema_migrations'
    ORDER BY 1`);
  const out: Record<string, string> = {};
  for (const { t } of rows) {
    const res = await client.query<{ h: string | null }>(
      `SELECT md5(string_agg(x::text, '|' ORDER BY x::text)) AS h FROM (SELECT to_jsonb(r) - 'created_at' - 'updated_at' AS x FROM ${t} r) s`,
    );
    out[t] = res.rows[0]?.h ?? 'vide';
  }
  return out;
}
