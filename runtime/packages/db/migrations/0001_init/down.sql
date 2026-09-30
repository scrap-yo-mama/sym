-- SPDX-License-Identifier: AGPL-3.0-only
-- 0001_init (descente) : testée en CI seulement (14 § 5). Jamais un retour arrière de production.
-- L'extension citext est conservée : d'autres objets de la base peuvent en dépendre.

DROP VIEW IF EXISTS admin_dataset_usage;
DROP VIEW IF EXISTS admin_run_metadata;

DROP TABLE IF EXISTS webhook_deliveries;
DROP TABLE IF EXISTS webhook_subscriptions;
DROP TABLE IF EXISTS worker_heartbeats;
DROP TABLE IF EXISTS tunnel_jobs;
DROP TABLE IF EXISTS tunnels;
DROP TABLE IF EXISTS site_sessions;
DROP TABLE IF EXISTS domain_pacing_state;
DROP TABLE IF EXISTS schedules;

DROP FUNCTION IF EXISTS ensure_dataset_items_partitions(timestamptz, integer);
DROP TABLE IF EXISTS dedup_keys;
DROP TABLE IF EXISTS dataset_items; -- emporte ses partitions
DROP TABLE IF EXISTS datasets;

DROP TABLE IF EXISTS status_events;
DROP TABLE IF EXISTS investigation_events;
DROP TABLE IF EXISTS run_artifacts;
DROP TABLE IF EXISTS run_logs;
DROP TABLE IF EXISTS run_attempts;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS strategy_versions;
DROP TABLE IF EXISTS apis;
DROP TABLE IF EXISTS secrets;

DROP TABLE IF EXISTS responsible_use_acks;
DROP TABLE IF EXISTS subject_exclusions;
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS backup_codes;
DROP TABLE IF EXISTS two_factor;
DROP TABLE IF EXISTS invitations;
DROP TABLE IF EXISTS verifications;
DROP TABLE IF EXISTS auth_accounts;
DROP TABLE IF EXISTS auth_sessions;
DROP TABLE IF EXISTS users;

DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS projects;
