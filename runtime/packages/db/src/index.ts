// SPDX-License-Identifier: AGPL-3.0-only
// Schéma Drizzle, migrations SQL versionnées, runner verrouillé, connexions (tâche 0.2), dépôt des secrets (0.3a), RLS et audit (0.3b).
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export const PACKAGE_NAME = '@runtime/db';

export * from './accounts.js';
export * from './artifacts.js';
export * from './audit.js';
export * from './codes-only.js';
export * from './connection.js';
export * from './datasets.js';
export * from './health.js';
export * from './investigation-events.js';
export * from './investigations.js';
export * from './portability.js';
export * from './session-check.js';
export * from './extension.js';
export * from './migrate.js';
export * from './ops/index.js';
export * from './pacing.js';
export * from './partitions.js';
export * from './rls.js';
export * from './run-logs.js';
export * from './secrets.js';
export * from './subject-key.js';
export * from './status.js';
export * from './queue.js';
export * from './retention/index.js';
export * from './rejected.js';
export * from './rules.js';
export * from './memory.js';
export * from './quality.js';
export * from './briefs.js';
export * from './runs.js';
export * from './schedules.js';
export * from './webhooks.js';
export * from './alerts.js';
export * from './notify.js';
export * from './persistence.js';
export * from './browser-provider.js';
export * from './robot-identity.js';
export * from './strategies.js';
export * from './tunnel.js';
export { schema };

/** Extrait le nom de la base d'une URL PostgreSQL, sans exposer le mot de passe. */
export function databaseName(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

export type Db = NodePgDatabase<typeof schema>;

/** Pool applicatif + client Drizzle typé. */
export function createDb(connectionString: string, max = 5): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString, max });
  return { db: drizzle({ client: pool, schema }), pool };
}
export * from './steps.js';
export * from './iteration.js';
