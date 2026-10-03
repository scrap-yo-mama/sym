-- SPDX-License-Identifier: AGPL-3.0-only
-- 0021_persistence_mode (tâche 2.16, D-49, 04 §6) : mode « SYM ne lâche pas ».
--   apis.persistence_mode          opt-in par API, désactivé par défaut ; activé en console seulement (audit_events) ;
--   apis.persistence_budget_usd    plafond propre, cumulé depuis l'entrée en `erreur` ; NULL = PERSISTENCE_BUDGET_USD_DEFAULT
--                                  (jamais « illimité ») ; un plafond nul ou négatif ne s'enregistre pas ;
--   api_persistence                un cycle par API en `erreur` : classe d'entrée, tentatives comptées, prochain créneau, dépense, tentative
--                                  en cours (`run_id`), fin du mode (`refused`, `ineligible`, `exhausted`) et sa raison ;
--                                  aucune valeur du site ; lisible du seul propriétaire de l'API (RLS par `apis.owner_id`) ;
--   persistence_domain_slots       une tentative par domaine enregistrable et par créneau, toutes API de l'instance
--                                  confondues (clé = domaine seul, comme la cadence) ; identité système seulement.
ALTER TABLE apis
  ADD COLUMN persistence_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN persistence_budget_usd numeric(12, 6) CHECK (persistence_budget_usd IS NULL OR persistence_budget_usd > 0);

CREATE TABLE api_persistence (
  api_id uuid PRIMARY KEY REFERENCES apis (id) ON DELETE CASCADE,
  domain text NOT NULL,
  entered_error_at timestamptz NOT NULL,
  -- Classe qui a mis l'API en `erreur` (celle de la transition 16), relue à chaque tentative.
  failure_class text,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  next_at timestamptz,
  run_id uuid REFERENCES runs (id) ON DELETE SET NULL,
  last_attempt_at timestamptz,
  spent_usd numeric(12, 6) NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  last_outcome text,
  ended text CHECK (ended IN ('refused', 'ineligible', 'exhausted')),
  ended_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Mode arrêté : plus de créneau ni de tentative en cours.
  CONSTRAINT api_persistence_ended_idle CHECK (ended IS NULL OR (next_at IS NULL AND run_id IS NULL))
);
CREATE INDEX api_persistence_domain_idx ON api_persistence (domain) WHERE ended IS NULL;
CREATE INDEX api_persistence_due_idx ON api_persistence (next_at) WHERE ended IS NULL AND run_id IS NULL;

-- Le propriétaire de l'API lit et bascule son cycle (activation en console) ; les tentatives sont écrites par le worker.
ALTER TABLE api_persistence ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON api_persistence FOR ALL TO runtime_app
  USING (EXISTS (SELECT 1 FROM apis a WHERE a.id = api_id AND a.owner_id = app_current_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM apis a WHERE a.id = api_id AND a.owner_id = app_current_user_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON api_persistence TO runtime_app;

CREATE TABLE persistence_domain_slots (
  domain text PRIMARY KEY,
  api_id uuid REFERENCES apis (id) ON DELETE SET NULL,
  run_id uuid REFERENCES runs (id) ON DELETE SET NULL,
  slot_until timestamptz NOT NULL
);
