-- SPDX-License-Identifier: AGPL-3.0-only
-- Retour de 0026_iteration. Les brouillons sont supprimés (ils n'ont jamais été courants) ; les runs d'essai et d'affinage
-- sont rangés sous `canary` (aucune transition, aucune donnée perdue).
DROP POLICY instance_read ON strategy_versions;
CREATE POLICY instance_read ON strategy_versions FOR SELECT TO runtime_app
  USING (app_current_user_id() IS NOT NULL AND EXISTS (SELECT 1 FROM apis a WHERE a.id = strategy_versions.api_id AND a.visibility = 'instance' AND NOT a.requires_session));

CREATE OR REPLACE FUNCTION apis_mark_current_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.current_strategy_version IS NOT NULL THEN
    UPDATE strategy_versions SET was_current = true WHERE api_id = NEW.id AND version = NEW.current_strategy_version AND NOT was_current;
  END IF;
  RETURN NULL;
END
$$;

UPDATE runs SET trigger = 'canary' WHERE trigger IN ('draft_test', 'draft_refine');
ALTER TABLE runs DROP CONSTRAINT runs_trigger_check;
ALTER TABLE runs ADD CONSTRAINT runs_trigger_check CHECK (trigger IN ('mcp', 'rest', 'schedule', 'ui', 'canary'));

ALTER TABLE users DROP COLUMN promotion_gate;
ALTER TABLE apis DROP COLUMN iteration_budget_usd, DROP COLUMN output_schema_version, DROP COLUMN draft_strategy_version;

DROP INDEX strategy_versions_one_draft;
ALTER TABLE strategy_versions DROP CONSTRAINT strategy_versions_draft_shape;
DELETE FROM strategy_versions WHERE state = 'draft';
UPDATE strategy_versions SET archive_reason = NULL WHERE archive_reason IN ('superseded', 'expired', 'discarded');
UPDATE strategy_versions SET created_by = 'recompile' WHERE created_by = 'refine';
ALTER TABLE strategy_versions DROP CONSTRAINT strategy_versions_created_by_check;
ALTER TABLE strategy_versions ADD CONSTRAINT strategy_versions_created_by_check
  CHECK (created_by IN ('investigation', 'repair', 'user', 'revert', 'import', 'recompile'));
ALTER TABLE strategy_versions DROP CONSTRAINT strategy_versions_archive_reason_check;
ALTER TABLE strategy_versions ADD CONSTRAINT strategy_versions_archive_reason_check CHECK (archive_reason IN ('repair_not_validated'));
ALTER TABLE strategy_versions
  DROP COLUMN last_test, DROP COLUMN output_schema_version, DROP COLUMN output_schema, DROP COLUMN expires_at,
  DROP COLUMN base_stale, DROP COLUMN base_version, DROP COLUMN state;
