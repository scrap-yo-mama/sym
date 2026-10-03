// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest';
import { describeRole, ROLE } from './describe.js';

test('passerelle (squelette) : rôle gateway, API v1, Playwright 1.63.0', () => {
  expect(ROLE).toBe('gateway');
  expect(describeRole()).toBe('SYM Browser gateway : API /v1, Playwright 1.63.0 (squelette, tâche 0.1)');
});
