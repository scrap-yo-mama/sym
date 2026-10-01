-- SPDX-License-Identifier: AGPL-3.0-only
-- 0013_llm_cost_unknown (tâche 2.4, correctifs de vérification ; 08 § 1 « Prix et cache », INV4) : un prix de modèle
-- absent donne un coût LLM INCONNU, écrit NULL avec avertissement, jamais 0 (critère de 08 : « Given un prix absent When
-- un run se termine Then cost_llm_usd vaut null avec avertissement, pas 0 »).
--   runs.cost_llm_usd       NULL dès qu'un essai du run a un coût LLM inconnu (`NULL + x` reste NULL) ;
--   run_attempts.cost_usd   NULL pour cet essai (somme LLM + proxy inconnue).
ALTER TABLE runs ALTER COLUMN cost_llm_usd DROP NOT NULL;
ALTER TABLE run_attempts ALTER COLUMN cost_usd DROP NOT NULL;
