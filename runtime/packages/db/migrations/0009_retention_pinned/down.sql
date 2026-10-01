-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE datasets DROP CONSTRAINT IF EXISTS datasets_pinned_exemption_check;
ALTER TABLE datasets DROP COLUMN IF EXISTS pinned_until, DROP COLUMN IF EXISTS pinned_reason;
