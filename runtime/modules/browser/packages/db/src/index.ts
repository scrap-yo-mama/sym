// SPDX-License-Identifier: AGPL-3.0-only
// Base de SYM Browser (cdc/sym-browser 03 § 5) : schéma PostgreSQL 16 à 18, migrations sous `pg_advisory_lock` (tâche 0.2)
// et miroir Drizzle. Le module a sa propre base logique : rien n'est partagé avec `@runtime/db`.
export * from './migrate.js';
export * as schema from './schema.js';

/** Tables du modèle de données (03 § 5). */
export const TABLES = ['tenants', 'api_keys', 'nodes', 'sessions', 'session_events', 'profiles', 'proxy_profiles', 'artifacts', 'usage_records'] as const;
export type TableName = (typeof TABLES)[number];
export * from './sessions.js';
