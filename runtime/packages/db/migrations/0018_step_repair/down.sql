-- SPDX-License-Identifier: AGPL-3.0-only
DROP TRIGGER strategy_versions_instructed_reset ON strategy_versions;
DROP FUNCTION strategy_versions_instructed_reset();
DROP TRIGGER apis_instructed_mode_guard ON apis;
DROP FUNCTION apis_instructed_mode_guard();
ALTER TABLE run_attempts DROP COLUMN tokens_out, DROP COLUMN tokens_in, DROP COLUMN step_outcome, DROP COLUMN step_level, DROP COLUMN step_id;
ALTER TABLE strategy_versions DROP COLUMN source_steps, DROP COLUMN archive_reason, DROP COLUMN instructed_steps_confirmed, DROP COLUMN instructed_steps_sha256,
  DROP COLUMN instructed_steps, DROP COLUMN compilable;
ALTER TABLE apis DROP COLUMN instructed_mode;
