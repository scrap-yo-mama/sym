-- SPDX-License-Identifier: AGPL-3.0-only
-- 0019_rule_files (tâche 2.10, 18 §4.6, 19b §1) : règles, consignes et skills Markdown ; source des versions de stratégie.
--   rule_files              un fichier (kind instance | rule | skill) d'un propriétaire, ou d'instance (owner_id NULL,
--                           visibility instance : installé au démarrage ou écrit par un admin en console) ; unique par
--                           propriétaire, kind et nom ; `target_api_ids` : résolution de `api:<slug>` (API du propriétaire) ;
--   rule_file_versions      historique IMMUABLE (contenu normalisé LF, sha256 vérifiée par la base) ; `review_state`
--                           forcé à `to_review` pour les origines mcp, import, proposal, optimizer (aucune option ne le lève) ;
--   strategy_version_rules  source d'une version : règles injectées, embarquées (E4-E6), skills lus, règles retirées par
--                           le plafond (`loaded`), avec version et empreinte ;
--   strategy_versions.source  demande, empreinte du schéma, enquête, décisions, règles (18 §4.6) ; created_by + recompile ;
--   run_attempts.rule_refs  `nom@version` des règles qui ont placé l'essai.
-- RLS (INV12) : un fichier privé n'est visible et modifiable que de son propriétaire ; un fichier d'instance est lisible
-- de tout utilisateur connecté, modifiable par un admin seulement (la restriction « session console » est du service).
-- L'admin ne voit des API d'autrui qu'un compte agrégé (`admin_rule_usage`, sans api_id ni slug).
-- La politique par défaut `escalade-par-defaut.md` (templates/rules/rules/) est installée ici, origine seed.

CREATE TABLE rule_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES users (id),
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  kind text NOT NULL CHECK (kind IN ('instance', 'rule', 'skill')),
  name text NOT NULL CHECK (name ~ '^[a-z0-9-]{1,64}$'),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500),
  applies_to text[] NOT NULL DEFAULT '{}',
  target_api_ids uuid[] NOT NULL DEFAULT '{}',
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'instance')),
  current_version integer NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  -- Consignes d'instance : toujours d'instance, jamais de sélecteur ; règles et skills : au moins un sélecteur.
  CONSTRAINT rule_files_instance_kind CHECK (kind <> 'instance' OR (visibility = 'instance' AND cardinality(applies_to) = 0)),
  CONSTRAINT rule_files_applies_to CHECK (kind = 'instance' OR cardinality(applies_to) BETWEEN 1 AND 32),
  -- Un fichier sans propriétaire est un fichier d'instance.
  CONSTRAINT rule_files_owner CHECK (owner_id IS NOT NULL OR visibility = 'instance')
);
CREATE UNIQUE INDEX rule_files_owner_kind_name_key ON rule_files (COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, name);
CREATE INDEX rule_files_owner_id_idx ON rule_files (owner_id);

CREATE TABLE rule_file_versions (
  rule_file_id uuid NOT NULL REFERENCES rule_files (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  content text NOT NULL CHECK (char_length(content) <= 20000),
  sha256 text NOT NULL CHECK (sha256 = encode(sha256(convert_to(content, 'UTF8')), 'hex')),
  -- En-tête de CETTE version : une version « à relire » ne change ni la portée ni la description appliquées.
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500),
  applies_to text[] NOT NULL DEFAULT '{}',
  target_api_ids uuid[] NOT NULL DEFAULT '{}',
  author_id uuid REFERENCES users (id),
  origin text NOT NULL CHECK (origin IN ('ui', 'rest', 'mcp', 'import', 'seed', 'proposal', 'optimizer')),
  review_state text NOT NULL DEFAULT 'none' CHECK (review_state IN ('none', 'to_review', 'confirmed')),
  confirmed_by uuid REFERENCES users (id),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_file_id, version)
);
CREATE INDEX rule_file_versions_sha256_idx ON rule_file_versions (sha256);

