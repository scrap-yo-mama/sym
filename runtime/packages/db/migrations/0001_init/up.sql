-- SPDX-License-Identifier: AGPL-3.0-only
-- 0001_init : schéma v3 (cdc/scrapyomama-runtime/03 § Schéma PostgreSQL, 13 § 12, 14 § 9-10, 17 § 4 et 6).
-- Écrit à la main. Appliqué par le runner (packages/db/src/migrate.ts) dans une transaction, sous pg_advisory_lock.
-- Énumérations : text + CHECK (pas de type ENUM : évolution par migration simple, sans ALTER TYPE).
-- RLS : activée à la tâche 0.3b. pg-boss crée et gère seul son schéma `pgboss`.

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- Projets (un seul « default » en V1) et réglages d'instance
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO projects (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'default');

CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Utilisateurs et authentification (13 § 12 ; colonnes exigées par Better Auth 1.7, voir README)
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  display_name text NOT NULL DEFAULT '',
  email_verified boolean NOT NULL DEFAULT false,
  email_verified_at timestamptz,
  image text,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'fr')),
  theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('light', 'dark', 'system')),
  two_factor_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  last_login_at timestamptz
);
-- Un seul owner (13 § 2).
CREATE UNIQUE INDEX users_single_owner ON users (role) WHERE role = 'owner';

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz,
  ip text,
  user_agent text,
  revoked_at timestamptz
);
CREATE INDEX auth_sessions_user_id_idx ON auth_sessions (user_id);

CREATE TABLE auth_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  account_id text NOT NULL,
  password_hash text,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_accounts_provider_account_key UNIQUE (provider_id, account_id)
);
CREATE INDEX auth_accounts_user_id_idx ON auth_accounts (user_id);

CREATE TABLE verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verifications_identifier_idx ON verifications (identifier);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL,
  role text NOT NULL CHECK (role IN ('member', 'admin')),
  invited_by uuid REFERENCES users (id) ON DELETE SET NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_email_idx ON invitations (email);

CREATE TABLE two_factor (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  secret_ciphertext text NOT NULL,
  backup_codes text,
  nonce text,
  key_version integer,
  verified boolean NOT NULL DEFAULT true,
  failed_verification_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE backup_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_codes_user_code_key UNIQUE (user_id, code_hash)
);

-- Clés d'API à scopes (13 § 8) : scopes limités en base aux scopes accordables.
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label text NOT NULL,
  prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT api_keys_scopes_grantable CHECK (
    scopes <@ ARRAY['apis:read', 'apis:run', 'apis:write', 'runs:read', 'datasets:read', 'schedules:write', 'sites:read']::text[]
  )
);
CREATE INDEX api_keys_user_id_idx ON api_keys (user_id);

-- Journal d'audit, ajout seul (droits posés en 0.3b). actor_user_id sans clé étrangère : l'audit garde l'identifiant après suppression.
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  actor_via text NOT NULL CHECK (actor_via IN ('ui', 'apikey', 'mcp', 'sso', 'system')),
  actor_ref text,
  action text NOT NULL,
  target_type text,
  target_id text,
  outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
  ip text,
  user_agent text,
  meta jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_at_idx ON audit_events (at);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_user_id, at);

-- Conformité (17 § 6-7)
CREATE TABLE subject_exclusions (
  subject_hash text PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE responsible_use_acks (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  version text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, version)
);

-- ---------------------------------------------------------------------------
-- Secrets chiffrés (INV8). owner_id NULL = secret d'instance (LLM, proxys, SMTP).
-- ---------------------------------------------------------------------------
CREATE TABLE secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES users (id) ON DELETE CASCADE,
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  kind text NOT NULL,
  label text NOT NULL,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  aad bytea NOT NULL,
  alg text NOT NULL DEFAULT 'aes-256-gcm',
  dek_wrapped bytea NOT NULL,
  kek_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX secrets_owner_id_idx ON secrets (owner_id);

