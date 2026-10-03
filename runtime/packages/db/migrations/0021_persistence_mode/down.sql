-- SPDX-License-Identifier: AGPL-3.0-only
DROP TABLE persistence_domain_slots;
DROP TABLE api_persistence;
ALTER TABLE apis DROP COLUMN persistence_budget_usd, DROP COLUMN persistence_mode;
