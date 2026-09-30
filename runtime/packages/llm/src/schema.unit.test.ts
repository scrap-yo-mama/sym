import { describe, expect, test } from 'vitest';
import { LlmError } from './errors.js';
import { assertNoRemoteRefs, extractJson, restoreOptionals, toTransportSchema, validateOriginal, wrapRoot } from './schema.js';

const original = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 2, maxLength: 50 },
    price: { type: 'number', minimum: 0 },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    note: { type: 'string' },
    'x-hidden': { type: 'string' },
  },
  required: ['title', 'price'],
  'x-personal': true,
};

describe('schéma de transport dérivé', () => {
  const t = toTransportSchema(original) as Record<string, unknown> & { properties: Record<string, Record<string, unknown>> };

  test('tout required, optionnels nullables, additionalProperties false', () => {
    expect(t['required']).toEqual(['title', 'price', 'tags', 'note', 'x-hidden']);
    expect(t['additionalProperties']).toBe(false);
    expect(t.properties['note']?.['type']).toEqual(['string', 'null']);
    expect(t.properties['tags']?.['type']).toEqual(['array', 'null']);
    expect(t.properties['title']?.['type']).toBe('string');
  });

  test('contraintes non supportées déplacées en description, mots-clés x- et $schema retirés', () => {
    expect(t.properties['title']?.['minLength']).toBeUndefined();
    expect(t.properties['title']?.['description']).toContain('minLength=2');
    expect(t.properties['price']?.['description']).toContain('minimum=0');
    expect(t['$schema']).toBeUndefined();
    expect(t['x-personal']).toBeUndefined();
  });

  test('racine non objet enveloppée', () => {
    expect(wrapRoot(toTransportSchema({ type: 'array', items: { type: 'string' } })).wrapped).toBe(true);
    expect(wrapRoot(t).wrapped).toBe(false);
  });

  test('$ref distant refusé, $ref local admis', () => {
    expect(() => assertNoRemoteRefs({ properties: { a: { $ref: 'https://evil.example/s.json' } } })).toThrow(LlmError);
    expect(() => toTransportSchema({ type: 'object', properties: { a: { $ref: 'http://x/y' } } })).toThrow(/distant/);
    expect(() => assertNoRemoteRefs({ $defs: { a: { type: 'string' } }, properties: { a: { $ref: '#/$defs/a' } } })).not.toThrow();
  });
});

describe('validation Ajv finale sur le schéma d\'origine (INV1)', () => {
  test('null sur un optionnel non nullable est retiré, puis valide', () => {
    const out = validateOriginal(original, { title: 'Ab', price: 3, tags: null, note: null, 'x-hidden': null });
    expect(out).toEqual({ ok: true, value: { title: 'Ab', price: 3 } });
  });

  test('une contrainte déplacée en description reste appliquée par Ajv', () => {
    const out = validateOriginal(original, { title: 'A', price: -1, tags: null, note: null, 'x-hidden': null });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.errors.join(' ')).toMatch(/minLength|fewer than|shorter|must NOT/i);
      // les valeurs ne fuient pas dans les erreurs
      expect(out.errors.join(' ')).not.toContain('-1');
    }
  });

  test('propriété inconnue admise ou non selon le schéma d\'origine', () => {
    expect(validateOriginal({ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } }, { a: 'x', b: 1 }).ok).toBe(false);
    expect(validateOriginal({ type: 'object', properties: { a: { type: 'string' } } }, { a: 'x', b: 1 }).ok).toBe(true);
  });

  test('schéma invalide => bad_request, pas de succès', () => {
    expect(() => validateOriginal({ type: 'nonsense' }, {})).toThrow(LlmError);
  });

  test('null conservé si le schéma d\'origine l\'admet', () => {
    const s = { type: 'object', properties: { a: { type: ['string', 'null'] } } };
    expect(restoreOptionals({ a: null }, s)).toEqual({ a: null });
  });
});

describe('extraction JSON (S4)', () => {
  test.each([
    ['{"a":1}', { a: 1 }],
    ['Voici : ```json\n{"a":2}\n```', { a: 2 }],
    ['Sure! The answer is {"a": "x}y", "b": [1,2]} hope it helps', { a: 'x}y', b: [1, 2] }],
    ['[1,2,3]', [1, 2, 3]],
  ])('%s', (text, expected) => {
    expect(extractJson(text)).toEqual(expected);
  });
  test('texte sans JSON : erreur', () => {
    expect(() => extractJson('pas de json ici')).toThrow();
  });
});
