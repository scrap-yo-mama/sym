-- SPDX-License-Identifier: AGPL-3.0-only
-- 0016_investigation (tâche 2.1, 04 § 4) : l'enquête est un run de nature `investigation`, et son état entre deux runs
-- (schéma proposé puis validé par l'appelant, `validate_schema`) vit sur l'API.
--   runs.kind          `run` (exécution d'une stratégie) ou `investigation` (étape 0, reconnaissance, schéma, essais) :
--                      le worker choisit l'exécuteur sur cette colonne, jamais sur une entrée fournie par l'appelant ;
--   apis.investigation demande (URL, description, `auto_validate`, plafonds), gisements observés (chemins, types,
--                      tailles : aucune valeur), proposition (champs et chemins), schéma validé, coût et durée cumulés.
--                      L'échantillon et l'exemple de sortie n'y sont jamais : ils vivent dans `investigation_events` et
--                      `runs.input`, couverts par la rétention et l'effacement (17 § 6).
ALTER TABLE runs ADD COLUMN kind text NOT NULL DEFAULT 'run' CHECK (kind IN ('run', 'investigation'));
ALTER TABLE apis ADD COLUMN investigation jsonb CHECK (investigation IS NULL OR jsonb_typeof(investigation) = 'object');
