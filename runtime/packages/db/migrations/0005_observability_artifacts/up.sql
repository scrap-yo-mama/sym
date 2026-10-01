-- 1.10 (INV8, 14 § 10) : `run_artifacts` reçoit l'enveloppe DEK/KEK complète de `secrets` (la DEK de chaque artefact
-- est enveloppée par la KEK : sans `dek_wrapped`, une ligne ne peut être ni ouverte ni rotée par `rekey`).
-- `alg` : identifiant du format de chiffrement (un nouveau format = une nouvelle valeur).
-- Les valeurs par défaut existent seulement pour les lignes écrites avant cette migration (aucun écrivain n'existait : la
-- table est vide) ; l'écrivain (`writeRunArtifact`) renseigne toujours les deux colonnes.
ALTER TABLE run_artifacts
  ADD COLUMN dek_wrapped bytea NOT NULL DEFAULT '\x',
  ADD COLUMN alg text NOT NULL DEFAULT 'aes-256-gcm';
