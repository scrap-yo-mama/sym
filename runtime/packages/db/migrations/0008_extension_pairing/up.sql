-- SPDX-License-Identifier: AGPL-3.0-only
-- 0008_extension_pairing : extension Chrome (tâche 2.6, 07 § 1-2, 13 § 12, INV5, INV8).
--   extension_pairing_codes  code d'appairage à usage unique, 10 min (empreinte seulement, jamais le code) ;
--   tunnels                  un appareil actif par (utilisateur, device_id) ; révocation tracée (revoked_by) ;
--   site_sessions            enveloppe complète des cookies (dek_wrapped, alg : 08 § 3), consentement daté,
--                            domaine normalisé, et ÉCRITURE SEULE pour le rôle des requêtes : runtime_app ne lit
--                            jamais ciphertext, nonce ni dek_wrapped (seule l'identité système, côté worker, les ouvre).

CREATE TABLE extension_pairing_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  tunnel_id uuid REFERENCES tunnels (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 07 § 1 : valable 10 minutes au plus.
  CONSTRAINT extension_pairing_codes_ttl CHECK (expires_at <= created_at + interval '10 minutes')
);
CREATE INDEX extension_pairing_codes_owner_id_idx ON extension_pairing_codes (owner_id);

ALTER TABLE extension_pairing_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON extension_pairing_codes FOR ALL TO runtime_app
  USING (owner_id = app_current_user_id()) WITH CHECK (owner_id = app_current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON extension_pairing_codes TO runtime_app;

-- Un seul jeton actif par appareil : un nouvel appairage du même appareil révoque le précédent.
ALTER TABLE tunnels ADD COLUMN revoked_by uuid REFERENCES users (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX tunnels_owner_device_active ON tunnels (owner_id, device_id) WHERE revoked_at IS NULL;

ALTER TABLE site_sessions
  ADD COLUMN dek_wrapped bytea,
  ADD COLUMN alg text,
  ADD COLUMN consented_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  -- Domaine = nom d'hôte normalisé (minuscules, ASCII/punycode, sans port ni point final).
  ADD CONSTRAINT site_sessions_domain_format CHECK (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$' AND length(domain) <= 253),
  -- INV8 : une valeur scellée est complète (chiffré, nonce, DEK enveloppée, format, version de clé) ou absente.
  ADD CONSTRAINT site_sessions_sealed_complete CHECK (
    (ciphertext IS NULL AND nonce IS NULL AND dek_wrapped IS NULL AND alg IS NULL AND key_version IS NULL)
    OR (ciphertext IS NOT NULL AND nonce IS NOT NULL AND dek_wrapped IS NOT NULL AND alg IS NOT NULL AND key_version IS NOT NULL)
  );

-- Écriture seule (07 § 2, assert_secret_write_only) : le rôle des requêtes écrit les colonnes chiffrées mais ne les lit pas.
REVOKE SELECT ON site_sessions FROM runtime_app;
GRANT SELECT (id, owner_id, project_id, domain, server_use_allowed, key_version, captured_at, expires_at, created_at, consented_at, updated_at)
  ON site_sessions TO runtime_app;

-- Journal d'audit : les actions faites avec le jeton d'un appareil sont attribuées à l'extension (13 § 9).
ALTER TABLE audit_events DROP CONSTRAINT audit_events_actor_via_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_via_check
  CHECK (actor_via IN ('ui', 'apikey', 'mcp', 'sso', 'system', 'extension'));

-- Désactivation d'un utilisateur (07 § 2, 13 § 10) : ses cookies serveur sont effacés et ses jetons d'appareil révoqués,
-- quelle que soit la voie de désactivation (route d'admin, CLI, SQL) : « 0 cookie de lui en base ». SECURITY DEFINER :
-- sous runtime_app (une future route d'admin sous withActor), la RLS owner_isolation filtrerait les lignes de l'autre
-- utilisateur (effacement vide) et la lecture de ciphertext est refusée ; la fonction ne touche que les lignes de NEW.id.
CREATE FUNCTION users_disabled_revoke_extension() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE site_sessions
     SET ciphertext = NULL, nonce = NULL, dek_wrapped = NULL, alg = NULL, key_version = NULL, captured_at = NULL,
         expires_at = NULL, updated_at = now()
   WHERE owner_id = NEW.id AND ciphertext IS NOT NULL;
  UPDATE tunnels SET revoked_at = now() WHERE owner_id = NEW.id AND revoked_at IS NULL;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION users_disabled_revoke_extension() FROM PUBLIC;
CREATE TRIGGER users_disabled_revoke_extension AFTER UPDATE OF status ON users
  FOR EACH ROW WHEN (NEW.status = 'disabled' AND OLD.status IS DISTINCT FROM 'disabled')
  EXECUTE FUNCTION users_disabled_revoke_extension();

-- Administration des appareils (07 § 1, A3, assert_admin_revoke_only) : un admin voit des métadonnées (jamais le jeton
-- ni son empreinte) et ne peut que révoquer. Vue et fonction au contrôle de rôle en base, appelées sous runtime_app.
CREATE VIEW admin_tunnel_metadata WITH (security_barrier) AS
  SELECT t.id, t.owner_id, u.email AS owner_email, t.device_label, t.created_at, t.last_seen_at, t.expires_at, t.revoked_at
  FROM tunnels t JOIN users u ON u.id = t.owner_id
  WHERE current_setting('app.role', true) IN ('admin', 'owner');
GRANT SELECT ON admin_tunnel_metadata TO runtime_app;

CREATE FUNCTION admin_revoke_tunnel(target uuid) RETURNS TABLE (owner_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF coalesce(current_setting('app.role', true), '') NOT IN ('admin', 'owner') OR app_current_user_id() IS NULL THEN
    RAISE EXCEPTION 'révocation d''appareil réservée aux admins' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    UPDATE tunnels t SET revoked_at = coalesce(t.revoked_at, now()), revoked_by = coalesce(t.revoked_by, app_current_user_id())
    WHERE t.id = target RETURNING t.owner_id;
END
$$;
REVOKE ALL ON FUNCTION admin_revoke_tunnel(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_revoke_tunnel(uuid) TO runtime_app;
