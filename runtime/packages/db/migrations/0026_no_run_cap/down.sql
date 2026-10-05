-- SPDX-License-Identifier: AGPL-3.0-only
-- Retour de 0026_no_run_cap : les API sans plafond (NULL) reprennent l'ancien défaut 0.5, colonne NOT NULL DEFAULT 0.5.
UPDATE apis SET max_cost_usd = 0.5 WHERE max_cost_usd IS NULL;
ALTER TABLE apis ALTER COLUMN max_cost_usd SET DEFAULT 0.5;
ALTER TABLE apis ALTER COLUMN max_cost_usd SET NOT NULL;
