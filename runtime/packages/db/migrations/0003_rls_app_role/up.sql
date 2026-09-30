-- 0003_rls_app_role : isolement entre utilisateurs (INV12, 13 § 3) et journal d'audit en ajout seul (13 § 9). Tâche 0.3b.
--
-- Modèle : la connexion de l'application (propriétaire des tables : migrations, key_check, rekey, bibliothèque d'auth)
-- est l'identité « système ». Chaque transaction de requête bascule sur le rôle `runtime_app` par
-- `SET LOCAL ROLE runtime_app` et pose `app.user_id` / `app.role` par `set_config(..., true)` : compatible avec un
-- pooler en mode transaction (rien ne survit à la transaction). `runtime_app` n'est ni superutilisateur, ni BYPASSRLS,
-- ni propriétaire d'une table : la RLS s'applique toujours à lui (packages/db/src/rls.ts).
-- Pas de FORCE ROW LEVEL SECURITY : le propriétaire des tables est justement l'identité système (rekey, vues
-- d'administration, purge) et n'est jamais utilisé par une requête d'utilisateur ; FORCE sans politique pour lui
-- rendrait ces opérations silencieusement vides sur un hébergeur où il n'est pas superutilisateur.
-- Les rôles sont des objets du cluster : `runtime_app` est créé s'il manque et n'est pas supprimé par down.sql
-- (d'autres bases du même cluster peuvent l'utiliser) ; down.sql retire tous ses droits dans CETTE base.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'runtime_app') THEN
    CREATE ROLE runtime_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
EXCEPTION
  -- Deux bases du même cluster migrées en même temps : la seconde création échoue, le rôle existe.
  WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;
-- Garde : un rôle préexistant du même nom ne doit pas contourner la RLS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'runtime_app' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'le rôle runtime_app existe avec SUPERUSER ou BYPASSRLS : la RLS serait ignorée, migration refusée';
  END IF;
END
$$;
-- La connexion applicative doit pouvoir faire SET ROLE runtime_app (sans effet pour un superutilisateur).
DO $$
BEGIN
  EXECUTE format('GRANT runtime_app TO %I', current_user);
EXCEPTION
  WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;

-- Identité de la transaction courante (NULL si non posée : aucune ligne visible).
CREATE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

GRANT USAGE ON SCHEMA public TO runtime_app;

-- ---------------------------------------------------------------------------
-- Tables de contenu : propriétaire seul (lecture et écriture), 404 uniforme côté service.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'apis', 'strategy_versions', 'runs', 'run_attempts', 'run_logs', 'run_artifacts', 'investigation_events',
    'status_events', 'datasets', 'dataset_items', 'dedup_keys', 'schedules', 'site_sessions', 'tunnels',
    'tunnel_jobs', 'webhook_subscriptions', 'webhook_deliveries', 'secrets'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY owner_isolation ON %I FOR ALL TO runtime_app USING (owner_id = app_current_user_id()) WITH CHECK (owner_id = app_current_user_id())',
      t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO runtime_app', t);
  END LOOP;
END
$$;

-- Catalogue partagé (13 § 3) : une API sans session en visibilité `instance` est lisible par les autres membres,
-- avec ses versions de stratégie. Écriture : propriétaire seul (politique owner_isolation).
CREATE POLICY instance_read ON apis FOR SELECT TO runtime_app
  USING (app_current_user_id() IS NOT NULL AND visibility = 'instance' AND NOT requires_session);
CREATE POLICY instance_read ON strategy_versions FOR SELECT TO runtime_app
  USING (app_current_user_id() IS NOT NULL AND EXISTS (SELECT 1 FROM apis a WHERE a.id = strategy_versions.api_id AND a.visibility = 'instance' AND NOT a.requires_session));

-- Clés d'API : les siennes seulement ; pas de DELETE (la révocation pose revoked_at, 13 § 8).
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON api_keys FOR ALL TO runtime_app
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
GRANT SELECT, INSERT ON api_keys TO runtime_app;
GRANT UPDATE (revoked_at, revoked_by, last_used_at) ON api_keys TO runtime_app;

-- Journal d'audit en ajout seul (assert_audit_append_only) : ni SELECT, ni UPDATE, ni DELETE, ni TRUNCATE.
GRANT INSERT ON audit_events TO runtime_app;

-- ---------------------------------------------------------------------------
-- Vues d'administration (INV5) : métadonnées seulement. Elles s'exécutent avec les droits de leur propriétaire
-- (hors RLS) ; le filtre réserve toutes les lignes à `app.role` admin ou owner, les autres ne voient que les leurs.
-- ---------------------------------------------------------------------------
DROP VIEW admin_run_metadata;
CREATE VIEW admin_run_metadata WITH (security_barrier) AS
  SELECT id, api_id, owner_id, project_id, trigger, state, outcome, failure_class, cost_llm_usd, cost_proxy_usd,
         duration_ms, items, created_at, finished_at
  FROM runs
  WHERE current_setting('app.role', true) IN ('admin', 'owner') OR owner_id = app_current_user_id();

DROP VIEW admin_dataset_usage;
CREATE VIEW admin_dataset_usage WITH (security_barrier) AS
  SELECT id, api_id, owner_id, project_id, item_count, bytes, pinned, created_at, expires_at, deleted_at
  FROM datasets
  WHERE current_setting('app.role', true) IN ('admin', 'owner') OR owner_id = app_current_user_id();

GRANT SELECT ON admin_run_metadata, admin_dataset_usage TO runtime_app;
