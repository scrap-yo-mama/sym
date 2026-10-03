-- SPDX-License-Identifier: AGPL-3.0-only
-- 0004_events_webhooks (descente) : testée en CI seulement.
DROP TRIGGER IF EXISTS session_events_published ON session_events;
DROP FUNCTION IF EXISTS symb_session_event_published();
DROP TABLE IF EXISTS webhook_deliveries;
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_webhook_secret_with_url, DROP COLUMN IF EXISTS webhook_secret_encrypted, DROP COLUMN IF EXISTS webhook_url;
