-- SPDX-License-Identifier: AGPL-3.0-only
-- 0012_accounts_advanced : comptes avancés côté serveur (tâche 3.7, 13 § 5-7, 13 § 12, D-15).
--   two_factor          graine TOTP « maison » (décision de 0.3b) : enveloppe complète (chiffré, nonce, DEK enveloppée,
--                       format, version de clé ; AAD = two_factor|user_id), anti-rejeu par le dernier pas TOTP accepté,
--                       état « illisible » après une perte de MASTER_KEY (les codes de secours, hachés, restent valables).
--                       Les colonnes du plugin Better Auth (jamais chargé) restent, inutilisées : migration additive
--                       (une image N-1 relit la base N, 14 § 6).
--   auth_sessions       session en attente du second facteur (mot de passe vérifié, TOTP pas encore) et facteur utilisé.
--   auth_known_devices  appareils reconnus (D-15) : une connexion depuis l'un d'eux n'est pas bloquée par la limite
--                       d'échecs du compte. Empreinte SHA-256 seulement, jamais le jeton.
--   invitations         date d'envoi : l'échéance ne dépasse jamais 48 h après le dernier envoi (13 § 6).
--   users               deleted_at : compte supprimé et anonymisé (13 § 6) ; l'audit garde l'identifiant.
-- Tables d'authentification : identité système seulement (comme 0003), aucun droit pour runtime_app.

ALTER TABLE two_factor
  ALTER COLUMN secret_ciphertext TYPE bytea USING decode(secret_ciphertext, 'base64'),
  ALTER COLUMN nonce TYPE bytea USING decode(nonce, 'base64'),
  ADD COLUMN dek_wrapped bytea,
  ADD COLUMN alg text,
  ADD COLUMN last_used_step bigint,
  ADD COLUMN unreadable_since timestamptz,
  -- INV8 : une graine est toujours scellée en entier.
  ADD CONSTRAINT two_factor_sealed_complete CHECK (nonce IS NOT NULL AND dek_wrapped IS NOT NULL AND alg IS NOT NULL AND key_version IS NOT NULL);

ALTER TABLE auth_sessions
  ADD COLUMN mfa_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN mfa_method text CHECK (mfa_method IN ('totp', 'backup_code', 'idp'));

CREATE TABLE auth_known_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX auth_known_devices_user_id_idx ON auth_known_devices (user_id);

ALTER TABLE invitations
  ADD COLUMN sent_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT invitations_ttl CHECK (expires_at <= sent_at + interval '48 hours');

ALTER TABLE users ADD COLUMN deleted_at timestamptz;
