-- SPDX-License-Identifier: AGPL-3.0-only
-- 0028_session_server_state : sessions de site rejouées côté serveur pour leur propriétaire (CDC V1 sym-sessions, A1, S-01 ;
--   INV5 évolué : la session appartient à son propriétaire et se rejoue côté serveur quand il a consenti, pour lui seul).
--   site_sessions.secret_kind      nature du secret scellé ; `cookie` en V1 (la V2 ajoutera `token` en élargissant la contrainte).
--                                  La durée de vie du secret reste `expires_at` (fin de la session entière, posée à l'envoi).
--   site_sessions.last_used_at     dernier rejeu serveur ; renseigné par le worker (A2) et la couche d'état (B1).
--   site_sessions.last_checked_at  dernière vérification de validité (B1).
--   site_sessions.account_label    étiquette libre du compte (ex. « Cabinet, compte principal »), choisie par l'utilisateur.
--   site_session_events            journal d'usage en ajout seul : quand, pour quel domaine et quel run une session a servi,
--                                  a été vérifiée, révoquée ou renouvelée. AUCUNE valeur de secret (INV8).
--   `apis_session_private` et `site_sessions_server_use` sont inchangés.

ALTER TABLE site_sessions
  ADD COLUMN secret_kind text NOT NULL DEFAULT 'cookie',
  ADD COLUMN last_used_at timestamptz,
  ADD COLUMN last_checked_at timestamptz,
  ADD COLUMN account_label text,
  ADD CONSTRAINT site_sessions_secret_kind CHECK (secret_kind IN ('cookie')),
  ADD CONSTRAINT site_sessions_account_label_len CHECK (account_label IS NULL OR length(account_label) <= 120);

-- Le rôle des requêtes (0008) lit des colonnes nommées, jamais les colonnes scellées : on ajoute les nouvelles, qui sont
-- de simples métadonnées. UPDATE reste accordé sur la table par 0003 sous RLS propriétaire : l'utilisateur peut donc
-- renommer `account_label` de ses propres sessions, et seulement des siennes.
GRANT SELECT (secret_kind, last_used_at, last_checked_at, account_label) ON site_sessions TO runtime_app;

CREATE TABLE site_session_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- La session peut disparaître (déconnexion du site) : l'événement reste, rattaché au domaine.
  site_session_id uuid REFERENCES site_sessions (id) ON DELETE SET NULL,
  domain text NOT NULL,
  event text NOT NULL,
  run_id uuid REFERENCES runs (id) ON DELETE SET NULL,
  outcome text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_session_events_event CHECK (event IN ('used', 'checked', 'revoked', 'refresh_requested', 'refreshed')),
  CONSTRAINT site_session_events_domain_format CHECK (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$' AND length(domain) <= 253),
  CONSTRAINT site_session_events_outcome_len CHECK (outcome IS NULL OR length(outcome) <= 120)
);
CREATE INDEX site_session_events_owner_idx ON site_session_events (owner_id, created_at DESC);
CREATE INDEX site_session_events_session_idx ON site_session_events (site_session_id) WHERE site_session_id IS NOT NULL;
CREATE INDEX site_session_events_run_idx ON site_session_events (run_id) WHERE run_id IS NOT NULL;

-- Journal : les événements `used`, `checked` et `refresh_requested` sont écrits par le système (worker ou serveur, identité
-- propriétaire des tables : pas de FORCE ROW LEVEL SECURITY, la RLS ne s'y applique pas). Le rôle des requêtes n'insère que
-- ce qu'une action de l'utilisateur produit (`revoked`, `refreshed`) : un utilisateur ne peut donc pas fabriquer un usage.
-- Propriétaire seul, en ajout seul pour le rôle des requêtes : INSERT et SELECT, ni UPDATE ni DELETE ni TRUNCATE
-- (même principe que audit_events, assert_audit_append_only). Un administrateur ne lit pas les événements d'un autre.
ALTER TABLE site_session_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON site_session_events FOR SELECT TO runtime_app
  USING (owner_id = app_current_user_id());
CREATE POLICY owner_user_events_insert ON site_session_events FOR INSERT TO runtime_app
  WITH CHECK (owner_id = app_current_user_id() AND event IN ('revoked', 'refreshed'));
GRANT SELECT, INSERT ON site_session_events TO runtime_app;

-- INV5 / INV12 : la session et le run rattachés à un événement ont le même propriétaire (et la session le même domaine).
-- SECURITY DEFINER : la RLS de runtime_app masquerait la ligne d'autrui et le contrôle échouerait en silence. Même code 42501
-- et même message pour un UUID inexistant et pour celui d'un autre propriétaire : aucun oracle d'existence. Le déclencheur
-- BEFORE INSERT passe avant les clés étrangères (23503).
CREATE FUNCTION site_session_events_owner_bound() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF (NEW.site_session_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM site_sessions s WHERE s.id = NEW.site_session_id AND s.owner_id = NEW.owner_id AND s.domain = NEW.domain))
     OR (NEW.run_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM runs r WHERE r.id = NEW.run_id AND r.owner_id = NEW.owner_id)) THEN
    RAISE EXCEPTION 'site_session_events : rattachement refusé (INV5)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION site_session_events_owner_bound() FROM PUBLIC;
CREATE TRIGGER site_session_events_owner_bound BEFORE INSERT ON site_session_events
  FOR EACH ROW EXECUTE FUNCTION site_session_events_owner_bound();
