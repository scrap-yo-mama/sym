-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE webhook_deliveries DROP CONSTRAINT IF EXISTS webhook_deliveries_subscription_owner_fkey;
ALTER TABLE webhook_subscriptions
  DROP CONSTRAINT IF EXISTS webhook_subscriptions_previous_secret_owner_fkey,
  DROP CONSTRAINT IF EXISTS webhook_subscriptions_secret_owner_fkey,
  DROP CONSTRAINT IF EXISTS webhook_subscriptions_id_owner_key;
ALTER TABLE secrets DROP CONSTRAINT IF EXISTS secrets_id_owner_key;
ALTER TABLE webhook_subscriptions DROP COLUMN IF EXISTS last_failure_at;
ALTER TABLE datasets DROP COLUMN IF EXISTS new_items;
