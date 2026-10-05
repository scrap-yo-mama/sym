-- SPDX-License-Identifier: AGPL-3.0-only
-- Retour de 0027_session_server_state : le journal d'usage des sessions et les colonnes d'état sont supprimés.
DROP TABLE site_session_events;
ALTER TABLE site_sessions
  DROP CONSTRAINT site_sessions_account_label_len,
  DROP CONSTRAINT site_sessions_secret_kind,
  DROP COLUMN account_label,
  DROP COLUMN last_checked_at,
  DROP COLUMN last_used_at,
  DROP COLUMN secret_kind;
