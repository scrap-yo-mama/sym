-- SPDX-License-Identifier: AGPL-3.0-only
DROP VIEW admin_rejected_metadata;
DROP VIEW run_rejected_aggregates;
DROP TABLE run_rejected_items;
DROP FUNCTION run_rejected_items_owner_bound();
ALTER TABLE runs DROP COLUMN items_rejected;
