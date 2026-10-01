-- SPDX-License-Identifier: AGPL-3.0-only
-- Retour arrière de 0012 : un coût inconnu redevient 0 (perte de l'information « inconnu », seule forme que l'ancien
-- schéma sait écrire).
UPDATE run_attempts SET cost_usd = 0 WHERE cost_usd IS NULL;
UPDATE runs SET cost_llm_usd = 0 WHERE cost_llm_usd IS NULL;
ALTER TABLE run_attempts ALTER COLUMN cost_usd SET NOT NULL;
ALTER TABLE runs ALTER COLUMN cost_llm_usd SET NOT NULL;
