-- SPDX-License-Identifier: AGPL-3.0-only
-- 0022_robots_not_read (D-91) : le robots.txt n'est plus lu automatiquement ni contrôlé avant une requête. Migration
-- NON destructive : aucune donnée n'est réécrite ni supprimée.
-- 1. `access_policy.robots` est un champ retiré : la contrainte `apis_access_policy_robots` (0001, durcie par 0015) qui
--    l'exigeait disparaît et la valeur par défaut ne le porte plus. Une politique écrite avant garde sa clé, ignorée à la
--    lecture et à l'écriture (`parseAccessPolicy`).
-- 2. Les classes `robots_disallowed` et `robots_unreachable` ne sont plus produites ; les CHECK de
--    `runs.failure_class` et `run_attempts.result_class` les admettent toujours (valeurs historiques lisibles,
--    `LEGACY_FAILURE_CLASSES`).
-- La politique par défaut `escalade-par-defaut` (seed de 0019, règle partagée d'instance) n'est pas réécrite : la
-- modifier changerait des données d'instance ; son texte cite encore `robots_disallowed` parmi les arrêts, classe qui
-- n'est plus produite.
ALTER TABLE apis DROP CONSTRAINT apis_access_policy_robots;
ALTER TABLE apis ALTER COLUMN access_policy
  SET DEFAULT '{"on_ai_signal": "warn", "intended_use": "context", "prefer_official": true, "payment": {"mode": "never"}}';

