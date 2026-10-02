// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest';
import { TABLES } from './index.js';

test('@sym-browser/db : les neuf tables de 03 § 5, idempotency_keys (2.2), webhook_deliveries (2.5), usage_snapshots et usage_reconciliations (2.6), sans doublon', () => {
  expect(TABLES).toHaveLength(13);
  expect(TABLES).toContain('webhook_deliveries');
  expect(TABLES).toContain('usage_snapshots');
  expect(TABLES).toContain('usage_reconciliations');
  expect(new Set(TABLES).size).toBe(TABLES.length);
  expect(TABLES).toContain('sessions');
  expect(TABLES).toContain('usage_records');
});
