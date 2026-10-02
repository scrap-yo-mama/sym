-- SPDX-License-Identifier: AGPL-3.0-only
-- 0003_events_webhooks : flux d'événements et webhooks (cdc/sym-browser 03 § 5 et § 6, 04 § 2, tâche 2.5).
-- 1. Chaque insertion dans session_events est notifiée sur le canal `symb_session_events` (les notifications partent à la
--    validation, dans l'ordre des validations ; rien pour une transaction annulée). Charge : identifiant, session, client,
--    type, instant et données ; au-delà de 7 900 octets, sans données (`truncated`), relues en base par la passerelle.
-- 2. Chaque client peut régler un webhook (URL http(s) et secret Standard Webhooks scellé par l'enveloppe de la tâche 0.3).
--    Une fin de session (état ended, timed_out ou failed) ou un `recording.ready` d'un client qui a une URL met une livraison
--    en file dans la même transaction que l'événement (aucune perte si la passerelle est arrêtée), notifiée sur
--    `symb_webhooks`. L'URL est figée à la mise en file ; le secret est relu à chaque envoi.
ALTER TABLE tenants
  ADD COLUMN webhook_url text CHECK (webhook_url IS NULL OR webhook_url ~ '^https?://'),
  -- Secret `whsec_…` scellé (AAD webhook_secret|tenant_id) ; jamais en clair (BINV6).
  ADD COLUMN webhook_secret_encrypted text,
  ADD CONSTRAINT tenants_webhook_secret_with_url CHECK (webhook_url IS NULL OR webhook_secret_encrypted IS NOT NULL);

CREATE TABLE webhook_deliveries (
  -- `webhook-id` de Standard Webhooks : stable d'une relance à l'autre.
  id text PRIMARY KEY CHECK (id ~ '^msg_[0-9a-f]{32}$'),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  -- Une livraison au plus par événement, même avec plusieurs passerelles.
  event_id bigint NOT NULL UNIQUE REFERENCES session_events (id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('session.ended', 'recording.ready')),
  url text NOT NULL CHECK (url ~ '^https?://'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  -- Bail de la passerelle qui envoie : une livraison réservée n'est pas reprise avant son expiration.
  locked_until timestamptz,
  last_status integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_session_idx ON webhook_deliveries (session_id);

CREATE FUNCTION symb_session_event_published() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner uuid;
  hook text;
  payload text;
BEGIN
  SELECT s.tenant_id, t.webhook_url INTO owner, hook FROM sessions s JOIN tenants t ON t.id = s.tenant_id WHERE s.id = NEW.session_id;
  payload := json_build_object('id', NEW.id::text, 'sessionId', NEW.session_id, 'tenantId', owner, 'type', NEW.type, 'at', NEW.occurred_at, 'data', NEW.data)::text;
  IF octet_length(payload) > 7900 THEN
    payload := json_build_object('id', NEW.id::text, 'sessionId', NEW.session_id, 'tenantId', owner, 'type', NEW.type, 'at', NEW.occurred_at, 'truncated', true)::text;
  END IF;
  PERFORM pg_notify('symb_session_events', payload);
  IF hook IS NOT NULL AND ((NEW.type = 'state' AND NEW.data ->> 'state' IN ('ended', 'timed_out', 'failed')) OR NEW.type = 'recording.ready') THEN
    INSERT INTO webhook_deliveries (id, tenant_id, session_id, event_id, type, url)
    VALUES ('msg_' || replace(gen_random_uuid()::text, '-', ''), owner, NEW.session_id, NEW.id,
            CASE WHEN NEW.type = 'state' THEN 'session.ended' ELSE 'recording.ready' END, hook);
    PERFORM pg_notify('symb_webhooks', '');
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER session_events_published AFTER INSERT ON session_events FOR EACH ROW EXECUTE FUNCTION symb_session_event_published();
