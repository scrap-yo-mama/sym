-- SPDX-License-Identifier: AGPL-3.0-only
-- 0021_investigation_briefs (tâche 2.14, 19c § 4 et § 9.2 ; migration couverte par D-48, garde-fou de 10) :
--   api_briefs           historique des versions du dossier d'enquête d'une API : contenu MASQUÉ et normalisé, empreinte,
--                        taille ; immuable, sauf effacement d'une personne (erased_at : contenu réécrit sans elle,
--                        empreinte recalculée) et réduction des échantillons à leur empreinte (samples_purged_at,
--                        RETENTION_SAMPLES_DAYS) ; au plus BRIEF_VERSIONS_KEEP versions par API (purge du code) ;
--   brief_hint_outcomes  faits du CODE par clé d'identité d'indice (sha256 du type et de la valeur canonique) : état,
--                        raison, sonde (jamais de corps de réponse), péremption, dernière sonde réussie ; ils survivent au
--                        remplacement du dossier.
-- Les deux tables sous RLS `owner_id` (INV12), propriétaire = propriétaire de l'API (trigger), purgées avec l'API
-- (ON DELETE CASCADE). `strategy_versions.source.brief` (0019, jsonb) porte la version consultée.
CREATE TABLE api_briefs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  api_id uuid NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users (id),
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  brief_version integer NOT NULL CHECK (brief_version >= 1),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 0 AND 32000),
  -- Indices dont une valeur figurait dans subject_exclusions (brief_subject_excluded) : identifiants seulement.
  subject_excluded text[] NOT NULL DEFAULT '{}' CHECK (cardinality(subject_excluded) <= 20),
  author_id uuid REFERENCES users (id) ON DELETE SET NULL,
  via text NOT NULL CHECK (via IN ('mcp', 'rest', 'console')),
  erased_at timestamptz,
  samples_purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (api_id, brief_version)
);
-- Même contenu renvoyé : pas de nouvelle version (une version réécrite par l'effacement ne bloque plus personne).
CREATE UNIQUE INDEX api_briefs_api_sha_idx ON api_briefs (api_id, content_sha256) WHERE erased_at IS NULL;
CREATE INDEX api_briefs_owner_id_idx ON api_briefs (owner_id);
CREATE INDEX api_briefs_created_at_idx ON api_briefs (created_at) WHERE samples_purged_at IS NULL;

CREATE FUNCTION api_briefs_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Le dossier appartient au propriétaire de l'API (aucune ligne chez un autre utilisateur, même par le rôle de service).
    IF NOT EXISTS (SELECT 1 FROM apis a WHERE a.id = NEW.api_id AND a.owner_id = NEW.owner_id) THEN
      RAISE EXCEPTION 'dossier : owner_id doit être le propriétaire de l''API'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'api_briefs_owner_bound';
    END IF;
    RETURN NEW;
  END IF;
  -- Immuable : identité jamais changée ; contenu réécrit seulement par l'effacement d'une personne ou la purge des échantillons.
  IF NEW.api_id IS DISTINCT FROM OLD.api_id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.brief_version IS DISTINCT FROM OLD.brief_version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.via IS DISTINCT FROM OLD.via THEN
    RAISE EXCEPTION 'dossier : version immuable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'api_briefs_immutable';
  END IF;
  IF (NEW.content IS DISTINCT FROM OLD.content OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256)
     AND NEW.erased_at IS NULL AND NEW.samples_purged_at IS NOT DISTINCT FROM OLD.samples_purged_at THEN
    RAISE EXCEPTION 'dossier : contenu réécrit seulement par un effacement ou la purge des échantillons'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'api_briefs_immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER api_briefs_guard
  BEFORE INSERT OR UPDATE ON api_briefs
  FOR EACH ROW EXECUTE FUNCTION api_briefs_guard();

ALTER TABLE api_briefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON api_briefs FOR ALL TO runtime_app
  USING (owner_id = app_current_user_id()) WITH CHECK (owner_id = app_current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON api_briefs TO runtime_app;

CREATE TABLE brief_hint_outcomes (
  api_id uuid NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users (id),
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  identity_key text NOT NULL CHECK (identity_key ~ '^[0-9a-f]{64}$'),
  brief_version integer NOT NULL CHECK (brief_version >= 1),
  hint_id text NOT NULL CHECK (hint_id ~ '^[a-z0-9_-]{1,16}$'),
  kind text NOT NULL CHECK (kind IN ('endpoint', 'embedded_data', 'selector', 'pagination', 'example_url', 'pitfall')),
  state text NOT NULL CHECK (state IN ('used', 'verified_unused', 'probe_failed', 'ignored')),
  reason text CHECK (reason IS NULL OR reason ~ '^brief_[a-z_]{1,40}$'),
  -- Sonde : date, classe HTTP, items conformes, durée, coût ; JAMAIS de corps de réponse.
  probe jsonb CHECK (probe IS NULL OR (jsonb_typeof(probe) = 'object' AND NOT probe ? 'body')),
  stale boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  probed_at timestamptz,
  last_ok_at timestamptz,
  -- Jour du dernier événement de preuve brief_hint_verified (un par clé et par jour, 19c § 6).
  verified_event_day date,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_id, identity_key)
);
CREATE INDEX brief_hint_outcomes_owner_id_idx ON brief_hint_outcomes (owner_id);

CREATE FUNCTION brief_hint_outcomes_owner_bound() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM apis a WHERE a.id = NEW.api_id AND a.owner_id = NEW.owner_id) THEN
    RAISE EXCEPTION 'faits du dossier : owner_id doit être le propriétaire de l''API'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'brief_hint_outcomes_owner_bound';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER brief_hint_outcomes_owner_bound
  BEFORE INSERT OR UPDATE OF api_id, owner_id ON brief_hint_outcomes
  FOR EACH ROW EXECUTE FUNCTION brief_hint_outcomes_owner_bound();

ALTER TABLE brief_hint_outcomes ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON brief_hint_outcomes FOR ALL TO runtime_app
  USING (owner_id = app_current_user_id()) WITH CHECK (owner_id = app_current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON brief_hint_outcomes TO runtime_app;
