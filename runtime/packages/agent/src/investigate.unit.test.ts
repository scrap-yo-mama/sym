// SPDX-License-Identifier: AGPL-3.0-only
// Rôle `investigate` (tâche 2.1) : le prompt ne porte que la demande du propriétaire, des faits d'accès en booléens et
// les SQUELETTES des gisements (chemins, types), encadrés comme donnée non fiable par un jeton que le site ne peut pas
// fermer ; jamais une valeur de la page, jamais un gisement `unsupported` ; la réponse est structurée et validée.
import type { DataCandidate } from '@runtime/core/investigation';
import { Secret } from '@runtime/core';
import { createLlmClient } from '@runtime/llm';
import { createFakeProvider, scripted } from '@runtime/llm/testing';
import { describe, expect, test } from 'vitest';
import { INVESTIGATE_MAX_TOKENS, investigateCallCeilingUsd, investigateMessages, investigatePromptVersion, proposeInvestigation } from './investigate.js';

const candidate = (over: Partial<DataCandidate> = {}): DataCandidate => ({
  id: 'c1',
  from: 'response',
  request: { method: 'GET', url: 'https://shop.test/api/items?page=1&q=secret-query-value' },
  host: 'shop.test',
  records: '$.items[*]',
  count: 20,
  bytes: 4000,
  skeleton: { '$.id': 'string', '$.price': 'number', '$.untrusted_candidates_x': 'string' },
  ...over,
});

describe('prompt du rôle investigate', () => {
  test('squelettes et noms de paramètres seulement ; balise à jeton non fermable ; gisement unsupported absent', () => {
    const [system, user] = investigateMessages(
      { description: 'liste des articles', candidates: [candidate(), candidate({ id: 'c2', unsupported: 'client_signature', request: { method: 'GET', url: 'https://shop.test/api/signed?sig=deadbeef' } })], accessFacts: { robots: 'allowed', proceed: true } },
      'tok123',
    );
    expect(system!.role).toBe('system');
    const text = String(user!.content);
    expect(text).toContain('<untrusted_candidates_tok123>');
    expect(text).toContain('</untrusted_candidates_tok123>');
    expect(text).toContain('"$.price":"number"');
    expect(text).toContain('"query_parameters":["page","q"]');
    // Ni valeur de paramètre, ni gisement non supporté, ni balise imitée par une clé du site.
    expect(text).not.toContain('secret-query-value');
    expect(text).not.toContain('/api/signed');
    expect(text).not.toContain('untrusted_candidates_x');
    expect(investigatePromptVersion).toMatch(/^investigate-[0-9a-f]{12}$/);
  });

  test('réponse structurée validée ; une réponse hors schéma est refusée par la couche LLM', async () => {
    const fake = await createFakeProvider();
    try {
      const client = createLlmClient({ providers: [{ id: 'f', baseUrl: fake.baseUrl, apiKey: new Secret('zz-test-key-0000'), models: [{ id: 'inv', price: { in: 1, out: 1 } }] }], roles: { investigate: { provider: 'f', model: 'inv' } } });
      const good = { fields: [{ name: 'id', type: 'string', required: true, personal: false, description: 'Id' }], sources: [{ candidate: 'c1', paths: [{ field: 'id', path: '$.id', ops: [] }], pagination: { type: 'none', param: null, start: null, has_more_path: null, next_path: null } }] };
      fake.setScenario('inv', [scripted.json(good)]);
      const out = await proposeInvestigation(client, { description: 'x', candidates: [candidate()] });
      expect(out.proposal).toEqual(good);
      fake.setScenario('inv', [scripted.json({ fields: [{ name: 'Bad Name', type: 'date' }] }), scripted.json({ nope: 1 }), scripted.json({ nope: 2 })]);
      await expect(proposeInvestigation(client, { description: 'x', candidates: [candidate()] })).rejects.toThrow();
    } finally {
      await fake.close();
    }
  });

  test('coût d’un appel borné AVANT l’envoi (correctif 13) : sortie plafonnée par max_tokens, entrée estimée par excès', async () => {
    const fake = await createFakeProvider();
    try {
      const price = { in: 3, out: 15 };
      const client = createLlmClient({ providers: [{ id: 'f', baseUrl: fake.baseUrl, apiKey: new Secret('zz-test-key-0000'), models: [{ id: 'inv', price }] }], roles: { investigate: { provider: 'f', model: 'inv' } } });
      const good = { fields: [{ name: 'id', type: 'string', required: true, personal: false, description: 'Id' }], sources: [] };
      const args = { description: 'liste des articles', candidates: [candidate()] };
      const ceiling = investigateCallCeilingUsd(args, price);
      expect(ceiling).toBeGreaterThanOrEqual((INVESTIGATE_MAX_TOKENS * price.out) / 1e6);
      // Le fournisseur facture au plus max_tokens en sortie et, en entrée, moins que l'estimation (caractères / 3).
      const promptChars = investigateMessages(args).reduce((n, m) => n + String(m.content).length, 0);
      fake.setScenario('inv', [scripted.json(good, { prompt_tokens: Math.ceil(promptChars / 3), completion_tokens: INVESTIGATE_MAX_TOKENS })]);
      await proposeInvestigation(client, args);
      expect(fake.calls[0]!.body).toMatchObject({ max_tokens: INVESTIGATE_MAX_TOKENS });
      const spent = client.meter.snapshot().cost_usd_known ?? 0;
      expect(spent).toBeGreaterThan(0);
      expect(spent).toBeLessThanOrEqual(ceiling);
    } finally {
      await fake.close();
    }
  });
});