-- Confirmation forcée (18 §4.9, 19 §5) : une version écrite par une machine naît « à relire », quoi que dise l'appelant.
CREATE FUNCTION rule_file_versions_forced_review() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.origin IN ('mcp', 'import', 'proposal', 'optimizer') THEN
    NEW.review_state := 'to_review';
    NEW.confirmed_by := NULL;
    NEW.confirmed_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rule_file_versions_forced_review BEFORE INSERT ON rule_file_versions
  FOR EACH ROW EXECUTE FUNCTION rule_file_versions_forced_review();

-- Historique immuable : seul l'état de relecture évolue (confirmation en console).
CREATE FUNCTION rule_file_versions_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.rule_file_id <> OLD.rule_file_id OR NEW.version <> OLD.version OR NEW.content <> OLD.content OR NEW.sha256 <> OLD.sha256
     OR NEW.description <> OLD.description OR NEW.applies_to <> OLD.applies_to OR NEW.target_api_ids <> OLD.target_api_ids
     OR NEW.origin <> OLD.origin OR NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'rule_file_versions : historique immuable' USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_file_versions_immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rule_file_versions_immutable BEFORE UPDATE ON rule_file_versions
  FOR EACH ROW EXECUTE FUNCTION rule_file_versions_immutable();

CREATE TABLE strategy_version_rules (
  api_id uuid NOT NULL,
  strategy_version integer NOT NULL,
  owner_id uuid NOT NULL REFERENCES users (id),
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  rule_file_id uuid NOT NULL REFERENCES rule_files (id),
  rule_version integer NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  level text NOT NULL CHECK (level IN ('instance', 'domain', 'api')),
  loaded text NOT NULL CHECK (loaded IN ('injected', 'skill_read', 'embedded', 'truncated')),
  PRIMARY KEY (api_id, strategy_version, rule_file_id),
  FOREIGN KEY (api_id, strategy_version) REFERENCES strategy_versions (api_id, version) ON DELETE CASCADE,
  FOREIGN KEY (rule_file_id, rule_version) REFERENCES rule_file_versions (rule_file_id, version)
);
CREATE INDEX strategy_version_rules_owner_id_idx ON strategy_version_rules (owner_id);
CREATE INDEX strategy_version_rules_rule_idx ON strategy_version_rules (rule_file_id);

ALTER TABLE strategy_versions ADD COLUMN source jsonb CHECK (source IS NULL OR jsonb_typeof(source) = 'object');
ALTER TABLE strategy_versions DROP CONSTRAINT strategy_versions_created_by_check;
ALTER TABLE strategy_versions ADD CONSTRAINT strategy_versions_created_by_check
  CHECK (created_by IN ('investigation', 'repair', 'user', 'revert', 'import', 'recompile'));
ALTER TABLE run_attempts ADD COLUMN rule_refs text[] NOT NULL DEFAULT '{}' CHECK (cardinality(rule_refs) <= 20);

-- RLS (INV12).
ALTER TABLE rule_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON rule_files FOR ALL TO runtime_app
  USING (owner_id = app_current_user_id()) WITH CHECK (owner_id = app_current_user_id() AND visibility = 'private');
CREATE POLICY instance_read ON rule_files FOR SELECT TO runtime_app
  USING (app_current_user_id() IS NOT NULL AND visibility = 'instance');
CREATE POLICY instance_admin_write ON rule_files FOR ALL TO runtime_app
  USING (visibility = 'instance' AND current_setting('app.role', true) IN ('admin', 'owner') AND app_current_user_id() IS NOT NULL)
  WITH CHECK (visibility = 'instance' AND current_setting('app.role', true) IN ('admin', 'owner') AND app_current_user_id() IS NOT NULL);
-- DELETE : le propriétaire efface son fichier privé (RLS) ; une version encore citée par une source le retient (clé étrangère).
GRANT SELECT, INSERT, UPDATE, DELETE ON rule_files TO runtime_app;

ALTER TABLE rule_file_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_file ON rule_file_versions FOR SELECT TO runtime_app
  USING (EXISTS (SELECT 1 FROM rule_files f WHERE f.id = rule_file_versions.rule_file_id));
