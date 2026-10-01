-- SPDX-License-Identifier: AGPL-3.0-only
-- 0014_tunnel_gateway : passerelle tunnel WSS (tâche 2.7, 07 § 5-6, 03 « Mode tunnel », INV5, O6 R4-R5).
--   tunnels.connected_at     connexion WSS en cours (avec gateway_instance et conn_epoch) ;
--   une seule WSS active par utilisateur  index unique partiel : au plus une ligne connectée par propriétaire ;
--   tunnel_jobs              commandes en transit, source de vérité ; NOTIFY ne porte que le job_id (réveil) ;
--   tunnel_jobs_owner_bound  un job ne vise que l'extension du propriétaire du run (INV5, assert_tunnel_single_user) ;
--   révocation               la passerelle qui tient la connexion est notifiée (fermeture 4401 immédiate).

ALTER TABLE tunnels ADD COLUMN connected_at timestamptz;
ALTER TABLE tunnels ADD CONSTRAINT tunnels_gateway_instance_format CHECK (gateway_instance IS NULL OR gateway_instance ~ '^[a-z0-9_]{1,40}$');
-- 07 § 6 : une seule WSS active par utilisateur (la plus récente gagne, l'ancienne est fermée en 4409).
CREATE UNIQUE INDEX tunnels_owner_connected ON tunnels (owner_id) WHERE gateway_instance IS NOT NULL;

ALTER TABLE tunnel_jobs
  ADD COLUMN cmd text NOT NULL DEFAULT 'http_fetch',
  ADD COLUMN domain text NOT NULL DEFAULT 'invalid.invalid',
  ADD COLUMN execution text,
  ADD COLUMN timeout_ms integer NOT NULL DEFAULT 30000,
  ADD COLUMN replayable boolean NOT NULL DEFAULT false,
  ADD COLUMN allow_write_actions boolean NOT NULL DEFAULT false,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN gateway_instance text,
  ADD COLUMN dispatched_at timestamptz,
  ADD COLUMN finished_at timestamptz,
  ADD COLUMN result jsonb,
  ADD COLUMN error text;
-- Lignes antérieures (aucune en pratique) : jamais rejouées.
UPDATE tunnel_jobs SET state = 'expired' WHERE state NOT IN ('done', 'failed', 'expired', 'cancelled');
ALTER TABLE tunnel_jobs
  ALTER COLUMN cmd DROP DEFAULT,
  ALTER COLUMN domain DROP DEFAULT,
  -- D-11 : énumération de l'état reçue ici.
  ADD CONSTRAINT tunnel_jobs_state_check CHECK (state IN ('pending', 'dispatched', 'done', 'failed', 'expired', 'cancelled')),
  ADD CONSTRAINT tunnel_jobs_cmd_check CHECK (cmd IN ('http_fetch', 'page_fetch', 'page_script', 'agent_step')),
  ADD CONSTRAINT tunnel_jobs_execution_check CHECK (execution IS NULL OR execution IN ('fetch', 'fetch_in_page', 'playwright', 'agent_fetch', 'hybrid', 'agent')),
  -- E6 limité au serveur (ADR 0001, assert_e6_not_in_tunnel_mode) : jamais une commande du tunnel.
  ADD CONSTRAINT tunnel_jobs_no_agent CHECK (execution IS DISTINCT FROM 'agent'),
  ADD CONSTRAINT tunnel_jobs_timeout_check CHECK (timeout_ms BETWEEN 1 AND 120000),
  ADD CONSTRAINT tunnel_jobs_error_format CHECK (error IS NULL OR error ~ '^[a-z_]{1,40}$'),
  ADD CONSTRAINT tunnel_jobs_gateway_instance_format CHECK (gateway_instance IS NULL OR gateway_instance ~ '^[a-z0-9_]{1,40}$');
CREATE INDEX tunnel_jobs_pending_idx ON tunnel_jobs (owner_id, created_at) WHERE state = 'pending';
CREATE INDEX tunnel_jobs_dispatched_idx ON tunnel_jobs (tunnel_id) WHERE state = 'dispatched';

-- INV5 : le job, son run et le tunnel visé ont le même propriétaire. SECURITY DEFINER : la RLS de runtime_app ne doit
-- pas masquer le run d'un autre (le contrôle échouerait alors en silence) ; la fonction ne lit que les deux lignes visées.
CREATE FUNCTION tunnel_jobs_owner_bound() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = NEW.run_id AND r.owner_id = NEW.owner_id) THEN
    RAISE EXCEPTION 'tunnel_jobs : le run n''appartient pas au propriétaire du job (INV5)' USING ERRCODE = '42501';
  END IF;
  IF NEW.tunnel_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tunnels t WHERE t.id = NEW.tunnel_id AND t.owner_id = NEW.owner_id) THEN
    RAISE EXCEPTION 'tunnel_jobs : un run ne passe que par l''extension de son propriétaire (INV5)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION tunnel_jobs_owner_bound() FROM PUBLIC;
CREATE TRIGGER tunnel_jobs_owner_bound BEFORE INSERT OR UPDATE OF run_id, owner_id, tunnel_id ON tunnel_jobs
  FOR EACH ROW EXECUTE FUNCTION tunnel_jobs_owner_bound();

-- Révocation (utilisateur, admin, désactivation du compte) : la passerelle qui tient la WSS la ferme aussitôt (4401).
-- NOTIFY sur le canal de l'instance, émis au COMMIT de la révocation ; la connexion est détachée de la ligne.
CREATE FUNCTION tunnels_revoked_notify() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.gateway_instance IS NOT NULL THEN
      PERFORM pg_notify('tunnel_cmd_' || OLD.gateway_instance, 'r:' || OLD.id::text);
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL AND OLD.gateway_instance IS NOT NULL THEN
    PERFORM pg_notify('tunnel_cmd_' || OLD.gateway_instance, 'r:' || NEW.id::text);
    NEW.gateway_instance := NULL;
    NEW.connected_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tunnels_revoked_notify BEFORE UPDATE OF revoked_at ON tunnels
  FOR EACH ROW EXECUTE FUNCTION tunnels_revoked_notify();
CREATE TRIGGER tunnels_deleted_notify AFTER DELETE ON tunnels
  FOR EACH ROW EXECUTE FUNCTION tunnels_revoked_notify();
