-- SPDX-License-Identifier: AGPL-3.0-only
-- Retour de 0021 : version 2 seed de la politique par défaut retirée (si elle est encore la courante et qu'aucune source
-- ne la cite), contrainte et valeur par défaut d'`access_policy.robots` rétablies (clé reposée sur les politiques qui ne
-- l'ont plus, valeur `respect`).
UPDATE rule_files SET current_version = 1
WHERE id = '00000000-0000-0000-0000-000000000218' AND current_version = 2
  AND NOT EXISTS (SELECT 1 FROM strategy_version_rules WHERE rule_file_id = '00000000-0000-0000-0000-000000000218' AND rule_version = 2);
DELETE FROM rule_file_versions
WHERE rule_file_id = '00000000-0000-0000-0000-000000000218' AND version = 2 AND origin = 'seed'
  AND (SELECT current_version FROM rule_files WHERE id = '00000000-0000-0000-0000-000000000218') = 1;

UPDATE apis SET access_policy = access_policy || '{"robots": "respect"}' WHERE coalesce(access_policy ->> 'robots', '') <> 'respect';
ALTER TABLE apis ALTER COLUMN access_policy
  SET DEFAULT '{"robots": "respect", "on_ai_signal": "warn", "intended_use": "context", "prefer_official": true, "payment": {"mode": "never"}}';
ALTER TABLE apis ADD CONSTRAINT apis_access_policy_robots CHECK (coalesce(access_policy ->> 'robots', '') = 'respect');
