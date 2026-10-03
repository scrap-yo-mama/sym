-- SPDX-License-Identifier: AGPL-3.0-only
-- Retour de 0022 : contrainte et valeur par défaut d'`access_policy.robots` rétablies (clé reposée sur les politiques
-- qui ne l'ont plus, valeur `respect`).
UPDATE apis SET access_policy = access_policy || '{"robots": "respect"}' WHERE coalesce(access_policy ->> 'robots', '') <> 'respect';
ALTER TABLE apis ALTER COLUMN access_policy
  SET DEFAULT '{"robots": "respect", "on_ai_signal": "warn", "intended_use": "context", "prefer_official": true, "payment": {"mode": "never"}}';
ALTER TABLE apis ADD CONSTRAINT apis_access_policy_robots CHECK (coalesce(access_policy ->> 'robots', '') = 'respect');
