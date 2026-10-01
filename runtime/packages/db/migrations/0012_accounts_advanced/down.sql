-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE users DROP COLUMN IF EXISTS deleted_at;

ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_ttl, DROP COLUMN IF EXISTS sent_at;

DROP TABLE IF EXISTS auth_known_devices;

ALTER TABLE auth_sessions DROP COLUMN IF EXISTS mfa_method, DROP COLUMN IF EXISTS mfa_pending;

-- Les graines scellées ne se relisent pas sous l'ancien format (texte du plugin) : elles sont supprimées (ré-enrôlement).
DELETE FROM two_factor;
ALTER TABLE two_factor
  DROP CONSTRAINT IF EXISTS two_factor_sealed_complete,
  DROP COLUMN IF EXISTS unreadable_since,
  DROP COLUMN IF EXISTS last_used_step,
  DROP COLUMN IF EXISTS alg,
  DROP COLUMN IF EXISTS dek_wrapped,
  ALTER COLUMN secret_ciphertext TYPE text USING encode(secret_ciphertext, 'base64'),
  ALTER COLUMN nonce TYPE text USING encode(nonce, 'base64');
