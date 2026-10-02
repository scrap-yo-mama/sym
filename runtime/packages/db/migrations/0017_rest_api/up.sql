-- SPDX-License-Identifier: AGPL-3.0-only
-- 0017_rest_api (tâche 3.1, API REST, 05 § 4.2 et 06 § 2) :
--   runs.paused_at            pause d'un run ou d'une enquête demandée par l'utilisateur, reprise par
--                             `POST /api/runs/{id}/resume` ; NULL hors pause. Un run en pause est `queued` sans job (`job_id`
--                             NULL) : le worker qui le tenait perd son bail au battement suivant (jeton de clôture), ses essais
--                             et ses coûts restent imputés (INV4). Le balayeur ne reprend jamais un run en pause (sweepOrphans)
--                             et `claimRun` le refuse : seule une action de l'utilisateur le remet en file, jamais une
--                             vérification ni une planification. Annulé pendant sa pause, il garde la date.
--   webhook_subscriptions.api_id  abonnement limité à une API (console, Alertes) ; NULL = toutes les API du propriétaire.
--                             Supprimé avec l'API.
ALTER TABLE runs ADD COLUMN paused_at timestamptz;
ALTER TABLE runs ADD CONSTRAINT runs_paused_state CHECK (paused_at IS NULL OR state IN ('queued', 'cancelled'));

ALTER TABLE webhook_subscriptions ADD COLUMN api_id uuid REFERENCES apis (id) ON DELETE CASCADE;
CREATE INDEX webhook_subscriptions_api_id_idx ON webhook_subscriptions (api_id) WHERE api_id IS NOT NULL;
