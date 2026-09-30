// Partitions mensuelles de dataset_items (14 § 9). Création : fonction SQL ensure_dataset_items_partitions (0001_init).
// Purge physique d'un mois entier : DETACH … CONCURRENTLY puis DROP (hors transaction). Le choix des mois purgeables
// (datasets expirés, non épinglés) appartient à la tâche 1.8.
import type pg from 'pg';

type Queryable = Pick<pg.ClientBase, 'query'>;

const PARTITION_NAME = /^dataset_items_p\d{6}$/;

/** Crée les partitions de `months` mois à partir du mois de `at` (défaut : mois courant et suivant). */
export async function ensureDatasetItemsPartitions(db: Queryable, at: Date = new Date(), months = 2): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>('SELECT ensure_dataset_items_partitions($1, $2) AS name', [at, months]);
  return rows.map((r) => r.name);
}

export type Partition = { name: string; bounds: string };

export async function listDatasetItemsPartitions(db: Queryable): Promise<Partition[]> {
  const { rows } = await db.query<Partition>(`
    SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bounds
    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'public.dataset_items'::regclass
    ORDER BY c.relname`);
  return rows;
}

/** Détache puis supprime une partition mensuelle. `db` ne doit pas être dans une transaction (CONCURRENTLY). */
export async function dropDatasetItemsPartition(db: Queryable, name: string): Promise<void> {
  if (!PARTITION_NAME.test(name)) throw new Error(`partition invalide : ${name}`);
  await db.query(`ALTER TABLE dataset_items DETACH PARTITION ${name} CONCURRENTLY`);
  await db.query(`DROP TABLE ${name}`);
}
