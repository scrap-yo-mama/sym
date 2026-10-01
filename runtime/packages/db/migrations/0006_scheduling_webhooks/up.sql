-- SPDX-License-Identifier: AGPL-3.0-only
-- 0006_scheduling_webhooks : planification, webhooks sortants signés, alertes (tâche 2.5, 08 § 5, 03 § Schéma).
--   schedules               CHECK sur `overlap` (skip|queue|allow) et `on_missed` (skip|once) ;
--   runs                    schedule_id (planification d'origine), scheduled_at (instant du déclenchement, sert à
--                           `max_runs_per_day` sur le jour du fuseau), schedule_job_id (job `scheduled-run` d'origine :
--                           unique, un rejeu du job ne crée jamais un second run) ;
--   apis                    warning_alerted_at : un `warning` qui dure au-delà de D n'alerte qu'une fois par épisode ;
--   webhook_subscriptions   rotation (previous_secret_id : deux secrets valides en parallèle), failing_since
--                           (désactivation après 5 jours d'échecs), last_success_at, tested_at ;
--   webhook_deliveries      event_id (= `webhook-id` : stable d'une relance et d'une cible à l'autre), payload (mince :
--                           rejouée à l'identique), durée, extrait de réponse tronqué, code d'erreur, fin de tentative.
ALTER TABLE schedules
  ADD CONSTRAINT schedules_overlap_check CHECK (overlap IN ('skip', 'queue', 'allow')),
  ADD CONSTRAINT schedules_on_missed_check CHECK (on_missed IN ('skip', 'once'));

ALTER TABLE runs
  ADD COLUMN schedule_id uuid REFERENCES schedules (id) ON DELETE SET NULL,
  ADD COLUMN scheduled_at timestamptz,
  ADD COLUMN schedule_job_id uuid;
CREATE UNIQUE INDEX runs_schedule_job_id_key ON runs (schedule_job_id) WHERE schedule_job_id IS NOT NULL;
CREATE INDEX runs_schedule_scheduled_idx ON runs (schedule_id, scheduled_at) WHERE schedule_id IS NOT NULL;

ALTER TABLE apis ADD COLUMN warning_alerted_at timestamptz;

ALTER TABLE webhook_subscriptions
  ADD COLUMN previous_secret_id uuid REFERENCES secrets (id) ON DELETE SET NULL,
  ADD COLUMN previous_secret_expires_at timestamptz,
  ADD COLUMN failing_since timestamptz,
  ADD COLUMN last_success_at timestamptz,
  ADD COLUMN tested_at timestamptz;

ALTER TABLE webhook_deliveries
  ADD COLUMN event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN payload jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN duration_ms integer,
  ADD COLUMN response_excerpt text CHECK (response_excerpt IS NULL OR char_length(response_excerpt) <= 512),
  ADD COLUMN error_code text,
  ADD COLUMN finished_at timestamptz;
CREATE INDEX webhook_deliveries_subscription_idx ON webhook_deliveries (subscription_id, created_at DESC);
