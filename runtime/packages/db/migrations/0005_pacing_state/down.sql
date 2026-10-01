-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE domain_pacing_state
  DROP COLUMN IF EXISTS window_retries,
  DROP COLUMN IF EXISTS window_requests,
  DROP COLUMN IF EXISTS window_started_at,
  DROP COLUMN IF EXISTS probe_started_at,
  DROP COLUMN IF EXISTS circuit_trips,
  DROP COLUMN IF EXISTS circuit_open_until,
  DROP COLUMN IF EXISTS penalty_until,
  DROP COLUMN IF EXISTS adaptive_changed_at,
  DROP COLUMN IF EXISTS calm_successes,
  DROP COLUMN IF EXISTS adaptive_delay_ms,
  DROP COLUMN IF EXISTS min_delay_ms;