-- ---------------------------------------------------------------------------
-- Catalogue (04b § 1)
-- ---------------------------------------------------------------------------
CREATE TABLE apis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  owner_id uuid NOT NULL REFERENCES users (id),
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'instance')),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  input_schema jsonb NOT NULL DEFAULT '{}',
  output_schema jsonb NOT NULL DEFAULT '{}',
  views jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'enquete'
    CHECK (status IN ('enquete', 'sain', 'warning', 'reparation', 'erreur', 'action_requise', 'bloquee')),
  investigation_phase text
    CHECK (investigation_phase IN ('access_check', 'reconnaissance', 'awaiting_schema_validation', 'testing', 'done')),
  status_reason text,
  stale boolean NOT NULL DEFAULT false,
  clean_streak integer NOT NULL DEFAULT 0,
  last_signal_at timestamptz,
  current_strategy_version integer,
  requires jsonb NOT NULL DEFAULT '{}',
  requires_session boolean NOT NULL DEFAULT false,
  network_policy jsonb NOT NULL DEFAULT '{"allow": ["direct"]}',
  access_policy jsonb NOT NULL
    DEFAULT '{"robots": "respect", "on_ai_signal": "warn", "intended_use": "context", "prefer_official": true, "payment": {"mode": "never"}}',
  domain_pacing jsonb NOT NULL DEFAULT '{"min_delay_ms": 1500, "max_requests_per_run": 200, "max_wait_ms": 60000}',
  purpose text NOT NULL DEFAULT '',
  legal_basis text,
  contains_personal_data boolean NOT NULL DEFAULT false,
  allow_write_actions boolean NOT NULL DEFAULT false,
  max_cost_usd numeric(12, 6) NOT NULL DEFAULT 0.5,
  budget_daily_usd numeric(12, 6) NOT NULL DEFAULT 5,
  mcp_exposed boolean NOT NULL DEFAULT true,
  pinned boolean NOT NULL DEFAULT false,
  repair_lease_owner text,
  repair_lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT apis_project_slug_key UNIQUE (project_id, slug),
  -- 13 § 12 : une API à session reste privée.
  CONSTRAINT apis_session_private CHECK (NOT requires_session OR visibility = 'private'),
  -- INV11 (17 § 4) : `robots` n'a qu'une valeur ; paiement jamais en V1.
  CONSTRAINT apis_access_policy_robots CHECK (access_policy ->> 'robots' = 'respect'),
  CONSTRAINT apis_access_policy_payment CHECK (coalesce(access_policy #>> '{payment,mode}', 'never') = 'never')
);
CREATE INDEX apis_owner_id_idx ON apis (owner_id);

CREATE TABLE strategy_versions (
  api_id uuid NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  version integer NOT NULL,
  owner_id uuid NOT NULL REFERENCES users (id),
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  execution text NOT NULL
    CHECK (execution IN ('fetch', 'fetch_in_page', 'playwright', 'agent_fetch', 'hybrid', 'agent')),
  network text NOT NULL CHECK (network IN ('direct', 'dc_proxy', 'res_proxy', 'tunnel')),
  spec jsonb NOT NULL DEFAULT '{}',
  script_ref text,
  est_cost_usd numeric(12, 6),
  created_by text NOT NULL CHECK (created_by IN ('investigation', 'repair', 'user', 'revert', 'import')),
  parent_version integer,
  patch jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_id, version)
);
CREATE INDEX strategy_versions_owner_id_idx ON strategy_versions (owner_id);

-- ---------------------------------------------------------------------------
-- Exécutions
-- ---------------------------------------------------------------------------
CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_id uuid NOT NULL REFERENCES apis (id),
  owner_id uuid NOT NULL REFERENCES users (id),
  api_owner_id uuid NOT NULL REFERENCES users (id),
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  strategy_version integer,
  trigger text NOT NULL CHECK (trigger IN ('mcp', 'rest', 'schedule', 'ui', 'canary')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued', 'running', 'waiting_tunnel', 'succeeded', 'failed', 'cancelled', 'skipped_tunnel_offline',
    'skipped_window', 'skipped_quota', 'skipped_status', 'skipped_overlap')),
  outcome text CHECK (outcome IN ('clean', 'degraded', 'failed')),
  degraded_reasons text[] NOT NULL DEFAULT '{}',
  input jsonb,
  cost_llm_usd numeric(12, 6) NOT NULL DEFAULT 0,
  cost_proxy_usd numeric(12, 6) NOT NULL DEFAULT 0,
  tokens_in bigint NOT NULL DEFAULT 0,
  tokens_cached bigint NOT NULL DEFAULT 0,
  tokens_out bigint NOT NULL DEFAULT 0,
  tokens_reasoning bigint NOT NULL DEFAULT 0,
  usage_estimated boolean NOT NULL DEFAULT false,
  items integer NOT NULL DEFAULT 0,
  dataset_id uuid,
  duration_ms integer,
  failure_class text CHECK (failure_class IN (
    'transient', 'network', 'rate_limited', 'forbidden', 'blocked_by_protection', 'robots_disallowed',
    'robots_unreachable', 'payment_required', 'auth_required', 'account_limit', 'not_found', 'extraction',
    'code_error', 'run_budget_exceeded', 'budget_exceeded') OR failure_class ~ '^llm_[a-z0-9_]+$'),
  retryable boolean,
  error_detail text,
  trace_id text,
  heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX runs_owner_id_idx ON runs (owner_id);
