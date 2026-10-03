-- SPDX-License-Identifier: AGPL-3.0-only
-- 0002_idempotency : en-tête `Idempotency-Key` de POST /v1/sessions et POST /v1/sessions/{id}/extend (cdc/sym-browser 04 § 9,
-- tâche 2.2). Même clé et même corps dans les 24 h : réponse d'origine rejouée ; corps différent : 409 idempotency_conflict.
-- Une clé est propre à un client et à une opération. Une ligne sans réponse est une demande en cours (réservation) : une
-- seconde demande concurrente reçoit 409. Seules les réponses 2xx sont gardées ; un échec rend la clé réutilisable.
CREATE TABLE idempotency_keys (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  operation text NOT NULL CHECK (operation IN ('createSession', 'extendSession')),
  key text NOT NULL CHECK (char_length(key) BETWEEN 8 AND 128),
  -- SHA-256 de la cible et du corps canonique de la demande.
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response_status integer CHECK (response_status BETWEEN 200 AND 299),
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation, key),
  CHECK ((response_status IS NULL) = (response_body IS NULL))
);
-- Purge des clés de plus de 24 h.
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
