-- SPDX-License-Identifier: AGPL-3.0-only
-- 1.10 (INV8, 14 § 10) : `run_artifacts` reçoit l'enveloppe DEK/KEK complète de `secrets` (la DEK de chaque artefact
-- est enveloppée par la KEK : sans `dek_wrapped`, une ligne ne peut être ni ouverte ni rotée par `rekey`).
-- `alg` : identifiant du format de chiffrement (un nouveau format = une nouvelle valeur).
-- Les valeurs par défaut existent seulement pour les lignes écrites avant cette migration (aucun écrivain n'existait : la
-- table est vide) ; l'écrivain (`writeRunArtifact`) renseigne toujours les deux colonnes.
ALTER TABLE run_artifacts
  ADD COLUMN dek_wrapped bytea NOT NULL DEFAULT '\x',
  ADD COLUMN alg text NOT NULL DEFAULT 'aes-256-gcm';

-- Perte de clé ou ligne altérée : `rekey` MARQUE l'artefact illisible (`state = 'unreadable'`, `unreadable_since`) au lieu
-- de le supprimer : aucune donnée ne disparaît sans trace (audit `artifact.unreadable`) ; la rétention le purge ensuite.
ALTER TABLE run_artifacts
  ADD COLUMN state text NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'unreadable')),
  ADD COLUMN unreadable_since timestamptz;
