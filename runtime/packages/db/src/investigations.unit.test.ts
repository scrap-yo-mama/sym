// SPDX-License-Identifier: AGPL-3.0-only
// Demande d'enquête (tâche 2.1, 05 §4.1, 04 §4) : URL http(s) sans identifiants, description bornée, plafonds bornés.
import { INVESTIGATION_DEFAULTS } from '@runtime/core/investigation';
import { describe, expect, test } from 'vitest';
import { normalizeInvestigationRequest } from './investigations.js';

describe('normalizeInvestigationRequest', () => {
  test('défauts des plafonds, fragment retiré, auto_validate faux par défaut', () => {
    expect(normalizeInvestigationRequest({ url: 'https://shop.test/list#top', description: '  liste  ' })).toEqual({
      url: 'https://shop.test/list',
      description: 'liste',
      auto_validate: false,
      budget_usd: INVESTIGATION_DEFAULTS.budgetUsd,
      timeout_s: INVESTIGATION_DEFAULTS.timeoutSeconds,
    });
  });

  test.each([
    [{ url: 'ftp://shop.test/', description: 'x' }],
    [{ url: 'https://user:pass@shop.test/', description: 'x' }],
    [{ url: 'pas une url', description: 'x' }],
    [{ url: 'https://shop.test/', description: '' }],
    [{ url: 'https://shop.test/', description: 'x'.repeat(2001) }],
    [{ url: 'https://shop.test/', description: 'x', budget_usd: -1 }],
    [{ url: 'https://shop.test/', description: 'x', timeout_s: 0 }],
  ])('refus : %j', (input) => {
    expect(() => normalizeInvestigationRequest(input)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });
});
