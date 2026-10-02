-- SPDX-License-Identifier: AGPL-3.0-only
-- 0017_rest_api (tâche 3.1, API REST, 05 § 4.2 et 06 § 2) :
--   runs.paused_at            pause d'un run ou d'une enquête demandée par l'utilisateur, reprise par
--                             `POST /api/runs/{id}/resume` ; NULL hors pause. Un run en pause est `queued` sans job (`job_id`
--                             NULL) : le worker qui le tenait perd son bail au battement suivant (jeton de clôture), ses essais
--                             et ses coûts restent imputés (INV4). Le balayeur ne reprend jamais un run en pause (sweepOrphans)
--                             et `claimRun` le refuse : seule une action de l'utilisateur le remet en file, jamais une
--                             vérification ni une planification. Annulé pendant sa pause, il garde la date.
--   webhook_subscriptions.api_id  abonnement limité à une API (console, Alertes) ; NULL = toutes les API du propriétaire.
--                             Supprimé avec l'API.
ALTER TABLE runs ADD COLUMN paused_at timestamptz;
ALTER TABLE runs ADD CONSTRAINT runs_paused_state CHECK (paused_at IS NULL OR state IN ('queued', 'cancelled'));

ALTER TABLE webhook_subscriptions ADD COLUMN api_id uuid REFERENCES apis (id) ON DELETE CASCADE;
CREATE INDEX webhook_subscriptions_api_id_idx ON webhook_subscriptions (api_id) WHERE api_id IS NOT NULL;

-- strategy_versions.was_current  la version a été courante au moins une fois (19 § « Retour de version borné », 05 § 4.1) :
--                             seul un retour vers une telle version est permis (`400 version_not_revertable` sinon : un
--                             brouillon jamais promu ou une vN+1 de réparation non validée ne devient jamais courante par un
--                             retour). Posée par le déclencheur `apis_mark_current_version` à chaque changement de
--                             `apis.current_strategy_version`, quel que soit l'écrivain (enquête, réparation, retour, import).
--                             Reprise de l'existant : la version courante, celles qu'un run a exécutées et celles qui sont
--                             la parente d'une autre (une parente était courante quand sa fille a été écrite).
ALTER TABLE strategy_versions ADD COLUMN was_current boolean NOT NULL DEFAULT false;
UPDATE strategy_versions sv SET was_current = true
WHERE EXISTS (SELECT 1 FROM apis a WHERE a.id = sv.api_id AND a.current_strategy_version = sv.version)
   OR EXISTS (SELECT 1 FROM runs r WHERE r.api_id = sv.api_id AND r.strategy_version = sv.version)
   OR EXISTS (SELECT 1 FROM strategy_versions c WHERE c.api_id = sv.api_id AND c.parent_version = sv.version);

-- SECURITY DEFINER : sous runtime_app, la RLS filtrerait déjà la bonne ligne (même propriétaire), mais un écrivain
-- système (commande serveur, import) ne doit pas dépendre du rôle courant ; la fonction ne touche que la version courante
-- de NEW.id.
CREATE FUNCTION apis_mark_current_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.current_strategy_version IS NOT NULL THEN
    UPDATE strategy_versions SET was_current = true WHERE api_id = NEW.id AND version = NEW.current_strategy_version AND NOT was_current;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION apis_mark_current_version() FROM PUBLIC;
CREATE TRIGGER apis_mark_current_version AFTER INSERT OR UPDATE OF current_strategy_version ON apis
  FOR EACH ROW EXECUTE FUNCTION apis_mark_current_version();

-- apis.output_columns         ordre DÉCLARÉ des propriétés de premier niveau du schéma de sortie validé (jsonb ne garde
--                             pas l'ordre des clés) : colonnes de l'export CSV dans l'ordre du schéma. Écrit avec
--                             `output_schema` à la fin d'une enquête ; NULL pour une API d'avant (ordre de jsonb).
ALTER TABLE apis ADD COLUMN output_columns text[];

-- Limites de création de run (08b § 3, 05 § 4.3), compteurs PARTAGÉS en PostgreSQL (plusieurs instances du serveur, un
-- redémarrage : mêmes compteurs ; sans Redis).
-- run_creation_counters       créations de run par clé d'API (`bucket` = `key:<id>`) sur une fenêtre d'une minute ouverte
--                             par la première création (`window_start`) ; table système, jamais lue sous runtime_app.
CREATE TABLE run_creation_counters (
  bucket text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL
);

-- reserve_run_slot            plafonds par utilisateur (runs actifs hors pause de l'acteur, `app.user_id`) et par instance,
--                             vérifiés ATOMIQUEMENT avec l'insertion du run : appelée au début de la transaction qui crée
--                             (ou reprend) le run, elle prend un verrou consultatif de transaction ; la transaction suivante
--                             compte donc le run de la précédente. SECURITY DEFINER : elle compte les runs de toute
--                             l'instance (hors RLS) mais ne renvoie qu'un verdict, jamais un nombre ni un identifiant ;
--                             l'utilisateur est celui de la transaction, jamais un paramètre.
CREATE FUNCTION reserve_run_slot(p_states text[], p_max_user integer, p_max_total integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  v_total integer;
  v_mine integer;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'reserve_run_slot : aucun acteur dans la transaction';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('runtime.reserve_run_slot'));
  SELECT count(*)::int, (count(*) FILTER (WHERE owner_id = v_user))::int INTO v_total, v_mine
  FROM runs WHERE state = ANY (p_states) AND paused_at IS NULL;
  IF v_mine >= p_max_user THEN
    RETURN 'user_queue_full';
  END IF;
  IF v_total >= p_max_total THEN
    RETURN 'queue_full';
  END IF;
  RETURN 'ok';
END
$$;
REVOKE ALL ON FUNCTION reserve_run_slot(text[], integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_run_slot(text[], integer, integer) TO runtime_app;
