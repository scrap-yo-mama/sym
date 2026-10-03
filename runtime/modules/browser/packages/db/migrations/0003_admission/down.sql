-- SPDX-License-Identifier: AGPL-3.0-only
-- 0003_admission (descente) : testée en CI seulement.
DROP INDEX IF EXISTS sessions_queue_idx;
ALTER TABLE nodes DROP COLUMN IF EXISTS last_assigned_at;
