// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.2 : « Schéma d'entrée sans description → refusé » (04 §1 : chaque champ a une description, 500 caractères au
// plus ; c'est ce que l'IA de l'utilisateur lit pour appeler l'API). Schéma d'entrée proposé après l'enquête (04 §4, G).
import { describe, expect, test } from 'vitest';
import { assertInputSchema, buildInputSchema, inputSchemaIssues, INPUT_DESCRIPTION_MAX } from './input-schema.js';
import { SchemaError, validateOutput } from './validator.js';

const described = (extra: Record<string, unknown> = {}) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { query: { type: 'string', description: 'Mots recherchés.' }, ...extra },
  additionalProperties: false,
});

describe('schéma d’entrée : chaque champ a une description (500 caractères au plus)', () => {
  test('assert_input_schema_described — un schéma dont tous les champs sont décrits est accepté', () => {
    expect(() => assertInputSchema(described())).not.toThrow();
    expect(inputSchemaIssues(described())).toEqual([]);
  });

  test('assert_input_schema_described — un champ sans description est refusé, avec son chemin', () => {
    const schema = described({ max_pages: { type: 'integer', minimum: 1 } });
    expect(inputSchemaIssues(schema)).toEqual([{ path: '/properties/max_pages', code: 'missing_description', message: expect.stringContaining('description') }]);
    expect(() => assertInputSchema(schema)).toThrow(SchemaError);
    try {
      assertInputSchema(schema);
    } catch (error) {
      expect(error).toMatchObject({ code: 'missing_description' });
      expect((error as Error).message).toContain('/properties/max_pages');
    }
  });

  test.each([
    ['vide', ''],
    ['espaces', '   \n\t '],
    ['pas une chaîne', 42],
    ['null', null],
  ])('assert_input_schema_described — description %s : refusée', (_name, description) => {
    expect(() => assertInputSchema(described({ n: { type: 'integer', description } }))).toThrow(expect.objectContaining({ code: 'missing_description' }));
  });

  test('description de plus de 500 caractères : refusée ; exactement 500 : acceptée', () => {
    expect(INPUT_DESCRIPTION_MAX).toBe(500);
    expect(() => assertInputSchema(described({ n: { type: 'integer', description: 'a'.repeat(500) } }))).not.toThrow();
    expect(() => assertInputSchema(described({ n: { type: 'integer', description: 'a'.repeat(501) } }))).toThrow(expect.objectContaining({ code: 'description_too_long' }));
  });

  test('les champs imbriqués (objet, tableau d’objets) sont décrits aussi ; un schéma booléen ne peut pas porter de description', () => {
    const nested = described({ filter: { type: 'object', description: 'Filtres.', properties: { city: { type: 'string' } } } });
    expect(inputSchemaIssues(nested).map((i) => i.path)).toEqual(['/properties/filter/properties/city']);
    const items = described({ ids: { type: 'array', description: 'Identifiants.', items: { type: 'object', properties: { id: { type: 'string' } } } } });
    expect(inputSchemaIssues(items).map((i) => i.path)).toEqual(['/properties/ids/items/properties/id']);
    expect(inputSchemaIssues(described({ any: true })).map((i) => i.code)).toEqual(['missing_description']);
  });

  test('la racine doit être un objet (les entrées sont nommées) ; un schéma sans propriété est un objet valide (aucune entrée)', () => {
    expect(() => assertInputSchema({ type: 'array', items: { type: 'string', description: 'x' } })).toThrow(expect.objectContaining({ code: 'invalid_schema' }));
    expect(() => assertInputSchema({ type: 'object', properties: {} })).not.toThrow();
    expect(() => assertInputSchema(true)).toThrow(expect.objectContaining({ code: 'invalid_schema' }));
  });

  test('les refus du validateur restent vrais pour une entrée : $ref distant refusé avant toute requête', () => {
    const remote = described({ x: { $ref: 'https://evil.example/schema.json', description: 'distant' } });
    expect(() => assertInputSchema(remote)).toThrow(expect.objectContaining({ code: 'remote_ref' }));
  });
});

describe('schéma d’entrée proposé après l’enquête', () => {
  test('stratégie paginée : max_pages (1 à 50) décrit, aucun autre champ ; le schéma proposé passe sa propre règle', () => {
    const schema = buildInputSchema({ paginated: true });
    expect(schema).toMatchObject({ type: 'object', properties: { max_pages: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false });
    expect(Object.keys((schema as { properties: object }).properties)).toEqual(['max_pages']);
    expect(() => assertInputSchema(schema)).not.toThrow();
    const description = (schema as { properties: { max_pages: { description: string } } }).properties.max_pages.description;
    expect(description.length).toBeGreaterThan(20);
    expect(description.length).toBeLessThanOrEqual(INPUT_DESCRIPTION_MAX);
  });

  test('stratégie sans pagination : aucune entrée, schéma vide valide', () => {
    const schema = buildInputSchema({ paginated: false });
    expect(schema).toMatchObject({ type: 'object', properties: {}, additionalProperties: false });
    expect(() => assertInputSchema(schema)).not.toThrow();
  });

  test('le plafond proposé suit le plafond dur de la stratégie, et l’entrée valide ou refuse en conséquence', () => {
    const schema = buildInputSchema({ paginated: true, maxPages: 30 });
    expect(validateOutput(schema, { max_pages: 30 })).toEqual({ ok: true });
    expect(validateOutput(schema, { max_pages: 31 })).toMatchObject({ ok: false });
    expect(validateOutput(schema, { max_pages: 0 })).toMatchObject({ ok: false });
    expect(validateOutput(schema, {})).toEqual({ ok: true });
    expect(validateOutput(schema, { pages: 2 })).toMatchObject({ ok: false });
  });

  test('des entrées proposées en plus (nom, type, description) sont reprises et refusées si une description manque', () => {
    const schema = buildInputSchema({ paginated: true, inputs: [{ name: 'query', type: 'string', description: 'Mots recherchés dans les annonces.', required: true }] });
    expect(schema).toMatchObject({ required: ['query'], properties: { query: { type: 'string', description: 'Mots recherchés dans les annonces.' } } });
    expect(() => buildInputSchema({ paginated: false, inputs: [{ name: 'query', type: 'string', description: ' ' }] })).toThrow(expect.objectContaining({ code: 'missing_description' }));
    expect(() => buildInputSchema({ paginated: true, inputs: [{ name: 'max_pages', type: 'string', description: 'Doublon.' }] })).toThrow(expect.objectContaining({ code: 'invalid_schema' }));
    expect(() => buildInputSchema({ paginated: false, inputs: [{ name: '__proto__', type: 'string', description: 'Interdit.' }] })).toThrow(expect.objectContaining({ code: 'invalid_schema' }));
  });
});
