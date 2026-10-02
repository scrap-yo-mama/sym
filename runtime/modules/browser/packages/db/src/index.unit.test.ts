// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest';
import { TABLES } from './index.js';

test('@sym-browser/db (squelette) : les neuf tables de 03 § 5, sans doublon', () => {
  expect(TABLES).toHaveLength(12);
  expect(new Set(TABLES).size).toBe(TABLES.length);
  expect(TABLES).toContain('sessions');
  expect(TABLES).toContain('usage_records');
});
