-- SPDX-License-Identifier: AGPL-3.0-only
-- 0003_admission : file d'attente et choix du nœud (cdc/sym-browser 04b § 7, tâche 2.4).
-- La file est l'ensemble des sessions `pending` sans nœud (`node_id` NULL), servie dans l'ordre de `created_at`.
-- `last_assigned_at` départage les nœuds à taux d'occupation égal : le plus anciennement servi passe d'abord.
ALTER TABLE nodes ADD COLUMN last_assigned_at timestamptz;
CREATE INDEX sessions_queue_idx ON sessions (created_at, id) WHERE state = 'pending' AND node_id IS NULL;
