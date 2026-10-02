// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest';
import { TABLES } from './index.js';

test('@sym-browser/db : les neuf tables de 03 § 5, idempotency_keys (2.2) et webhook_deliveries (2.5), sans doublon', () => {
  expect(TABLES).toHaveLength(11);
  expect(TABLES).toContain('webhook_deliveries');
  expect(new Set(TABLES).size).toBe(TABLES.length);
  expect(TABLES).toContain('sessions');
  expect(TABLES).toContain('usage_records');
});
