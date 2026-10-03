-- SPDX-License-Identifier: AGPL-3.0-only
-- 0001_schema : modèle de données de SYM Browser (cdc/sym-browser 03 § 5 ; états 04 § 5 ; nœuds 04b § 5 ; profils 04c § 4 ;
-- comptage 04d § 4). Écrit à la main, appliqué par src/migrate.ts dans une transaction, sous pg_advisory_lock.
-- PostgreSQL 16 à 18, aucune extension (gen_random_uuid est dans le noyau depuis la 13).
-- Énumérations : text + CHECK (pas de type ENUM : évolution par migration simple, sans ALTER TYPE).
-- Isolation par client (BINV1, BINV7) : les clés étrangères composites (id, tenant_id) interdisent à une session de pointer
-- la clé d'API, le profil ou le comptage d'un autre client, même par une requête SQL directe.
-- Rien n'est supprimé en silence : un client, une clé, un nœud ou une session comptée référencés par ailleurs ne se
-- suppriment pas (ON DELETE RESTRICT, par défaut) ; seuls les événements et les artefacts suivent leur session.

-- ---------------------------------------------------------------------------
-- Clients et clés
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> '') UNIQUE,
  -- Quotas (04d § 4.2) ; 0 = rien d'autorisé. Valeurs par défaut prudentes, l'admin les règle par client.
  max_concurrent_sessions integer NOT NULL DEFAULT 2 CHECK (max_concurrent_sessions >= 0),
  monthly_minutes bigint NOT NULL DEFAULT 600 CHECK (monthly_minutes >= 0),
  monthly_bytes bigint NOT NULL DEFAULT 10737418240 CHECK (monthly_bytes >= 0),
  max_session_seconds integer NOT NULL DEFAULT 3600 CHECK (max_session_seconds > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  -- Préfixe affiché (recherche de la clé à l'authentification) ; l'empreinte argon2 est la seule trace du secret.
  key_prefix text NOT NULL CHECK (btrim(key_prefix) <> '') UNIQUE,
  key_hash text NOT NULL CHECK (btrim(key_hash) <> ''),
  scopes text[] NOT NULL
    CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['sessions:write', 'sessions:read', 'profiles:write', 'admin']::text[]),
  expires_at timestamptz,
  last_used_at timestamptz,
  -- Révoquer ne supprime pas : la clé reste référencée par les sessions et le comptage.
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);
CREATE INDEX api_keys_tenant_idx ON api_keys (tenant_id);

-- ---------------------------------------------------------------------------
-- Nœuds (enregistrement et battement, 04b § 5)
-- ---------------------------------------------------------------------------
CREATE TABLE nodes (
  id text PRIMARY KEY CHECK (btrim(id) <> ''), -- NODE_ID ou nom d'hôte, stable entre redémarrages
  url text NOT NULL, -- URL privée, joignable par la passerelle
  region text NOT NULL DEFAULT 'default' CHECK (btrim(region) <> ''),
  playwright_version text NOT NULL,
  chromium_version text NOT NULL,
  app_version text NOT NULL,
  slots_total integer NOT NULL CHECK (slots_total >= 0),
  slots_free integer NOT NULL CHECK (slots_free >= 0 AND slots_free <= slots_total),
  rss_bytes bigint CHECK (rss_bytes >= 0),
  limit_bytes bigint CHECK (limit_bytes >= 0),
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'draining', 'down')),
  -- Horloge de la base : le balayeur déclare `down` un nœud muet depuis plus de 15 s (04b § 6).
  last_beat_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nodes_state_region_idx ON nodes (state, region);

-- ---------------------------------------------------------------------------
-- Profils persistants et profils de proxy (04c)
-- ---------------------------------------------------------------------------
CREATE TABLE profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL CHECK (btrim(name) <> ''),
  -- Clé de l'objet chiffré de la dernière version ; NULL tant que le profil est vide (version 0).
  object_key text,
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  -- Verrou d'écriture exclusif (04c § 4.2) ; la clé étrangère vers sessions est posée plus bas (référence circulaire).
  lock_session_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((version = 0) = (object_key IS NULL)),
  UNIQUE (tenant_id, name),
  UNIQUE (id, tenant_id)
);

CREATE TABLE proxy_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL CHECK (btrim(name) <> ''),
  type text NOT NULL CHECK (type IN ('http', 'https', 'socks5')),
  kind text CHECK (kind IN ('isp', 'datacenter', 'enterprise')), -- informatif (04c § 2.2)
  host text NOT NULL CHECK (btrim(host) <> ''),
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  -- Utilisateur et mot de passe, scellés ensemble par l'enveloppe AES-256-GCM (AAD tenantId|profileId, tâche 0.3) ;
  -- le format sérialisé est celui de packages/core, d'où le type text. Jamais de clair en base (BINV6).
  credentials_encrypted text,
  dns_via_proxy boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- ---------------------------------------------------------------------------
