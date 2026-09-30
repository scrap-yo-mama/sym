DROP INDEX IF EXISTS secrets_kek_version_idx;
ALTER TABLE secrets DROP COLUMN IF EXISTS unreadable_since, DROP COLUMN IF EXISTS state;
