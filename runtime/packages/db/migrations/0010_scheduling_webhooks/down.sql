-- SPDX-License-Identifier: AGPL-3.0-only
DROP INDEX IF EXISTS webhook_deliveries_subscription_idx;
ALTER TABLE webhook_deliveries
  DROP COLUMN IF EXISTS finished_at,
  DROP COLUMN IF EXISTS error_code,
  DROP COLUMN IF EXISTS response_excerpt,
  DROP COLUMN IF EXISTS duration_ms,
  DROP COLUMN IF EXISTS payload,
  DROP COLUMN IF EXISTS event_id;
ALTER TABLE webhook_subscriptions
  DROP COLUMN IF EXISTS tested_at,
  DROP COLUMN IF EXISTS last_success_at,
  DROP COLUMN IF EXISTS failing_since,
  DROP COLUMN IF EXISTS previous_secret_expires_at,
  DROP COLUMN IF EXISTS previous_secret_id;
ALTER TABLE apis DROP COLUMN IF EXISTS warning_alerted_at;
DROP INDEX IF EXISTS runs_schedule_scheduled_idx;
DROP INDEX IF EXISTS runs_schedule_job_id_key;
ALTER TABLE runs DROP COLUMN IF EXISTS schedule_job_id, DROP COLUMN IF EXISTS scheduled_at, DROP COLUMN IF EXISTS schedule_id;
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_on_missed_check, DROP CONSTRAINT IF EXISTS schedules_overlap_check;
