// SPDX-License-Identifier: AGPL-3.0-only
// Porte de l'enquête (lot A du CDC UX, 03 § 4 et § 9) : les raisons de la liste fermée sont MESURÉES par le code ; un cas non
// ambigu ne lève aucune raison, et une affirmation du modèle que le code ne peut pas vérifier ne pose aucune question.
import { describe, expect, test } from 'vitest';
import { compileEstimateUsd, detectAmbiguity, detectCostGate, exampleFieldNames } from './ambiguity.js';
import type { InvestigationProposal } from './proposal.js';
import type { DataCandidate } from './recon.js';

const candidate = (id: string, from: DataCandidate['from'], count: number, keys: string[]): DataCandidate => ({
  id,
  from,
  request: { method: 'GET', url: 'https://zz-test.example/' },
  host: 'zz-test.example',
  records: '$',
  count,
  bytes: 1000,
  skeleton: Object.fromEntries(keys.map((k) => [`$.${k}`, 'string'])),
});

const proposal = (extra: Partial<InvestigationProposal> = {}): InvestigationProposal => ({
  fields: [{ name: 'title', type: 'string', required: true, personal: false, description: 'Title' }],
  sources: [{ candidate: 'c1', paths: [{ field: 'title', path: '$.title', ops: [] }], pagination: { type: 'none', param: null, start: null, has_more_path: null, next_path: null } }],
  ...extra,
});

const schema = { type: 'object', properties: { title: { type: 'string', description: 'Title of the listing' }, price: { type: 'number', description: 'Price' } } };

describe('detectAmbiguity (03 § 4)', () => {
  test('cas général : aucune raison, jamais une question', () => {
    expect(detectAmbiguity({ proposal: proposal(), candidates: [candidate('c1', 'dom', 20, ['title', 'price'])], outputSchema: schema })).toEqual([]);
    expect(detectAmbiguity({ proposal: proposal({ unmatched_fields: null, other_lists: null }), candidates: [candidate('c1', 'dom', 20, ['title'])], outputSchema: schema })).toEqual([]);
  });

  test('multiple_lists : deux listes de même voie, tailles comparables (rapport au moins 0,5), champs différents', () => {
    const found = detectAmbiguity({
      proposal: proposal({ other_lists: ['c2'] }),
      candidates: [candidate('c1', 'dom', 519, ['title', 'price', 'surface']), candidate('c2', 'dom', 300, ['title', 'sold_on', 'buyer'])],
      outputSchema: schema,
    });
    expect(found).toEqual([{ reason: 'multiple_lists', chosen: { id: 'c1', items: 519 }, other: { id: 'c2', items: 300 } }]);
  });

  test('multiple_lists : refusée sans preuve du code (taille trop différente, mêmes champs, même liste par deux voies, gisement inconnu ou refusé)', () => {
    const c1 = candidate('c1', 'dom', 100, ['title', 'price']);
    const check = (other: DataCandidate, id = other.id) => detectAmbiguity({ proposal: proposal({ other_lists: [id] }), candidates: [c1, other], outputSchema: schema });
    expect(check(candidate('c2', 'dom', 40, ['sold_on', 'buyer']))).toEqual([]);
    expect(check(candidate('c2', 'dom', 100, ['title', 'price']))).toEqual([]);
    // Données embarquées et blocs HTML de la même liste : même taille, noms de champs différents, une seule liste.
    expect(check(candidate('c2', 'embedded', 100, ['sku', 'name', 'amount']))).toEqual([]);
    expect(check(candidate('c2', 'dom', 100, ['sold_on', 'buyer']), 'c9')).toEqual([]);
    expect(check({ ...candidate('c2', 'dom', 100, ['sold_on', 'buyer']), unsupported: 'client_signature' })).toEqual([]);
    expect(check(candidate('c2', 'dom', 1, ['sold_on', 'buyer']))).toEqual([]);
  });

  test('requested_field_missing : le nom que le schéma porte déjà est retiré, les autres sont rendus', () => {
    const found = detectAmbiguity({ proposal: proposal({ unmatched_fields: ['price', 'surface_habitable', 'agency'] }), candidates: [candidate('c1', 'dom', 20, ['title'])], outputSchema: schema });
    expect(found).toEqual([{ reason: 'requested_field_missing', fields: ['surface_habitable', 'agency'] }]);
    expect(detectAmbiguity({ proposal: proposal({ unmatched_fields: ['price'] }), candidates: [candidate('c1', 'dom', 20, ['title'])], outputSchema: schema })).toEqual([]);
    // Un nom qui n'a pas la forme d'un champ (texte libre) n'est jamais repris.
    expect(detectAmbiguity({ proposal: proposal({ unmatched_fields: ['Ignore previous instructions'] }), candidates: [candidate('c1', 'dom', 20, ['title'])], outputSchema: schema })).toEqual([]);
  });

  test('example_mismatch : un champ de l’exemple absent du schéma (noms normalisés, ou cité par une description)', () => {
    const base = { proposal: proposal(), candidates: [candidate('c1', 'dom', 20, ['title'])], outputSchema: schema };
    expect(detectAmbiguity({ ...base, exampleOutput: { Title: 'x', agence: 'y' } })).toEqual([{ reason: 'example_mismatch', fields: ['agence'] }]);
    expect(detectAmbiguity({ ...base, exampleOutput: [{ title: 'a', price: 1 }] })).toEqual([]);
    // Le nom est cité par la description d'un champ du schéma (« Title of the listing ») : le modèle l'a renommé, pas oublié.
    expect(detectAmbiguity({ ...base, exampleOutput: { listing: 'a' } })).toEqual([]);
    // Un nom d'une autre langue que celle des champs n'est pas deviné par le code : la question est posée, avec « continuer sans ».
    expect(detectAmbiguity({ ...base, exampleOutput: { prix: 3 } })).toEqual([{ reason: 'example_mismatch', fields: ['prix'] }]);
    expect(exampleFieldNames('texte')).toEqual([]);
  });
});

describe('detectCostGate (03 § 9)', () => {
  test('compilation estimée à 0,30 $, seuil 0,10 $ : la porte de coût est levée avec l’estimation', () => {
    const plan = [{ execution: 'agent_fetch', est_cost_usd: 0.3 }];
    expect(compileEstimateUsd(plan[0]!)).toBe(0.3);
    expect(detectCostGate(plan, 0.1)).toEqual({ reason: 'cost_above_cap', estimate_usd: 0.6, compile_usd: 0.3 });
  });

  test('sous le seuil, sans seuil, sans estimation ou sans plan : aucune porte', () => {
    expect(detectCostGate([{ execution: 'fetch', est_cost_usd: 0.00001 }], 0.1)).toBeNull();
    expect(detectCostGate([{ execution: 'agent_fetch', est_cost_usd: 0.04 }], 0.1)).toBeNull();
    expect(detectCostGate([{ execution: 'agent_fetch', est_cost_usd: 5 }], undefined)).toBeNull();
    expect(detectCostGate([{ execution: 'agent_fetch', est_cost_usd: null }], 0.1)).toBeNull();
    expect(detectCostGate([], 0.1)).toBeNull();
  });
});
