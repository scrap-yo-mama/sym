-- 0.3a (INV8) : état d'un secret. `unreadable` = indéchiffrable avec la clé courante (clé perdue, ligne altérée) ;
-- la ligne est conservée (« À ressaisir ») et n'est jamais re-chiffrée ni exposée.
ALTER TABLE secrets
  ADD COLUMN state text NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'unreadable')),
  ADD COLUMN unreadable_since timestamptz;
CREATE INDEX secrets_kek_version_idx ON secrets (kek_version);
