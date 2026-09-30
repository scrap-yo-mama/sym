-- SPDX-License-Identifier: AGPL-3.0-only
DROP INDEX IF EXISTS secrets_kek_version_idx;
ALTER TABLE secrets DROP COLUMN IF EXISTS unreadable_since, DROP COLUMN IF EXISTS state;
