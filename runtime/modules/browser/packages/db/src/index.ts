// SPDX-License-Identifier: AGPL-3.0-only
// Base de SYM Browser (cdc/sym-browser 03 § 5) : schéma PostgreSQL 16 à 18 et migrations sous `pg_advisory_lock` (tâche 0.2).
// Squelette de la tâche 0.1 : la liste des tables attendues, sans schéma ni migration.

/** Tables du modèle de données (03 § 5). */
export const TABLES = ['tenants', 'api_keys', 'nodes', 'sessions', 'session_events', 'profiles', 'proxy_profiles', 'artifacts', 'usage_records'] as const;
export type TableName = (typeof TABLES)[number];
