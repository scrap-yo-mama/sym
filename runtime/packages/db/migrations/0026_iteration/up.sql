-- SPDX-License-Identifier: AGPL-3.0-only
-- 0026_iteration (tâche 3.14, 19 §6, 19b §1 ; migration validée par l'arbitrage du 2026-10-01) : brouillons d'API et itération
-- par MCP.
--   strategy_versions.state              draft | current | archived. `current` suit `apis.current_strategy_version` (déclencheur
--                                        `apis_mark_current_version`, quel que soit l'écrivain) ; `draft` : une version non
--                                        courante, UN SEUL par API (index unique partiel), jamais lue par un autre membre ;
--   strategy_versions.archive_reason     superseded | expired | discarded s'ajoutent à repair_not_validated ;
--   strategy_versions.base_version       version en service au moment où le brouillon a été tiré ; `base_stale` : le pointeur a
--                                        bougé depuis (posé par le déclencheur à CHAQUE déplacement, quel que soit l'écrivain :
--                                        promotion, retour, réparation, ré-enquête, recompilation) ;
--   strategy_versions.expires_at         péremption d'un brouillon (DRAFT_TTL_DAYS) ;
--   strategy_versions.output_schema      schéma de sortie PROPRE de la version (brouillon : son schéma ; version qui a été
--                                        courante avant une promotion de schéma : celui qu'elle servait, pour un retour) ;
--                                        NULL : celui de l'API. `output_schema_version` : MAJOR.MINOR.PATCH[-draft.N] ;
--   strategy_versions.last_test          dernier test du brouillon (run, diff, empreinte du diff, coût, rejeu sans LLM) ;
--   apis.draft_strategy_version          le brouillon en cours (NULL sinon) ; apis.output_schema_version : version du schéma
--                                        en service ; apis.iteration_budget_usd : budget d'itération (NULL : repair_budget_usd) ;
--   runs.trigger                         + draft_test (test d'un brouillon) et draft_refine (affinage) : aucune transition, aucune
--                                        mesure de qualité, coûts comptés dans les plafonds ;
--   users.promotion_gate                 major_in_console (défaut) | all_in_console, jamais plus large (19 §6).
-- Tout reste sous la RLS `owner_id` (INV12) ; un brouillon n'est jamais lisible par un autre membre, même sur une API partagée.
ALTER TABLE strategy_versions
  ADD COLUMN state text NOT NULL DEFAULT 'archived' CHECK (state IN ('draft', 'current', 'archived')),
  ADD COLUMN base_version integer,
  ADD COLUMN base_stale boolean NOT NULL DEFAULT false,
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN output_schema jsonb CHECK (output_schema IS NULL OR jsonb_typeof(output_schema) = 'object'),
  ADD COLUMN output_schema_version text NOT NULL DEFAULT '1.0.0' CHECK (output_schema_version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(-draft\.[0-9]{1,6})?$'),
  ADD COLUMN last_test jsonb CHECK (last_test IS NULL OR jsonb_typeof(last_test) = 'object');

UPDATE strategy_versions sv SET state = 'current'
WHERE EXISTS (SELECT 1 FROM apis a WHERE a.id = sv.api_id AND a.current_strategy_version = sv.version);

ALTER TABLE strategy_versions DROP CONSTRAINT strategy_versions_archive_reason_check;
ALTER TABLE strategy_versions ADD CONSTRAINT strategy_versions_archive_reason_check
  CHECK (archive_reason IN ('repair_not_validated', 'superseded', 'expired', 'discarded'));
ALTER TABLE strategy_versions DROP CONSTRAINT strategy_versions_created_by_check;
ALTER TABLE strategy_versions ADD CONSTRAINT strategy_versions_created_by_check
  CHECK (created_by IN ('investigation', 'repair', 'user', 'revert', 'import', 'recompile', 'refine'));
-- Un brouillon a toujours sa base, son échéance, et pas de raison d'archivage ; une version archivée par choix en a une.
ALTER TABLE strategy_versions ADD CONSTRAINT strategy_versions_draft_shape
  CHECK (state <> 'draft' OR (base_version IS NOT NULL AND expires_at IS NOT NULL AND archive_reason IS NULL));
CREATE UNIQUE INDEX strategy_versions_one_draft ON strategy_versions (api_id) WHERE state = 'draft';

ALTER TABLE apis
  ADD COLUMN draft_strategy_version integer,
  ADD COLUMN output_schema_version text NOT NULL DEFAULT '1.0.0' CHECK (output_schema_version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$'),
  ADD COLUMN iteration_budget_usd numeric(12, 6) CHECK (iteration_budget_usd IS NULL OR iteration_budget_usd >= 0);

ALTER TABLE users
  ADD COLUMN promotion_gate text NOT NULL DEFAULT 'major_in_console' CHECK (promotion_gate IN ('major_in_console', 'all_in_console'));

ALTER TABLE runs DROP CONSTRAINT runs_trigger_check;
ALTER TABLE runs ADD CONSTRAINT runs_trigger_check CHECK (trigger IN ('mcp', 'rest', 'schedule', 'ui', 'canary', 'draft_test', 'draft_refine'));

-- Le déclencheur de 0017 suit désormais aussi `state` et `base_stale` : à chaque déplacement du pointeur courant, l'ancienne
-- courante est archivée, la nouvelle est `current`, et le brouillon (s'il y en a un, qui n'est pas la nouvelle courante)
-- devient `base_stale` : il doit être retesté avant toute promotion. SECURITY DEFINER comme avant : un écrivain système ne dépend
-- pas du rôle courant ; la fonction ne touche que les versions de NEW.id.
CREATE OR REPLACE FUNCTION apis_mark_current_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  moved boolean;
BEGIN
  IF NEW.current_strategy_version IS NOT NULL THEN
    UPDATE strategy_versions SET was_current = true WHERE api_id = NEW.id AND version = NEW.current_strategy_version AND NOT was_current;
    moved := true;
    IF TG_OP = 'UPDATE' THEN
      moved := OLD.current_strategy_version IS DISTINCT FROM NEW.current_strategy_version;
    END IF;
    IF moved THEN
      UPDATE strategy_versions SET state = 'archived' WHERE api_id = NEW.id AND state = 'current' AND version <> NEW.current_strategy_version;
      UPDATE strategy_versions SET state = 'current', base_stale = false, expires_at = NULL WHERE api_id = NEW.id AND version = NEW.current_strategy_version AND state <> 'current';
      UPDATE strategy_versions SET base_stale = true WHERE api_id = NEW.id AND state = 'draft' AND version <> NEW.current_strategy_version AND NOT base_stale;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- Un brouillon n'est jamais lu par un autre membre : la lecture partagée du catalogue (13 § 3) exclut les brouillons.
DROP POLICY instance_read ON strategy_versions;
CREATE POLICY instance_read ON strategy_versions FOR SELECT TO runtime_app
  USING (app_current_user_id() IS NOT NULL AND state <> 'draft' AND EXISTS (SELECT 1 FROM apis a WHERE a.id = strategy_versions.api_id AND a.visibility = 'instance' AND NOT a.requires_session));
