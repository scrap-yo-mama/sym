-- SPDX-License-Identifier: AGPL-3.0-only
DROP TABLE strategy_version_memory_refs;
DROP FUNCTION memory_refs_owner_bound();
DROP TABLE run_profiles;
DROP FUNCTION run_profiles_owner_bound();
ALTER TABLE runs DROP COLUMN judge;
ALTER TABLE runs DROP COLUMN quality;
ALTER TABLE strategy_versions DROP COLUMN signature;
