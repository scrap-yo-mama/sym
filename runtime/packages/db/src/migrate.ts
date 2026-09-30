// Runner de migrations SQL versionnées (14 § 5) : `migrations/NNNN_nom/{up,down}.sql`, table `schema_migrations`,
// verrou consultatif de session sur une clé fixe (connexion directe obligatoire), une transaction par migration.
// Idempotent : deux `runtime migrate` simultanés appliquent chaque migration une seule fois (assert_migrations_locked).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/** Clé du verrou consultatif : « scrapyma » en ASCII (0x7363726170796d61), fixe pour toutes les versions. */
export const MIGRATION_LOCK_KEY = '8315178094305570145';

/** PostgreSQL minimal accepté (14 § 4). */
export const MIN_SERVER_VERSION_NUM = 150000;

/** Dossier des migrations, identique depuis src/ (tests) et dist/ (image). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export type Migration = { version: number; name: string; up: string; down: string; checksum: string };
export type Log = (line: string) => void;

const DIR_PATTERN = /^(\d{4})_([a-z0-9_]+)$/;

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const match = DIR_PATTERN.exec(entry.name);
      if (!match) throw new Error(`migrations : nom de dossier invalide « ${entry.name} » (attendu NNNN_nom)`);
      const up = readFileSync(`${dir}/${entry.name}/up.sql`, 'utf8');
      const down = readFileSync(`${dir}/${entry.name}/down.sql`, 'utf8');
      return {
        version: Number(match[1]),
        name: match[2] ?? '',
        up,
        down,
        checksum: createHash('sha256').update(up).digest('hex'),
      };
    })
    .sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migrations : numérotation non continue à ${String(m.version).padStart(4, '0')}`);
  });
  return migrations;
}

export function expectedSchemaVersion(migrations: Migration[] = loadMigrations()): number {
  return migrations.at(-1)?.version ?? 0;
}

type Options = { connectionString: string; migrations?: Migration[]; log?: Log };

async function withLockedClient<T>(opts: Options, fn: (client: pg.Client, log: Log) => Promise<T>): Promise<T> {
  const log = opts.log ?? (() => {});
  const client = new pg.Client({ connectionString: opts.connectionString, application_name: 'runtime-migrate' });
  await client.connect();
  try {
    await assertServerVersion(client);
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [MIGRATION_LOCK_KEY]);
    if (!rows[0]?.locked) {
      log('migrate : une autre migration est en cours, attente du verrou…');
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    }
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now())`);
      return await fn(client, log);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

export async function assertServerVersion(client: Pick<pg.ClientBase, 'query'>): Promise<number> {
  const { rows } = await client.query<{ num: string; version: string }>(
    "SELECT current_setting('server_version_num') AS num, current_setting('server_version') AS version",
  );
  const num = Number(rows[0]?.num);
  if (!(num >= MIN_SERVER_VERSION_NUM)) {
    throw new Error(`PostgreSQL 15 minimum requis (16 recommandé) ; version trouvée : ${rows[0]?.version ?? 'inconnue'}`);
  }
  return num;
}

async function appliedVersions(client: pg.Client): Promise<Map<number, string>> {
  const { rows } = await client.query<{ version: number; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  );
  return new Map(rows.map((r) => [r.version, r.checksum]));
}

const label = (m: Migration) => `${String(m.version).padStart(4, '0')}_${m.name}`;

/** Applique les migrations en attente. Renvoie les versions appliquées par CET appel. */
export async function migrateUp(opts: Options): Promise<{ applied: number[] }> {
  const migrations = opts.migrations ?? loadMigrations();
  return withLockedClient(opts, async (client, log) => {
    const done = await appliedVersions(client);
    for (const [version, checksum] of done) {
      const m = migrations.find((x) => x.version === version);
      if (!m) throw new Error(`migrate : la base est à une version (${version}) inconnue de ce code, plus récent que lui`);
      if (m.checksum !== checksum) throw new Error(`migrate : ${label(m)} a été modifiée après son application`);
    }
    const applied: number[] = [];
    for (const m of migrations.filter((x) => !done.has(x.version))) {
      const started = Date.now();
      log(`migrate : ${label(m)}…`);
      await client.query('BEGIN');
      try {
        await client.query(m.up);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          m.version,
          m.name,
          m.checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migrate : échec de ${label(m)} (annulée) : ${(error as Error).message}`, { cause: error });
      }
      applied.push(m.version);
      log(`migrate : ${label(m)} appliquée en ${Date.now() - started} ms`);
    }
    if (applied.length === 0) log('migrate : schéma à jour');
    return { applied };
  });
}

/**
 * Descend `steps` migrations (toutes si `all`). Réservé aux tests et à la CI : refusé si NODE_ENV=production
 * (en production, correction vers l'avant, 14 § 5-6).
 */
export async function migrateDown(
  opts: Options & { steps?: number; all?: boolean; env?: NodeJS.ProcessEnv },
): Promise<{ reverted: number[] }> {
  if ((opts.env ?? process.env).NODE_ENV === 'production') {
    throw new Error("migrate down : refusé en production (NODE_ENV=production). Retour arrière = image précédente + restauration de la sauvegarde");
  }
  const migrations = opts.migrations ?? loadMigrations();
  return withLockedClient(opts, async (client, log) => {
    const done = [...(await appliedVersions(client)).keys()].sort((a, b) => b - a);
    const targets = opts.all ? done : done.slice(0, opts.steps ?? 1);
    const reverted: number[] = [];
    for (const version of targets) {
      const m = migrations.find((x) => x.version === version);
      if (!m) throw new Error(`migrate down : migration ${version} introuvable dans ce code`);
      log(`migrate down : ${label(m)}…`);
      await client.query('BEGIN');
      try {
        await client.query(m.down);
        await client.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migrate down : échec de ${label(m)} (annulée) : ${(error as Error).message}`, { cause: error });
      }
      reverted.push(version);
    }
    return { reverted };
  });
}

/** Version courante du schéma (0 si aucune migration appliquée ou table absente). */
export async function currentSchemaVersion(client: Pick<pg.ClientBase, 'query'>): Promise<number> {
  const exists = await client.query<{ t: string | null }>("SELECT to_regclass('public.schema_migrations')::text AS t");
  if (!exists.rows[0]?.t) return 0;
  const { rows } = await client.query<{ v: number }>('SELECT coalesce(max(version), 0)::int AS v FROM schema_migrations');
  return rows[0]?.v ?? 0;
}
