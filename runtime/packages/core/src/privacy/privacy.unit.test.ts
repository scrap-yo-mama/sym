import { describe, expect, test } from 'vitest';
import { MasterKey } from '../crypto/master-key.js';
import { SecretValueRegistry } from '../crypto/redact.js';
import {
  boundErrorDetail,
  extractPersonalValues,
  filterExcludedItems,
  maskPersonal,
  maskPersonalText,
  normalizeSubjectValue,
  PERSONAL_MASK,
  PersonalValueRegistry,
  schemaHasPersonalFields,
  subjectHash,
} from './index.js';

const schema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    email: { type: 'string', 'x-personal': 'identifier' },
    author: { type: 'object', properties: { name: { type: 'string', 'x-personal': true }, city: { type: 'string' } } },
    phones: { type: 'array', items: { type: 'string', 'x-personal': true } },
  },
};
const alice = { title: 'Post', email: 'Alice.Martin@Example.test', author: { name: 'Alice Martin', city: 'Lyon' }, phones: ['+33 6 12 34 56 78'] };

describe('valeurs x-personal', () => {
  test('extraction : seuls les champs annotés, y compris imbriqués et en tableau', () => {
    expect(extractPersonalValues(schema, alice).sort()).toEqual(['+33 6 12 34 56 78', 'Alice Martin', 'Alice.Martin@Example.test']);
    expect(extractPersonalValues(schema, { title: 'x' })).toEqual([]);
    expect(schemaHasPersonalFields(schema)).toBe(true);
    expect(schemaHasPersonalFields({ type: 'object', properties: { a: { type: 'string' } } })).toBe(false);
  });

  test('normalisation : casse, espaces, téléphone réduit à ses chiffres', () => {
    expect(normalizeSubjectValue('  Alice   MARTIN ')).toBe('alice martin');
    expect(normalizeSubjectValue('06 12 34 56 78')).toBe(normalizeSubjectValue('06.12.34.56.78'));
    expect(normalizeSubjectValue('+33 6 12 34 56 78')).toBe('+33612345678');
  });
});

describe('empreinte HMAC des sujets', () => {
  const key = MasterKey.generate().kek('subjects');
  test('stable, insensible à la forme, dépendante de la clé (pas un hash nu)', () => {
    expect(subjectHash(key, 'Alice.Martin@example.test')).toBe(subjectHash(key, ' alice.martin@EXAMPLE.test '));
    expect(subjectHash(key, 'a@example.test')).toMatch(/^[0-9a-f]{64}$/);
    const other = MasterKey.generate().kek('subjects');
    expect(subjectHash(other, 'a@example.test')).not.toBe(subjectHash(key, 'a@example.test'));
    expect(subjectHash(key, 'a@example.test')).not.toBe(MasterKey.generate().kek('secrets').toString('hex'));
  });

  test('filtre d’écriture : un sujet exclu n’est pas réécrit', () => {
    const excluded = new Set([subjectHash(key, 'alice.martin@example.test')]);
    const bob = { email: 'bob@example.test' };
    const { kept, dropped } = filterExcludedItems(key, excluded, schema, [alice, bob]);
    expect(kept).toEqual([bob]);
    expect(dropped).toBe(1);
    expect(filterExcludedItems(key, new Set(), schema, [alice]).kept).toEqual([alice]);
  });
});

describe('masquage des données personnelles dans les journaux', () => {
  test('e-mails et téléphones par motif ; pas de faux positif sur dates, coûts et identifiants', () => {
    const text = 'contact alice@example.test ou +33 6 12 34 56 78 ou 06 12 34 56 78 ou 415-555-2671';
    expect(maskPersonalText(text, new PersonalValueRegistry())).toBe(`contact ${PERSONAL_MASK} ou ${PERSONAL_MASK} ou ${PERSONAL_MASK} ou ${PERSONAL_MASK}`);
    const safe = 'run 6f1c at 2026-10-01 12:00:00 cost 0.004500 items 1234567 id 550e8400-e29b-41d4-a716-446655440000';
    expect(maskPersonalText(safe, new PersonalValueRegistry())).toBe(safe);
  });

  test('valeurs connues (noms) : insensible à la casse et aux espaces ; clés et imbriqués compris', () => {
    const reg = new PersonalValueRegistry();
    reg.addFromItem(schema, alice);
    expect(maskPersonalText('vu ALICE   martin à Lyon', reg)).toBe(`vu ${PERSONAL_MASK} à Lyon`);
    const out = maskPersonal({ 'Alice Martin': { note: ['Alice Martin', 3] }, tok: 'ok' }, reg, new SecretValueRegistry());
    expect(JSON.stringify(out)).not.toMatch(/alice/i);
    expect(out.tok).toBe('ok');
  });

  test('error_detail : masqué puis tronqué ; secrets masqués aussi', () => {
    const secrets = new SecretValueRegistry();
    secrets.add('sk-live-abcdef123456');
    const detail = `échec pour alice@example.test avec sk-live-abcdef123456 ${'x'.repeat(2000)}`;
    const out = boundErrorDetail(detail, new PersonalValueRegistry(), secrets)!;
    expect(out).not.toContain('alice@example.test');
    expect(out).not.toContain('sk-live-abcdef123456');
    expect(out.length).toBeLessThanOrEqual(1001);
    expect(boundErrorDetail(null)).toBeNull();
    expect(boundErrorDetail(undefined)).toBeNull();
  });
});
