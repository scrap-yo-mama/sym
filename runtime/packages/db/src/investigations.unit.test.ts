// SPDX-License-Identifier: AGPL-3.0-only
// Demande d'enquête (tâche 2.1, 05 §4.1, 04 §4) : URL http(s) sans identifiants, description bornée, plafonds bornés.
import { INVESTIGATION_DEFAULTS } from '@runtime/core/investigation';
import { describe, expect, test } from 'vitest';
import { normalizeInvestigationRequest, saveInvestigationStrategy } from './investigations.js';

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

describe('normalizeInvestigationRequest : aucun secret dans l’URL gardée par l’état (hors rétention, 17 §6)', () => {
  test.each(['token', 'access_token', 'key', 'api_key', 'apikey', 'session', 'sessionid', 'sig', 'signature', 'X-Amz-Signature', 'auth', 'password'])('paramètre %s refusé', (name) => {
    expect(() => normalizeInvestigationRequest({ url: `https://shop.test/list?${name}=zz_secret_value`, description: 'x' })).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });

  test('paramètres ordinaires admis (page, q, category, sort)', () => {
    expect(normalizeInvestigationRequest({ url: 'https://shop.test/list?page=2&q=velo&category=7&sort=price', description: 'x' }).url).toBe('https://shop.test/list?page=2&q=velo&category=7&sort=price');
  });
});

describe('saveInvestigationStrategy : schéma d’entrée décrit (tâche 2.2)', () => {
  const baseArgs = {
    apiId: '00000000-0000-4000-8000-000000000001',
    ownerId: '00000000-0000-4000-8000-000000000002',
    execution: 'fetch' as const,
    network: 'direct' as const,
    spec: {},
    estCostUsd: 0,
    outputSchema: { type: 'object', properties: {} },
    state: {} as Parameters<typeof saveInvestigationStrategy>[1]['state'],
  };
  /** Pool qui échoue si on le touche : le refus a lieu avant toute écriture, donc sans base. */
  const untouched = { connect: () => Promise.reject(new Error('base touchée')), query: () => Promise.reject(new Error('base touchée')) } as unknown as Parameters<typeof saveInvestigationStrategy>[0];

  test('assert_input_schema_described — un schéma d’entrée dont un champ n’a pas de description est refusé (invalid_schema), aucune écriture', async () => {
    const inputSchema = { type: 'object', properties: { max_pages: { type: 'integer' } }, additionalProperties: false };
    await expect(saveInvestigationStrategy(untouched, { ...baseArgs, inputSchema })).rejects.toMatchObject({ name: 'InvestigationStateError', code: 'invalid_schema', message: expect.stringContaining('/properties/max_pages') });
  });

  test('assert_input_schema_described — description de plus de 500 caractères et racine qui n’est pas un objet : refusés', async () => {
    const long = { type: 'object', properties: { q: { type: 'string', description: 'x'.repeat(501) } } };
    await expect(saveInvestigationStrategy(untouched, { ...baseArgs, inputSchema: long })).rejects.toMatchObject({ code: 'invalid_schema' });
    await expect(saveInvestigationStrategy(untouched, { ...baseArgs, inputSchema: { type: 'array' } })).rejects.toMatchObject({ code: 'invalid_schema' });
  });
});
