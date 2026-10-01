-- SPDX-License-Identifier: AGPL-3.0-only
-- 0015_access_report_first (tâche 1.11 ; 17 § 2, 04 § 4, 04b « assert_access_report_first ») : le rapport d'accès est
-- l'étape 0 de toute enquête. Aucun essai (`attempt*`) ni reconnaissance (`reconnaissance*`) ne s'inscrit au récit
-- d'une enquête (`investigation_events`) sans un événement `access_report` antérieur (seq plus petit) dont le verdict
-- autorise la suite (`payload.verdict.proceed = true`). Un robots.txt qui interdit le chemin (`robots_disallowed`), un
-- robots.txt injoignable ou une offre 402 arrêtent donc l'enquête, jusque dans la base (INV11).
-- Correctif INV11 : la contrainte `apis_access_policy_robots` de 0001 laissait passer une politique SANS clé `robots`
-- (`NULL = 'respect'` est inconnu, donc accepté par un CHECK) ; la clé est désormais obligatoire et vaut `respect`.
ALTER TABLE apis DROP CONSTRAINT apis_access_policy_robots;
ALTER TABLE apis ADD CONSTRAINT apis_access_policy_robots CHECK (coalesce(access_policy ->> 'robots', '') = 'respect');

CREATE FUNCTION investigation_events_access_report_first() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  last_report jsonb;
BEGIN
  IF NEW.kind = 'access_report' THEN
    IF jsonb_typeof(NEW.payload -> 'verdict' -> 'proceed') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'access_report sans verdict' USING ERRCODE = 'check_violation', CONSTRAINT = 'investigation_events_access_report_first';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind LIKE 'attempt%' OR NEW.kind LIKE 'reconnaissance%' THEN
    SELECT payload INTO last_report
      FROM investigation_events
     WHERE run_id = NEW.run_id AND kind = 'access_report' AND seq < NEW.seq
     ORDER BY seq DESC
     LIMIT 1;
    IF last_report IS NULL THEN
      RAISE EXCEPTION 'aucun essai avant le rapport d''accès' USING ERRCODE = 'check_violation', CONSTRAINT = 'investigation_events_access_report_first';
    END IF;
    IF (last_report -> 'verdict' ->> 'proceed') IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'le rapport d''accès arrête l''enquête' USING ERRCODE = 'check_violation', CONSTRAINT = 'investigation_events_access_report_first';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER investigation_events_access_report_first
  BEFORE INSERT ON investigation_events
  FOR EACH ROW EXECUTE FUNCTION investigation_events_access_report_first();

-- Récit en ajout seul (revue de 1.11) : runtime_app garde UPDATE et DELETE sur `investigation_events` (0003), utiles à la
-- purge des charges (17 § 6) et à l'effacement d'un sujet (valeurs remplacées). Un REVOKE les casserait ; un déclencheur
-- borne donc ces droits : `run_id`, `seq`, `owner_id`, `kind` et `at` sont figés (aucun événement renommé en essai après
-- coup), un `access_report` qui arrête l'enquête ne devient jamais favorable, et aucune ligne n'est supprimée directement :
-- le récit part avec son run (ON DELETE CASCADE, exécuté par le déclencheur de contrainte, donc à une profondeur > 1).
CREATE FUNCTION investigation_events_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'récit d''enquête en ajout seul : suppression refusée (le récit part avec son run)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'investigation_events_append_only';
  END IF;
  IF NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.at IS DISTINCT FROM OLD.at THEN
    RAISE EXCEPTION 'récit d''enquête en ajout seul : run, seq, propriétaire, kind et date figés'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'investigation_events_append_only';
  END IF;
  IF OLD.kind = 'access_report' AND (NEW.payload -> 'verdict' ->> 'proceed') IS NOT DISTINCT FROM 'true'
     AND (OLD.payload -> 'verdict' ->> 'proceed') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'un rapport d''accès qui arrête l''enquête ne devient pas favorable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'investigation_events_append_only';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER investigation_events_append_only
  BEFORE UPDATE OR DELETE ON investigation_events
  FOR EACH ROW EXECUTE FUNCTION investigation_events_append_only();
