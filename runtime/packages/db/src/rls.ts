// SPDX-License-Identifier: AGPL-3.0-only
// Contexte d'utilisateur des requêtes (INV12, 13 § 3, migration 0003) : chaque transaction de requête passe sous le
// rôle `runtime_app` (ni propriétaire, ni BYPASSRLS) et pose `app.user_id` / `app.role` avec `set_config(..., true)`,
// donc limités à la transaction (compatible pooler en mode transaction). Hors de `withActor`, la connexion est
// l'identité système (migrations, key_check, rekey, bibliothèque d'auth) : aucune route ne doit lire du contenu ainsi.
import type { Role } from '@runtime/core';
import type pg from 'pg';

/** Rôle PostgreSQL des requêtes d'utilisateur (créé par 0003_rls_app_role). */
export const APP_ROLE = 'runtime_app';

/** Identité posée dans la transaction. `null` : requête anonyme (aucune ligne de contenu visible). */
export type DbActor = { userId: string; role: Role } | null;

/**
 * Exécute `fn` dans une transaction sous `runtime_app`, avec l'identité `actor`. Validation, puis COMMIT ; toute
 * erreur annule. Le client n'est jamais rendu au pool avec le rôle ou les paramètres posés (portée transaction).
 */
export async function withActor<T>(pool: pg.Pool, actor: DbActor, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let result: T;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    await client.query("SELECT set_config('app.user_id', $1, true), set_config('app.role', $2, true)", [
      actor?.userId ?? '',
      actor?.role ?? '',
    ]);
    result = await fn(client);
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // État de la connexion inconnu (rôle ou paramètres peut-être encore posés) : détruite, jamais rendue au pool.
      client.release(rollbackError as Error);
      throw error;
    }
    client.release();
    throw error;
  }
  client.release();
  return result;
}

/**
 * Exécute `fn` sous l'identité `actor` (rôle `runtime_app`, `app.user_id`, `app.role`) DANS la transaction en cours
 * d'un client système (ex. un crochet de `applyStatusAndNotify`, qui tient la ligne `apis` sous verrou), puis rend
 * l'identité système : l'écriture de l'utilisateur (RLS) et celle du système (statut, INV3) partent au même COMMIT. Une
 * exception laisse la transaction à annuler par l'appelant (rien n'est écrit).
 */
export async function asActorInTransaction<T>(client: pg.PoolClient, actor: NonNullable<DbActor>, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
  await client.query("SELECT set_config('app.user_id', $1, true), set_config('app.role', $2, true)", [actor.userId, actor.role]);
  const out = await fn(client);
  await client.query('SET LOCAL ROLE NONE');
  await client.query("SELECT set_config('app.user_id', '', true), set_config('app.role', '', true)");
  return out;
}
