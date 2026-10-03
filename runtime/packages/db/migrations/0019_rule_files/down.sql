-- SPDX-License-Identifier: AGPL-3.0-only
DROP VIEW admin_rule_usage;
ALTER TABLE run_attempts DROP COLUMN rule_refs;
DELETE FROM strategy_versions WHERE created_by = 'recompile';
ALTER TABLE strategy_versions DROP CONSTRAINT strategy_versions_created_by_check;
ALTER TABLE strategy_versions ADD CONSTRAINT strategy_versions_created_by_check
  CHECK (created_by IN ('investigation', 'repair', 'user', 'revert', 'import'));
ALTER TABLE strategy_versions DROP COLUMN source;
DROP TABLE strategy_version_rules;
DROP TABLE rule_file_versions;
DROP TABLE rule_files;
DROP FUNCTION rule_file_versions_immutable();
DROP FUNCTION rule_file_versions_forced_review();
