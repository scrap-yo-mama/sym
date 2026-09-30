// SPDX-License-Identifier: AGPL-3.0-only
import { REDACTED, Secret } from '@runtime/core';
import { expect, test } from 'vitest';
import { auditMeta } from './audit.js';

test('méta d’audit : nom du champ sensible gardé, jamais sa valeur (13 § 9, INV8)', () => {
  const meta = auditMeta({
    field: 'llm.api_key',
    password: 'zz_test_pw',
    apiKey: 'zz_test_key',
    nested: { token: 'zz_test_tok', cookie: 'c', label: 'ok', value: new Secret('zz_test_secret') },
    scopes: ['apis:read'],
    prefix: 'sy_live_abcd',
  });
  expect(meta).toEqual({
    field: 'llm.api_key',
    password: REDACTED,
    apiKey: REDACTED,
    nested: { token: REDACTED, cookie: REDACTED, label: 'ok', value: REDACTED },
    scopes: ['apis:read'],
    prefix: 'sy_live_abcd',
  });
});
