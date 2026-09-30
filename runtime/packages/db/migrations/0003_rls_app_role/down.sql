-- Retour de 0003_rls_app_role. Le rôle runtime_app (objet du cluster) est conservé ; ses droits dans cette base sont retirés.
DROP VIEW admin_run_metadata;
CREATE VIEW admin_run_metadata AS
  SELECT id, api_id, owner_id, project_id, trigger, state, outcome, failure_class, cost_llm_usd, cost_proxy_usd,
         duration_ms, items, created_at, finished_at
  FROM runs;

DROP VIEW admin_dataset_usage;
CREATE VIEW admin_dataset_usage AS
  SELECT id, api_id, owner_id, project_id, item_count, bytes, pinned, created_at, expires_at, deleted_at
  FROM datasets;

DROP POLICY instance_read ON apis;
DROP POLICY instance_read ON strategy_versions;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'apis', 'strategy_versions', 'runs', 'run_attempts', 'run_logs', 'run_artifacts', 'investigation_events',
    'status_events', 'datasets', 'dataset_items', 'dedup_keys', 'schedules', 'site_sessions', 'tunnels',
    'tunnel_jobs', 'webhook_subscriptions', 'webhook_deliveries', 'secrets', 'api_keys'
  ] LOOP
    EXECUTE format('DROP POLICY owner_isolation ON %I', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM runtime_app;
REVOKE ALL ON SCHEMA public FROM runtime_app;
DROP FUNCTION app_current_user_id();
