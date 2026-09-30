import dns from 'node:dns';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FAILURE_CLASSES, isFailureClass } from '../model/enums.js';
import {
  assertSchemaAcceptable,
  clearSchemaCache,
  compileSchema,
  DEFAULT_SCHEMA_LIMITS,
  findRemoteRefs,
  formatIssues,
  SchemaError,
  validateOutput,
} from './validator.js';

const offerSchema = {
  type: 'object',
  properties: { titre: { type: 'string' }, prix: { type: 'number' } },
  required: ['titre', 'prix'],
  additionalProperties: false,
};

/** Compte toute tentative de sortie réseau : fetch, socket TCP, résolution DNS. */
function watchNetwork() {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('réseau interdit'));
  const connectSpy = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(() => {
    throw new Error('réseau interdit');
  });
  const lookupSpy = vi.spyOn(dns, 'lookup').mockImplementation((() => {
    throw new Error('réseau interdit');
  }) as unknown as typeof dns.lookup);
  return () => fetchSpy.mock.calls.length + connectSpy.mock.calls.length + lookupSpy.mock.calls.length;
}

beforeEach(() => clearSchemaCache());
afterEach(() => vi.restoreAllMocks());

describe('assert_output_schema_enforced', () => {
  test('une sortie sans le champ requis `prix` est refusée, avec un message lisible', () => {
    const result = validateOutput(offerSchema, { titre: 'Vélo' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([{ path: '(racine)', keyword: 'required', message: 'propriété requise absente : prix' }]);
  });

  test('type erroné, propriété en trop, plusieurs erreurs à la fois ; aucune valeur dans les messages', () => {
    const result = validateOutput(offerSchema, { titre: 'secret-token-123', prix: 'cher', extra: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = formatIssues(result.errors);
    expect(text).toContain('/prix : type attendu : number');
    expect(text).toContain('propriété non autorisée : extra');
    expect(text).not.toContain('secret-token-123');
    expect(text).not.toContain('cher');
  });

  test('une sortie conforme passe ; le schéma d origine n est pas modifié', () => {
    const before = JSON.stringify(offerSchema);
    expect(validateOutput(offerSchema, { titre: 'Vélo', prix: 120 })).toEqual({ ok: true });
    expect(JSON.stringify(offerSchema)).toBe(before);
  });

  test('`$ref` distant : refus invalid/remote_ref SANS aucune requête (fetch, socket, DNS : 0)', () => {
    const requests = watchNetwork();
    const remote = { type: 'object', properties: { a: { $ref: 'https://evil.example/s.json' } } };
    for (const schema of [
      remote,
      { $ref: 'http://169.254.169.254/latest/meta-data' },
      { $defs: { x: { $dynamicRef: 'https://evil.example/d.json#x' } } },
      { properties: { a: { $ref: 'other.json#/defs/a' } } },
      { properties: { a: { $ref: '//evil.example/s.json' } } },
    ]) {
      expect(() => validateOutput(schema, {})).toThrowError(SchemaError);
      try {
        compileSchema(schema);
      } catch (e) {
        expect((e as SchemaError).code).toBe('remote_ref');
      }
    }
    expect(requests()).toBe(0);
  });

  test('`$ref` local (#/$defs) accepté et appliqué', () => {
    const schema = { $defs: { n: { type: 'number' } }, type: 'object', properties: { p: { $ref: '#/$defs/n' } }, required: ['p'] };
    expect(validateOutput(schema, { p: 1 })).toEqual({ ok: true });
    expect(validateOutput(schema, { p: 'x' }).ok).toBe(false);
  });
});

describe('limites et forme du schéma', () => {
  test('profondeur excessive refusée', () => {
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < DEFAULT_SCHEMA_LIMITS.maxDepth + 5; i += 1) deep = { type: 'array', items: deep };
    expect(() => compileSchema(deep)).toThrowError(expect.objectContaining({ code: 'schema_too_deep' }));
  });

  test('taille excessive refusée (octets, noeuds)', () => {
    const big = { enum: ['x'.repeat(DEFAULT_SCHEMA_LIMITS.maxBytes)] };
    expect(() => compileSchema(big)).toThrowError(expect.objectContaining({ code: 'schema_too_large' }));
    const many = { anyOf: Array.from({ length: 6000 }, () => ({ type: 'string' })) };
    expect(() => compileSchema(many)).toThrowError(expect.objectContaining({ code: 'schema_too_large' }));
    expect(() => assertSchemaAcceptable(big, { ...DEFAULT_SCHEMA_LIMITS, maxBytes: 10 ** 7 })).not.toThrow();
  });

  test('schéma invalide ou non objet : invalid_schema', () => {
    expect(() => compileSchema({ type: 'nimportequoi' })).toThrowError(expect.objectContaining({ code: 'invalid_schema' }));
    expect(() => compileSchema('string')).toThrowError(expect.objectContaining({ code: 'invalid_schema' }));
    expect(() => compileSchema(null)).toThrowError(expect.objectContaining({ code: 'invalid_schema' }));
  });

  test('`$schema` : 2020-12 accepté, autre draft refusé', () => {
    expect(() => compileSchema({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string' })).not.toThrow();
    expect(() => compileSchema({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'string' })).toThrowError(SchemaError);
  });

  test('schémas booléens', () => {
    expect(validateOutput(true, 1)).toEqual({ ok: true });
    expect(validateOutput(false, 1).ok).toBe(false);
  });

  test('draft 2020-12 : prefixItems et unevaluatedProperties', () => {
    expect(validateOutput({ prefixItems: [{ type: 'string' }, { type: 'number' }], items: false }, ['a', 1])).toEqual({ ok: true });
    expect(validateOutput({ prefixItems: [{ type: 'string' }], items: false }, ['a', 1]).ok).toBe(false);
  });

  test('erreurs plafonnées', () => {
    const result = validateOutput({ type: 'array', items: { type: 'string' } }, Array.from({ length: 100 }, () => 1));
    expect(result.ok || result.errors.length).toBe(20);
  });
});

describe('cache de compilation', () => {
  test('même schéma (même contenu) : même fonction compilée', () => {
    expect(compileSchema({ ...offerSchema })).toBe(compileSchema(JSON.parse(JSON.stringify(offerSchema))));
  });
  test('schémas différents : fonctions différentes', () => {
    expect(compileSchema({ type: 'string' })).not.toBe(compileSchema({ type: 'number' }));
  });
});

describe('findRemoteRefs', () => {
  test('ne signale que les références non locales', () => {
    expect(findRemoteRefs({ a: { $ref: '#/x' }, b: [{ $ref: 'https://x.test/y' }] })).toEqual(['#/b/0/$ref']);
  });
});

describe('failure_class', () => {
  test('liste fermée + famille llm_*', () => {
    for (const c of FAILURE_CLASSES) expect(isFailureClass(c)).toBe(true);
    expect(isFailureClass('llm_refusal')).toBe(true);
    expect(isFailureClass('llm_')).toBe(false);
    expect(isFailureClass('schema_mismatch')).toBe(false);
    expect(isFailureClass('LLM_x')).toBe(false);
  });
});
