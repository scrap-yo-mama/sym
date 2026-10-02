// SPDX-License-Identifier: AGPL-3.0-only
// Base de SYM Browser (cdc/sym-browser 03 § 5) : schéma PostgreSQL 16 à 18, migrations sous `pg_advisory_lock` (tâche 0.2)
// et miroir Drizzle ; clés d'API (tâche 2.1), registre des profils persistants (tâche 3.1). Le module a sa propre base
// logique : rien n'est partagé avec `@runtime/db`.
export * from './api-keys.js';
export * from './migrate.js';
export * from './profiles.js';
export * from './nodes.js';
export * as schema from './schema.js';

/** Tables du modèle de données (03 § 5), plus `idempotency_keys` (04 § 9, tâche 2.2) et `webhook_deliveries` (tâche 2.5). */
export const TABLES = ['tenants', 'api_keys', 'nodes', 'sessions', 'session_events', 'profiles', 'proxy_profiles', 'artifacts', 'usage_records', 'idempotency_keys', 'webhook_deliveries'] as const;
export type TableName = (typeof TABLES)[number];
export * from './sessions.js';
export * from './admission.js';
export * from './api.js';
export * from './events.js';
export * from './observability.js';