CREATE POLICY via_file_write ON rule_file_versions FOR INSERT TO runtime_app
  WITH CHECK (EXISTS (SELECT 1 FROM rule_files f WHERE f.id = rule_file_versions.rule_file_id
    AND (f.owner_id = app_current_user_id() OR (f.visibility = 'instance' AND current_setting('app.role', true) IN ('admin', 'owner')))));
CREATE POLICY via_file_review ON rule_file_versions FOR UPDATE TO runtime_app
  USING (EXISTS (SELECT 1 FROM rule_files f WHERE f.id = rule_file_versions.rule_file_id
    AND (f.owner_id = app_current_user_id() OR (f.visibility = 'instance' AND current_setting('app.role', true) IN ('admin', 'owner')))));
GRANT SELECT, INSERT, UPDATE ON rule_file_versions TO runtime_app;

ALTER TABLE strategy_version_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON strategy_version_rules FOR ALL TO runtime_app
  USING (owner_id = app_current_user_id()) WITH CHECK (owner_id = app_current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON strategy_version_rules TO runtime_app;

-- Administration (18 §4.8, INV12) : nombre d'API d'autrui dont la version courante utilise une règle, sans api_id ni slug.
CREATE VIEW admin_rule_usage WITH (security_barrier) AS
  SELECT s.rule_file_id, count(DISTINCT s.api_id)::integer AS apis
  FROM strategy_version_rules s JOIN apis a ON a.id = s.api_id AND a.current_strategy_version = s.strategy_version
  WHERE current_setting('app.role', true) IN ('admin', 'owner') AND s.loaded <> 'truncated'
  GROUP BY s.rule_file_id;
GRANT SELECT ON admin_rule_usage TO runtime_app;

-- Politique par défaut (18 §4.2) : règle partagée d'instance, origine seed. Identifiant et dates fixes : la migration est
-- rejouable à l'identique (aller-retour up, down, up).
WITH f AS (
  INSERT INTO rule_files (id, owner_id, kind, name, description, applies_to, visibility, current_version, created_at, updated_at)
  VALUES ('00000000-0000-0000-0000-000000000218', NULL, 'rule', 'escalade-par-defaut', 'Politique par défaut « du moins cher au plus cher » (04 §3.3) ; ordre, élagages et arrêts exécutés par le code.', '{*}', 'instance', 1, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')
  RETURNING id
)
INSERT INTO rule_file_versions (rule_file_id, version, content, sha256, description, applies_to, author_id, origin, created_at)
SELECT f.id, 1, c.content, encode(sha256(convert_to(c.content, 'UTF8')), 'hex'),
  'Politique par défaut « du moins cher au plus cher » (04 §3.3) ; ordre, élagages et arrêts exécutés par le code.', '{*}', NULL, 'seed', '2026-10-01T00:00:00Z'
FROM f, (SELECT $seed$---
name: escalade-par-defaut
description: Politique par défaut « du moins cher au plus cher » (04 §3.3) ; ordre, élagages et arrêts exécutés par le code.
kind: rule
applies_to: ["*"]
---
# Escalade par défaut : du moins cher au plus cher

Transcription de 04 §3.3, sans heuristique ajoutée. Le code calcule l'ensemble des couples (E, N) autorisés et leur
coût estimé ; il exécute lui-même l'ordre, les élagages et les arrêts ci-dessous, quoi que dise ce fichier. Ce texte les
décrit pour que l'agent les connaisse.

## Ordre d'essai

Couples autorisés triés par `est_cost_usd` croissant, puis par E (E1 à E6), puis par N (N1 à N3).

## Élagage après un échec (classe du classifieur)

- `network` : sauter les couples restants avec le même N.
- `extraction` : sauter les couples restants avec le même E.

## Arrêts

- `blocked_by_protection`, `forbidden`, `robots_disallowed` : arrêt de tout essai, statut `bloquee`.
- `auth_required`, `payment_required` : la main revient à l'utilisateur, statut `action_requise`.

## Sélection

La stratégie retenue est la moins chère conforme parmi les couples essayés. Un couple moins cher, ni essayé ni exclu par
une règle, est essayé avant de retenir.
$seed$::text AS content) c;
