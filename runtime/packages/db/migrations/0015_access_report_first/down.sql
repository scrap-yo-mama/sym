-- SPDX-License-Identifier: AGPL-3.0-only
DROP TRIGGER IF EXISTS investigation_events_append_only ON investigation_events;
DROP FUNCTION IF EXISTS investigation_events_append_only();
DROP TRIGGER IF EXISTS investigation_events_access_report_first ON investigation_events;
DROP FUNCTION IF EXISTS investigation_events_access_report_first();
ALTER TABLE apis DROP CONSTRAINT IF EXISTS apis_access_policy_robots;
ALTER TABLE apis ADD CONSTRAINT apis_access_policy_robots CHECK (access_policy ->> 'robots' = 'respect');
