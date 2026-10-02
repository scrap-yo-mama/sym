-- SPDX-License-Identifier: AGPL-3.0-only
-- 0001_schema (descente) : testée en CI seulement. Jamais un retour arrière de production (correction vers l'avant).
-- Ordre inverse des dépendances ; la référence circulaire profiles <-> sessions est coupée d'abord.

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_lock_session_fk;

DROP TABLE IF EXISTS usage_records;
DROP TABLE IF EXISTS artifacts;
DROP TABLE IF EXISTS session_events;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS proxy_profiles;
DROP TABLE IF EXISTS profiles;
DROP TABLE IF EXISTS nodes;
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS tenants;
