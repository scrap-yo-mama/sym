-- SPDX-License-Identifier: AGPL-3.0-only
DROP TRIGGER IF EXISTS tunnels_deleted_notify ON tunnels;
DROP TRIGGER IF EXISTS tunnels_revoked_notify ON tunnels;
DROP FUNCTION IF EXISTS tunnels_revoked_notify();
DROP TRIGGER IF EXISTS tunnel_jobs_owner_bound ON tunnel_jobs;
DROP FUNCTION IF EXISTS tunnel_jobs_owner_bound();
DROP INDEX IF EXISTS tunnel_jobs_dispatched_idx;
DROP INDEX IF EXISTS tunnel_jobs_pending_idx;
ALTER TABLE tunnel_jobs
  DROP CONSTRAINT IF EXISTS tunnel_jobs_gateway_instance_format,
  DROP CONSTRAINT IF EXISTS tunnel_jobs_error_format,
  DROP CONSTRAINT IF EXISTS tunnel_jobs_timeout_check,
  DROP CONSTRAINT IF EXISTS tunnel_jobs_no_agent,
  DROP CONSTRAINT IF EXISTS tunnel_jobs_execution_check,
  DROP CONSTRAINT IF EXISTS tunnel_jobs_cmd_check,
  DROP CONSTRAINT IF EXISTS tunnel_jobs_state_check,
  DROP COLUMN IF EXISTS error,
  DROP COLUMN IF EXISTS result,
  DROP COLUMN IF EXISTS finished_at,
  DROP COLUMN IF EXISTS dispatched_at,
  DROP COLUMN IF EXISTS gateway_instance,
  DROP COLUMN IF EXISTS attempts,
  DROP COLUMN IF EXISTS allow_write_actions,
  DROP COLUMN IF EXISTS replayable,
  DROP COLUMN IF EXISTS timeout_ms,
  DROP COLUMN IF EXISTS execution,
  DROP COLUMN IF EXISTS domain,
  DROP COLUMN IF EXISTS cmd;
DROP INDEX IF EXISTS tunnels_owner_connected;
ALTER TABLE tunnels DROP CONSTRAINT IF EXISTS tunnels_gateway_instance_format;
ALTER TABLE tunnels DROP COLUMN IF EXISTS connected_at;
