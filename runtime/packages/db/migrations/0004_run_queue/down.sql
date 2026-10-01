-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE runs DROP COLUMN IF EXISTS requeue_count, DROP COLUMN IF EXISTS worker_id, DROP COLUMN IF EXISTS job_id;
