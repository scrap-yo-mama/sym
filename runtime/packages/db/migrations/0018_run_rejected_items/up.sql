-- SPDX-License-Identifier: AGPL-3.0-only
-- 0018_run_rejected_items (tâche 2.3, D-49, 04 §5, 04b §1) : items non conformes écartés et quarantaine.
--   runs.items_rejected   items extraits non conformes, jamais livrés (le dataset ne contient que les items livrés) ;
--   run_rejected_items    une ligne par run qui a écarté des items : agrégats sans valeur (`total_rejected`,
--                         `by_reason` : mot-clé Ajv, pointeur, nombre) et échantillon de 5 items au plus, nettoyé avant
--                         l'écriture (propriétés non déclarées retirées, chemins en erreur et champs personnels masqués).
-- L'échantillon appartient au RUN, donc à son appelant : `owner_id` = `runs.owner_id` (déclencheur), RLS sur `owner_id`
-- (INV12). Sur une API partagée (`visibility = instance`), le propriétaire de l'API ne lit que les agrégats
-- (`run_rejected_aggregates`, sans `sample`) ; l'admin, les seules métadonnées (`admin_rejected_metadata`, INV5).
-- Purge de `sample` avec `RETENTION_SAMPLES_DAYS` ; comprise dans l'effacement d'une personne (17 § 6).
ALTER TABLE runs ADD COLUMN items_rejected integer NOT NULL DEFAULT 0 CHECK (items_rejected >= 0);

CREATE TABLE run_rejected_items (
  run_id uuid PRIMARY KEY REFERENCES runs (id) ON DELETE CASCADE,
  api_id uuid NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users (id),
  project_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES projects (id),
  total_rejected integer NOT NULL CHECK (total_rejected > 0),
  by_reason jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(by_reason) = 'array'),
  sample jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(sample) = 'array' AND jsonb_array_length(sample) <= 5),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX run_rejected_items_owner_id_idx ON run_rejected_items (owner_id);
CREATE INDEX run_rejected_items_api_id_idx ON run_rejected_items (api_id);
CREATE INDEX run_rejected_items_created_at_idx ON run_rejected_items (created_at);

-- La quarantaine d'un run appartient à l'appelant du run et à l'API du run, jamais à un autre (droits de l'appelant :
-- sous `runtime_app`, la RLS de `runs` ne laisse voir que ses propres runs).
CREATE FUNCTION run_rejected_items_owner_bound() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = NEW.run_id AND r.owner_id = NEW.owner_id AND r.api_id = NEW.api_id) THEN
    RAISE EXCEPTION 'quarantaine : owner_id et api_id doivent être ceux du run'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'run_rejected_items_owner_bound';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER run_rejected_items_owner_bound
  BEFORE INSERT OR UPDATE OF run_id, api_id, owner_id ON run_rejected_items
  FOR EACH ROW EXECUTE FUNCTION run_rejected_items_owner_bound();

ALTER TABLE run_rejected_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON run_rejected_items FOR ALL TO runtime_app
  USING (owner_id = app_current_user_id()) WITH CHECK (owner_id = app_current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON run_rejected_items TO runtime_app;

-- Agrégats sans valeur : l'appelant du run, et le propriétaire de l'API (diagnostic et réparation d'une API partagée).
CREATE VIEW run_rejected_aggregates WITH (security_barrier) AS
  SELECT q.run_id, q.api_id, q.total_rejected, q.by_reason, q.created_at
  FROM run_rejected_items q JOIN apis a ON a.id = q.api_id
  WHERE app_current_user_id() IS NOT NULL AND (q.owner_id = app_current_user_id() OR a.owner_id = app_current_user_id());

-- Administration (INV5) : métadonnées seulement, ni raisons ni échantillon.
CREATE VIEW admin_rejected_metadata WITH (security_barrier) AS
  SELECT run_id, api_id, owner_id, total_rejected, created_at
  FROM run_rejected_items
  WHERE current_setting('app.role', true) IN ('admin', 'owner') OR owner_id = app_current_user_id();

GRANT SELECT ON run_rejected_aggregates, admin_rejected_metadata TO runtime_app;