-- Sessions (04 § 3 à 5)
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- réservable par l'appelant ; doublon : 409 session_id_taken
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  api_key_id uuid NOT NULL,
  node_id text REFERENCES nodes (id), -- NULL tant que la session attend un slot ; table de routage (AD4)
  type text NOT NULL CHECK (type IN ('dedicated', 'shared')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'ended', 'timed_out', 'failed')),
  end_reason text CHECK (end_reason IN
    ('released', 'timeout', 'idle', 'budget_exceeded', 'node_shutdown', 'crash', 'node_lost', 'quota')),
  region text, -- région demandée (aucune : toutes)
  slot_weight integer NOT NULL DEFAULT 1 CHECK (slot_weight > 0),
  options jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(options) = 'object'), -- options validées à la création (secrets chiffrés)
  egress_policy jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(egress_policy) = 'object'),
  profile_id uuid,
  profile_mode text CHECK (profile_mode IN ('read', 'write')),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'), -- 16 clés, valeurs ≤ 512 caractères : validé par l'API
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  expires_at timestamptz NOT NULL, -- fin au plus tard, prolongations incluses
  UNIQUE (id, tenant_id),
  FOREIGN KEY (api_key_id, tenant_id) REFERENCES api_keys (id, tenant_id),
  FOREIGN KEY (profile_id, tenant_id) REFERENCES profiles (id, tenant_id),
  -- Un profil implique le mode d'accès, et une session dedicated (04 § 3).
  CHECK ((profile_id IS NULL) = (profile_mode IS NULL)),
  CHECK (profile_id IS NULL OR type = 'dedicated'),
  -- Machine à états (04 § 5) : un état terminal porte sa raison et sa date de fin, les autres n'en ont pas.
  CHECK ((state IN ('ended', 'timed_out', 'failed')) = (ended_at IS NOT NULL)),
  CHECK ((state IN ('ended', 'timed_out', 'failed')) = (end_reason IS NOT NULL)),
  CHECK (
    end_reason IS NULL
    OR (state = 'ended' AND end_reason IN ('released', 'budget_exceeded', 'node_shutdown', 'quota'))
    OR (state = 'timed_out' AND end_reason IN ('timeout', 'idle'))
    OR (state = 'failed' AND end_reason IN ('crash', 'node_lost', 'quota'))
  ),
  CHECK (state <> 'pending' OR started_at IS NULL),
  CHECK (state <> 'running' OR started_at IS NOT NULL),
  CHECK (started_at IS NULL OR ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX sessions_tenant_created_idx ON sessions (tenant_id, created_at DESC);
CREATE INDEX sessions_node_idx ON sessions (node_id) WHERE state IN ('pending', 'running');
CREATE INDEX sessions_active_tenant_idx ON sessions (tenant_id) WHERE state IN ('pending', 'running');
CREATE INDEX sessions_running_expiry_idx ON sessions (expires_at) WHERE state = 'running';
CREATE INDEX sessions_profile_idx ON sessions (profile_id) WHERE profile_id IS NOT NULL;
CREATE INDEX sessions_metadata_idx ON sessions USING gin (metadata jsonb_path_ops);

ALTER TABLE profiles
  ADD CONSTRAINT profiles_lock_session_fk FOREIGN KEY (lock_session_id) REFERENCES sessions (id) ON DELETE SET NULL;
CREATE INDEX profiles_lock_session_idx ON profiles (lock_session_id) WHERE lock_session_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Événements, artefacts, comptage
-- ---------------------------------------------------------------------------
CREATE TABLE session_events (
  -- Identifiant croissant : ordre total des événements d'une session (reprise SSE par Last-Event-ID).
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL CHECK (type IN
    ('state', 'egress.blocked', 'egress.budget_exceeded', 'download', 'recording.ready', 'recording.truncated',
     'profile.save_failed', 'storage_state.exported', 'live.input')),
  data jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX session_events_session_idx ON session_events (session_id, id);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('trace', 'har', 'video', 'console', 'network', 'download')),
  name text, -- nom nettoyé d'un téléchargement (04c § 5.1)
  object_key text NOT NULL CHECK (btrim(object_key) <> ''),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX artifacts_session_idx ON artifacts (session_id);
CREATE INDEX artifacts_expires_idx ON artifacts (expires_at);

CREATE TABLE usage_records (
  -- Une ligne par session, écriture idempotente (ON CONFLICT) dans la transaction de l'état final (04d § 4.1).
  session_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  api_key_id uuid NOT NULL,
  node_id text NOT NULL REFERENCES nodes (id),
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  browser_ms bigint NOT NULL CHECK (browser_ms >= 0),
  -- BINV5 : secondes facturées = ceil(durée / 1000), garanti par la base et non par chaque écrivain.
  billed_seconds bigint NOT NULL CHECK (billed_seconds >= 0),
  bytes_in bigint NOT NULL DEFAULT 0 CHECK (bytes_in >= 0),
  bytes_out bigint NOT NULL DEFAULT 0 CHECK (bytes_out >= 0),
  source text NOT NULL CHECK (source IN ('node', 'reconstructed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (billed_seconds = (browser_ms + 999) / 1000),
  CHECK (ended_at >= started_at),
  FOREIGN KEY (session_id, tenant_id) REFERENCES sessions (id, tenant_id),
  FOREIGN KEY (api_key_id, tenant_id) REFERENCES api_keys (id, tenant_id)
);
CREATE INDEX usage_records_tenant_ended_idx ON usage_records (tenant_id, ended_at);
CREATE INDEX usage_records_key_ended_idx ON usage_records (api_key_id, ended_at);
