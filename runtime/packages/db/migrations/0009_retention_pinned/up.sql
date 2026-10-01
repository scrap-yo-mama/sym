-- SPDX-License-Identifier: AGPL-3.0-only
-- 0009_retention_pinned (tâche 1.8, revue ; 17 § 6 « pas d'exemption silencieuse ») : un dataset épinglé porte une
-- raison et une échéance. Passé `pinned_until`, il reprend la règle commune (marquage puis purge). Les épinglages
-- antérieurs reçoivent une raison explicite et 90 jours.
ALTER TABLE datasets ADD COLUMN pinned_reason text, ADD COLUMN pinned_until timestamptz;
UPDATE datasets SET pinned_reason = 'épinglé avant 0009', pinned_until = now() + interval '90 days' WHERE pinned;
ALTER TABLE datasets ADD CONSTRAINT datasets_pinned_exemption_check
  CHECK (NOT pinned OR (pinned_reason IS NOT NULL AND btrim(pinned_reason) <> '' AND pinned_until IS NOT NULL));
