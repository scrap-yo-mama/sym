-- SPDX-License-Identifier: AGPL-3.0-only
DROP FUNCTION IF EXISTS reserve_run_slot(text[], integer, integer);
DROP TABLE IF EXISTS run_creation_counters;
ALTER TABLE apis DROP COLUMN IF EXISTS output_columns;
DROP TRIGGER IF EXISTS apis_mark_current_version ON apis;
DROP FUNCTION IF EXISTS apis_mark_current_version();
ALTER TABLE strategy_versions DROP COLUMN IF EXISTS was_current;
DROP INDEX IF EXISTS webhook_subscriptions_api_id_idx;
ALTER TABLE webhook_subscriptions DROP COLUMN IF EXISTS api_id;
-- Un run en pause redevient un run annulé (aucun job ne le reprendrait), puis la colonne disparaît.
UPDATE runs SET state = 'cancelled', finished_at = coalesce(finished_at, now()) WHERE paused_at IS NOT NULL AND state = 'queued';
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_paused_state;
ALTER TABLE runs DROP COLUMN paused_at;
