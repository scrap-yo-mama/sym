// SPDX-License-Identifier: AGPL-3.0-only
// Une base jetable par fichier de test d'intégration, dans le conteneur du globalSetup, et empreintes du schéma et des
// données pour le protocole aller-retour.
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

/** Supprime la base une fois ses sessions parties d'elles-mêmes ; une session fuitée fait échouer le test au lieu d'être tuée. */
async function dropWhenIdle(name: string): Promise<void> {
  await admin(async (c) => {
    const deadline = Date.now() + 10_000;
    const sessions = () =>
      c.query<{ pid: number; application_name: string }>(
        'SELECT pid, application_name FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [name],
      );
    let { rows } = await sessions();
    while (rows.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      ({ rows } = await sessions());
    }
    if (rows.length > 0) {
      throw new Error(`base ${name} : ${rows.length} session(s) encore ouverte(s), connexion fuitée : ${rows.map((r) => `pid ${r.pid} (${r.application_name || 'sans nom'})`).join(', ')}`);
    }
    await c.query(`DROP DATABASE IF EXISTS ${name}`);
  });
}

export async function createTestDatabase(prefix = 't'): Promise<TestDatabase> {
  const name = `${prefix}_${randomBytes(5).toString('hex')}`;
  await admin((c) => c.query(`CREATE DATABASE ${name}`));
  const url = new URL(inject('pgAdminUrl'));
  url.pathname = `/${name}`;
  return { url: url.toString(), name, drop: () => dropWhenIdle(name) };
}

export async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const TRACKING_TABLE = 'symb_schema_migrations';

/** Empreinte du schéma public (colonnes, contraintes, index, fonctions, types), hors table de suivi des migrations. */
export async function schemaSnapshot(client: pg.Client): Promise<Record<string, string[]>> {
  const q = async (sql: string) => (await client.query<{ x: string }>(sql, [TRACKING_TABLE])).rows.map((r) => r.x);
  return {
    columns: await q(`
      SELECT c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
             || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
             || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '') AS x
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v') AND a.attnum > 0 AND NOT a.attisdropped AND c.relname <> $1
      ORDER BY 1`),
    constraints: await q(`
      SELECT c.relname || '.' || k.conname || ' ' || pg_get_constraintdef(k.oid) AS x
      FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname <> $1 ORDER BY 1`),
    indexes: await q(`SELECT indexdef AS x FROM pg_indexes WHERE schemaname = 'public' AND tablename <> $1 ORDER BY 1`),
    functions: await q(`
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || md5(p.prosrc) AS x
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND $1::text IS NOT NULL ORDER BY 1`),
    types: await q(`
      SELECT t.typname AS x FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd') AND $1::text IS NOT NULL ORDER BY 1`),
  };
}

/** Empreinte des données de toutes les tables du schéma public (hors table de suivi). */
export async function dataSnapshot(client: pg.Client): Promise<Record<string, string>> {
  const { rows } = await client.query<{ t: string }>(
    `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> $1 ORDER BY 1`,
    [TRACKING_TABLE],
  );
  const out: Record<string, string> = {};
  for (const { t } of rows) {
    const res = await client.query<{ h: string | null }>(
      `SELECT md5(string_agg(x::text, '|' ORDER BY x::text)) AS h FROM (SELECT to_jsonb(r) AS x FROM ${t} r) s`,
    );
    out[t] = res.rows[0]?.h ?? 'vide';
  }
  return out;
}
