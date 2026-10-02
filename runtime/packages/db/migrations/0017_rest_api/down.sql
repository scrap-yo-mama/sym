-- SPDX-License-Identifier: AGPL-3.0-only
DROP INDEX IF EXISTS webhook_subscriptions_api_id_idx;
ALTER TABLE webhook_subscriptions DROP COLUMN IF EXISTS api_id;
-- Un run en pause redevient un run annulé (aucun job ne le reprendrait), puis la colonne disparaît.
UPDATE runs SET state = 'cancelled', finished_at = coalesce(finished_at, now()) WHERE paused_at IS NOT NULL AND state = 'queued';
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_paused_state;
ALTER TABLE runs DROP COLUMN paused_at;
