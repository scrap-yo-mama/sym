-- SPDX-License-Identifier: AGPL-3.0-only
-- 0026_no_run_cap : plus de plafond de coût par run par défaut (décision produit D-123, 2026-10-05).
--   apis.max_cost_usd   devient nullable, défaut NULL : NULL = aucun plafond par run. Un membre peut encore en fixer un,
--                       borné par MAX_COST_USD_PER_RUN (400 `cost_cap_exceeded` au-delà, inchangé). Sans plafond, le
--                       filet est le budget du jour restant de l'utilisateur (USER_BUDGET_DAILY_USD) et, pendant une
--                       enquête, son budget restant : le worker tient toujours une borne finie connue avant l'appel.
--   lignes existantes   celles qui portent exactement 0.5 (l'ancien défaut, jamais choisi explicitement dans la plupart
--                       des cas) passent à NULL ; les autres valeurs, fixées par le membre, sont gardées telles quelles.
--                       Limite assumée : un 0.5 fixé à la main est lui aussi retiré (indiscernable du défaut).
ALTER TABLE apis ALTER COLUMN max_cost_usd DROP NOT NULL;
ALTER TABLE apis ALTER COLUMN max_cost_usd SET DEFAULT NULL;
UPDATE apis SET max_cost_usd = NULL WHERE max_cost_usd = 0.5;
