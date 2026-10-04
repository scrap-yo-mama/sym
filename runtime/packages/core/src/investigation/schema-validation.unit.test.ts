// SPDX-License-Identifier: AGPL-3.0-only
// `validate_schema` avec corrections du client (constat Barnes) : le schéma validé est celui du client, et ce qui a changé
// par rapport à la proposition est calculé par le code (propriétés ajoutées, retirées, renommées, types, descriptions,
// champs requis) pour être MONTRÉ ; ce qui n'est pas applicable est dit (marques `x-personal` du client ignorées), jamais
// ignoré en silence. Consignes libres bornées (2 000 caractères), source candidate choisie parmi celles de la reconnaissance.
import { describe, expect, test } from 'vitest';
import { checkValidationSource, normalizeValidationInstructions, schemaValidationReport, VALIDATION_INSTRUCTIONS_MAX } from './schema-validation.js';

const PROPOSED = {
  type: 'object',
  additionalProperties: false,
  required: ['reference', 'type', 'price'],
  properties: {
    reference: { type: 'string', description: 'Listing reference' },
    type: { type: 'string', description: 'Type' },
    price: { type: 'number', description: 'Price in EUR' },
    agent_name: { type: 'string', description: 'Agent', 'x-personal': 'identifier' },
    title: { type: 'string', description: 'Title' },
  },
};

describe('schemaValidationReport : ce qui a changé entre la proposition et le schéma retenu', () => {
  test('aucune correction : rien de changé, non corrigé', () => {
    const report = schemaValidationReport(PROPOSED, PROPOSED);
    expect(report).toEqual({ corrected: false, changes: { added: [], removed: [], renamed: [], type_changed: [], description_changed: [], required_changed: [], other_changed: [] }, not_applied: [] });
  });

  test('cas Barnes : référence sans préfixe (description), vrai type de bien (renommé), prix retiré, pièces ajoutées, titre en tableau', () => {
    const corrected = {
      type: 'object',
      additionalProperties: false,
      required: ['reference', 'property_type', 'rooms'],
      properties: {
        reference: { type: 'string', description: 'Listing reference without the "carousel-" prefix' },
        property_type: { type: 'string', description: 'Type' },
        rooms: { type: 'integer', description: 'Number of rooms' },
        agent_name: { type: 'string', description: 'Agent' },
        title: { type: 'array', items: { type: 'string' }, description: 'Title' },
        city: { type: 'string', description: 'City', 'x-personal': 'identifier' },
      },
    };
    const report = schemaValidationReport(PROPOSED, corrected);
    expect(report.corrected).toBe(true);
    expect(report.changes).toEqual({
      added: ['rooms', 'city'],
      removed: ['price'],
      renamed: [{ from: 'type', to: 'property_type' }],
      type_changed: ['title'],
      description_changed: ['reference'],
      required_changed: ['rooms'],
      other_changed: [],
    });
    // Marques personnelles : celle que le client pose est ignorée, celle que l'enquête a détectée est gardée.
    expect(report.not_applied).toEqual([
      { code: 'personal_mark_ignored', field: 'city' },
      { code: 'personal_mark_kept', field: 'agent_name' },
    ]);
  });

  test('changement imbriqué (enum, format, items) : dit, jamais tu', () => {
    const corrected = { ...PROPOSED, properties: { ...PROPOSED.properties, type: { type: 'string', description: 'Type', enum: ['house', 'flat'] } } };
    expect(schemaValidationReport(PROPOSED, corrected).changes.other_changed).toEqual(['type']);
  });
});

describe('consignes libres du client', () => {
  test('bornées, sans caractères de contrôle ; vides : absentes', () => {
    expect(VALIDATION_INSTRUCTIONS_MAX).toBe(2000);
    expect(normalizeValidationInstructions('  Use the results list,\u0000 not the carousel.\n')).toBe('Use the results list, not the carousel.');
    expect(normalizeValidationInstructions('   ')).toBeNull();
    expect(normalizeValidationInstructions(undefined)).toBeNull();
    expect(() => normalizeValidationInstructions('x'.repeat(2001))).toThrow(/2000/);
  });
});

describe('source candidate choisie (D-124)', () => {
  const candidates = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3', unsupported: 'client_signature' }];
  test('identifiant connu et utilisable : accepté', () => {
    expect(checkValidationSource('c2', candidates)).toEqual({ ok: true, id: 'c2' });
  });
  test('inconnu ou inutilisable : refus avec la liste des identifiants valides', () => {
    expect(checkValidationSource('results-list', candidates)).toEqual({ ok: false, valid: ['c1', 'c2'] });
    expect(checkValidationSource('c3', candidates)).toEqual({ ok: false, valid: ['c1', 'c2'] });
    expect(checkValidationSource('c1', undefined)).toEqual({ ok: false, valid: [] });
  });
});