CREATE INDEX runs_api_created_idx ON runs (api_id, created_at DESC);
CREATE INDEX runs_active_idx ON runs (state, heartbeat_at) WHERE state IN ('queued', 'running', 'waiting_tunnel');

CREATE TABLE run_attempts (
  run_id uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  seq integer NOT NULL,
  owner_id uuid NOT NULL REFERENCES users (id),
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  execution text NOT NULL
    CHECK (execution IN ('fetch', 'fetch_in_page', 'playwright', 'agent_fetch', 'hybrid', 'agent')),
  network text NOT NULL CHECK (network IN ('direct', 'dc_proxy', 'res_proxy', 'tunnel')),
  result_class text,
  est_cost_usd numeric(12, 6),
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  ms integer,
  model_id text,
  prompt_version text,
  engine text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX run_attempts_owner_id_idx ON run_attempts (owner_id);

CREATE TABLE run_logs (
  run_id uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  seq integer NOT NULL,
  owner_id uuid NOT NULL REFERENCES users (id),
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  ts timestamptz NOT NULL DEFAULT now(),
  level text NOT NULL CHECK (level IN ('trace', 'debug', 'info', 'warn', 'error', 'fatal')),
  event text NOT NULL,
  data jsonb,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX run_logs_owner_id_idx ON run_logs (owner_id);
CREATE INDEX run_logs_ts_idx ON run_logs (ts);

CREATE TABLE run_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users (id),
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  kind text NOT NULL CHECK (kind IN ('screenshot', 'trace', 'har')),
  bytes integer NOT NULL,
  sensitivity text NOT NULL,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  key_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX run_artifacts_owner_id_idx ON run_artifacts (owner_id);
CREATE INDEX run_artifacts_run_id_idx ON run_artifacts (run_id);

CREATE TABLE investigation_events (
  run_id uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  seq integer NOT NULL,
  owner_id uuid NOT NULL REFERENCES users (id),
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX investigation_events_owner_id_idx ON investigation_events (owner_id);

-- Transitions de statut (INV3). from/to sont des mots réservés : from_status / to_status.
CREATE TABLE status_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  api_id uuid NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users (id),
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  from_status text,
  to_status text NOT NULL,
  reason text,
  run_id uuid REFERENCES runs (id) ON DELETE SET NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX status_events_api_at_idx ON status_events (api_id, at);
CREATE INDEX status_events_owner_id_idx ON status_events (owner_id);

-- ---------------------------------------------------------------------------
-- Résultats (14 § 9) : dataset_items partitionnée par mois sur created_at
-- ---------------------------------------------------------------------------
CREATE TABLE datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_id uuid NOT NULL REFERENCES apis (id),
  run_id uuid REFERENCES runs (id) ON DELETE SET NULL,
  owner_id uuid NOT NULL REFERENCES users (id),
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  item_count integer NOT NULL DEFAULT 0,
  bytes bigint NOT NULL DEFAULT 0,
  retention_days integer,
  pinned boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX datasets_owner_id_idx ON datasets (owner_id);
CREATE INDEX datasets_expires_idx ON datasets (expires_at) WHERE deleted_at IS NULL AND NOT pinned;

CREATE TABLE dataset_items (
  created_at timestamptz NOT NULL DEFAULT now(),
  dataset_id uuid NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  seq integer NOT NULL,
  run_id uuid,
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  item jsonb NOT NULL,
  size_bytes integer NOT NULL,
  dedup_key text,
  PRIMARY KEY (created_at, dataset_id, seq)
) PARTITION BY RANGE (created_at);
CREATE INDEX dataset_items_dataset_seq_idx ON dataset_items (dataset_id, seq);
CREATE INDEX dataset_items_owner_id_idx ON dataset_items (owner_id);

-- Déduplication entre partitions (table non partitionnée).
CREATE TABLE dedup_keys (
  api_id uuid NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  key_hash text NOT NULL,
  owner_id uuid NOT NULL REFERENCES users (id),
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  last_seen timestamptz NOT NULL DEFAULT now(),
  last_run_id uuid,
  PRIMARY KEY (api_id, key_hash)
);
CREATE INDEX dedup_keys_owner_id_idx ON dedup_keys (owner_id);
CREATE INDEX dedup_keys_last_seen_idx ON dedup_keys (last_seen);

-- Crée les partitions mensuelles de dataset_items de p_at à p_at + p_months - 1 mois (défaut : mois courant et suivant).
-- Idempotente. Renvoie le nom des partitions créées. Appelée par la tâche quotidienne ensure_partitions.
CREATE FUNCTION ensure_dataset_items_partitions(p_at timestamptz DEFAULT now(), p_months integer DEFAULT 2)
RETURNS SETOF text
LANGUAGE plpgsql
AS $$
DECLARE
  month_utc timestamp; -- calcul en UTC sans fuseau : bornes exactes quel que soit le TimeZone de la session
  part_name text;
BEGIN
  FOR i IN 0 .. p_months - 1 LOOP
    month_utc := date_trunc('month', p_at AT TIME ZONE 'UTC') + make_interval(months => i);
    part_name := 'dataset_items_p' || to_char(month_utc, 'YYYYMM');
    IF to_regclass(format('public.%I', part_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.dataset_items FOR VALUES FROM (%L) TO (%L)',
        part_name, month_utc AT TIME ZONE 'UTC', (month_utc + interval '1 month') AT TIME ZONE 'UTC');
      RETURN NEXT part_name;
    END IF;
  END LOOP;
END;
$$;

SELECT ensure_dataset_items_partitions();

-- ---------------------------------------------------------------------------
-- Planification, cadence, sessions de sites, tunnel, webhooks
-- ---------------------------------------------------------------------------
CREATE TABLE schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_id uuid NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users (id),
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  cron text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  input jsonb NOT NULL DEFAULT '{}',
  rules jsonb NOT NULL DEFAULT '{}',
  overlap text NOT NULL DEFAULT 'skip',
  on_missed text NOT NULL DEFAULT 'skip',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX schedules_owner_id_idx ON schedules (owner_id);
CREATE INDEX schedules_api_id_idx ON schedules (api_id);

-- Clé = domaine seulement (assert_pacing_key_is_domain) : ni owner_id ni project_id, par construction.
CREATE TABLE domain_pacing_state (
  domain text PRIMARY KEY,
  next_slot_at timestamptz NOT NULL DEFAULT now(),
  circuit_state text NOT NULL DEFAULT 'closed' CHECK (circuit_state IN ('closed', 'open', 'half_open')),
  circuit_opened_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE site_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  domain text NOT NULL,
  server_use_allowed boolean NOT NULL DEFAULT false,
  ciphertext bytea,
  nonce bytea,
  key_version integer,
  captured_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_sessions_owner_domain_key UNIQUE (owner_id, domain),
  -- INV5 : des cookies ne sont stockés côté serveur que si l'utilisateur l'a autorisé.
  CONSTRAINT site_sessions_server_use CHECK (server_use_allowed OR ciphertext IS NULL)
);

CREATE TABLE tunnels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  device_id text NOT NULL,
  device_label text,
  token_hash text NOT NULL UNIQUE,
  gateway_instance text,
  conn_epoch bigint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tunnels_owner_id_idx ON tunnels (owner_id);

CREATE TABLE tunnel_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  tunnel_id uuid REFERENCES tunnels (id) ON DELETE SET NULL,
  owner_id uuid NOT NULL REFERENCES users (id),
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  payload jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'pending',
  trace jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tunnel_jobs_owner_id_idx ON tunnel_jobs (owner_id);
CREATE INDEX tunnel_jobs_run_id_idx ON tunnel_jobs (run_id);

CREATE TABLE worker_heartbeats (
  worker_id text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  version text NOT NULL,
  browser_contexts integer NOT NULL DEFAULT 0,
  rss_mb integer,
  draining boolean NOT NULL DEFAULT false
);

CREATE TABLE webhook_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  url text NOT NULL,
  events text[] NOT NULL DEFAULT '{}',
  secret_id uuid REFERENCES secrets (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_subscriptions_owner_id_idx ON webhook_subscriptions (owner_id);

CREATE TABLE webhook_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES webhook_subscriptions (id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users (id),
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  event text NOT NULL,
  dispatch_id uuid NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  http_status integer,
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_deliveries_dispatch_attempt_key UNIQUE (dispatch_id, attempt)
);
CREATE INDEX webhook_deliveries_owner_id_idx ON webhook_deliveries (owner_id);

-- ---------------------------------------------------------------------------
-- Vues d'administration : métadonnées seulement, aucune colonne de contenu (INV5, 13 § 3)
-- ---------------------------------------------------------------------------
CREATE VIEW admin_run_metadata AS
  SELECT id, api_id, owner_id, project_id, trigger, state, outcome, failure_class, cost_llm_usd, cost_proxy_usd,
         duration_ms, items, created_at, finished_at
  FROM runs;

CREATE VIEW admin_dataset_usage AS
  SELECT id, api_id, owner_id, project_id, item_count, bytes, pinned, created_at, expires_at, deleted_at
  FROM datasets;
