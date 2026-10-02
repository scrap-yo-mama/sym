-- SPDX-License-Identifier: AGPL-3.0-only
-- 0018_catalog_memory_quality (tâche 2.12, 19 §2 et §3, 19b §1 ; migration validée par l'arbitrage du 2026-10-01) :
--   strategy_versions.signature     signature calculée par le code à la reconnaissance (sans LLM, sans texte du site) ;
--   strategy_versions.source        source de la version (retours `feedback[]`, intentions `steps[]`, 19b §1) : ajoutée ici
--                                   si 2.10 ne l'a pas déjà posée (IF NOT EXISTS) ; lue par la mémoire du catalogue ;
--   runs.quality, runs.judge        fiche de qualité du run et avis CONSULTATIF du juge (ne change jamais un statut) ;
--   run_profiles                    profil de chaque run, après Ajv et la garde de classification ; baseline validée
--                                   par l'utilisateur seul ; purgé avec RETENTION_PROFILES_DAYS, sauf la baseline ;
--   strategy_version_memory_refs    entrées de mémoire consultées par une version, avec le sha256 du dossier.
-- Toutes sous RLS `owner_id` (INV12), purgées avec l'API (ON DELETE CASCADE).
ALTER TABLE strategy_versions ADD COLUMN IF NOT EXISTS source jsonb NOT NULL DEFAULT '{}';
ALTER TABLE strategy_versions ADD COLUMN signature jsonb CHECK (signature IS NULL OR jsonb_typeof(signature) = 'object');
ALTER TABLE runs ADD COLUMN quality jsonb CHECK (quality IS NULL OR jsonb_typeof(quality) = 'object');
ALTER TABLE runs ADD COLUMN judge jsonb CHECK (judge IS NULL OR jsonb_typeof(judge) = 'object');

CREATE TABLE run_profiles (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- La baseline survit à la purge du run (gardée avec sa version) : SET NULL.
  run_id uuid UNIQUE REFERENCES runs (id) ON DELETE SET NULL,
  api_id uuid NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users (id),
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  strategy_version integer,
  input_hash text NOT NULL CHECK (char_length(input_hash) <= 128),
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile) = 'object'),
  baseline boolean NOT NULL DEFAULT false,
  validated_by uuid REFERENCES users (id),
  validated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Baseline validée par un humain seulement (r4 R3).
  CONSTRAINT run_profiles_baseline_validated CHECK (NOT baseline OR validated_by IS NOT NULL)
);
CREATE INDEX run_profiles_owner_id_idx ON run_profiles (owner_id);
CREATE INDEX run_profiles_api_input_idx ON run_profiles (api_id, input_hash, created_at DESC);
CREATE INDEX run_profiles_created_at_idx ON run_profiles (created_at) WHERE NOT baseline;

CREATE FUNCTION run_profiles_owner_bound() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM apis a WHERE a.id = NEW.api_id AND a.owner_id = NEW.owner_id)
     OR (NEW.run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = NEW.run_id AND r.api_id = NEW.api_id)) THEN
    RAISE EXCEPTION 'profil : owner_id et api_id doivent être ceux de l''API et du run'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'run_profiles_owner_bound';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER run_profiles_owner_bound
  BEFORE INSERT OR UPDATE OF run_id, api_id, owner_id ON run_profiles
  FOR EACH ROW EXECUTE FUNCTION run_profiles_owner_bound();

ALTER TABLE run_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON run_profiles FOR ALL TO runtime_app
  USING (owner_id = app_current_user_id()) WITH CHECK (owner_id = app_current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON run_profiles TO runtime_app;

CREATE TABLE strategy_version_memory_refs (
  api_id uuid NOT NULL,
  strategy_version integer NOT NULL,
  owner_id uuid NOT NULL REFERENCES users (id),
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  ref_api_id uuid NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  ref_version integer,
  tier smallint NOT NULL CHECK (tier BETWEEN 0 AND 3),
  dossier_sha256 text NOT NULL CHECK (dossier_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_id, strategy_version, ref_api_id),
  FOREIGN KEY (api_id, strategy_version) REFERENCES strategy_versions (api_id, version) ON DELETE CASCADE
);
CREATE INDEX strategy_version_memory_refs_owner_id_idx ON strategy_version_memory_refs (owner_id);
CREATE INDEX strategy_version_memory_refs_ref_idx ON strategy_version_memory_refs (ref_api_id);

-- Aucun partage de mémoire entre utilisateurs (r1 R15) : l'API et l'entrée consultée appartiennent au même propriétaire.
CREATE FUNCTION memory_refs_owner_bound() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM apis a WHERE a.id = NEW.api_id AND a.owner_id = NEW.owner_id)
     OR NOT EXISTS (SELECT 1 FROM apis a WHERE a.id = NEW.ref_api_id AND a.owner_id = NEW.owner_id) THEN
    RAISE EXCEPTION 'mémoire : l''API et l''entrée consultée doivent appartenir au propriétaire'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'memory_refs_owner_bound';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER memory_refs_owner_bound
  BEFORE INSERT OR UPDATE ON strategy_version_memory_refs
  FOR EACH ROW EXECUTE FUNCTION memory_refs_owner_bound();

ALTER TABLE strategy_version_memory_refs ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON strategy_version_memory_refs FOR ALL TO runtime_app
  USING (owner_id = app_current_user_id()) WITH CHECK (owner_id = app_current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON strategy_version_memory_refs TO runtime_app;
