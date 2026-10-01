-- SPDX-License-Identifier: AGPL-3.0-only
DROP FUNCTION IF EXISTS admin_revoke_tunnel(uuid);
DROP VIEW IF EXISTS admin_tunnel_metadata;
DROP TRIGGER IF EXISTS users_disabled_revoke_extension ON users;
DROP FUNCTION IF EXISTS users_disabled_revoke_extension();
-- Aucune ligne d'audit supprimée : l'attribution « extension » est conservée dans actor_ref.
UPDATE audit_events SET actor_via = 'system', actor_ref = coalesce(actor_ref, 'extension') WHERE actor_via = 'extension';
ALTER TABLE audit_events DROP CONSTRAINT audit_events_actor_via_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_via_check
  CHECK (actor_via IN ('ui', 'apikey', 'mcp', 'sso', 'system'));
REVOKE SELECT (id, owner_id, project_id, domain, server_use_allowed, key_version, captured_at, expires_at, created_at, consented_at, updated_at)
  ON site_sessions FROM runtime_app;
GRANT SELECT ON site_sessions TO runtime_app;
ALTER TABLE site_sessions
  DROP CONSTRAINT IF EXISTS site_sessions_sealed_complete,
  DROP CONSTRAINT IF EXISTS site_sessions_domain_format,
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS consented_at,
  DROP COLUMN IF EXISTS alg,
  DROP COLUMN IF EXISTS dek_wrapped;

DROP INDEX IF EXISTS tunnels_owner_device_active;
ALTER TABLE tunnels DROP COLUMN IF EXISTS revoked_by;

DROP TABLE IF EXISTS extension_pairing_codes;
