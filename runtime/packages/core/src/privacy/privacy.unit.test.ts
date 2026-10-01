// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SecretValueRegistry } from '../crypto/redact.js';
import {
  boundErrorDetail,
  extractPersonalValues,
  extractSubjectIdentifiers,
  isUsableSubjectValue,
  filterExcludedItems,
  maskPersonal,
  maskPersonalText,
  normalizeSubjectValue,
  PERSONAL_MASK,
  PersonalValueRegistry,
  schemaHasPersonalFields,
  subjectHash,
  subjectSearchRegex,
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

  test('normalisation : casse, espaces, téléphone en E.164', () => {
    expect(normalizeSubjectValue('  Alice   MARTIN ')).toBe('alice martin');
    expect(normalizeSubjectValue('06 12 34 56 78')).toBe(normalizeSubjectValue('06.12.34.56.78'));
    expect(normalizeSubjectValue('+33 6 12 34 56 78')).toBe('+33612345678');
  });
});

describe('empreinte HMAC des sujets', () => {
  const key = randomBytes(32);
  test('stable, insensible à la forme, dépendante de la clé (pas un hash nu)', () => {
    expect(subjectHash(key, 'Alice.Martin@example.test')).toBe(subjectHash(key, ' alice.martin@EXAMPLE.test '));
    expect(subjectHash(key, 'a@example.test')).toMatch(/^[0-9a-f]{64}$/);
    const other = randomBytes(32);
    expect(subjectHash(other, 'a@example.test')).not.toBe(subjectHash(key, 'a@example.test'));
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

// ---------------------------------------------------------------------------------------------------------------
// Revue de 1.8 (non-régression)
// ---------------------------------------------------------------------------------------------------------------
describe('valeurs de sujet : chaînes identifiantes seulement (revue 1.8, points 1 et 15)', () => {
  const authorSchema = {
    type: 'object',
    properties: {
      author: { type: 'object', 'x-personal': true, properties: { name: { type: 'string' }, verified: { type: 'boolean' }, followers: { type: 'integer' } } },
      published: { type: 'string', 'x-personal': true },
      comment: { type: 'string', 'x-personal': 'content' },
    },
  };

  test('un objet x-personal ne donne ni booléen ni nombre ; date et contenu ne sont pas des identifiants', () => {
    const item = { author: { name: 'Jean-Pierre Dupont', verified: true, followers: 1234 }, published: '2026-09-15', comment: 'Bravo à toute l’équipe !' };
    expect(extractSubjectIdentifiers(authorSchema, item)).toEqual(['Jean-Pierre Dupont']);
    expect(extractPersonalValues(authorSchema, item)).not.toContain('true');
    expect(extractPersonalValues(authorSchema, item)).not.toContain('1234');
  });

  test('isUsableSubjectValue : e-mail et téléphone oui ; booléen, date, nombre, prénom court non', () => {
    for (const ok of ['alice@example.test', '+33 6 12 34 56 78', '06 12 34 56 78', 'Jean-Pierre Dupont', 'Alice Martin']) expect(isUsableSubjectValue(ok)).toBe(true);
    for (const ko of ['true', 'false', '2026-09-15', '15/09/2026', '42', '12345678', 'Anne', 'Jean', 'null', '   ']) expect(isUsableSubjectValue(ko)).toBe(false);
  });

  test('un item dont le seul point commun est « true » ou une date n’est pas exclu', () => {
    const key = randomBytes(32);
    const excluded = new Set(['true', '2026-09-15', 'Alice Martin'].map((v) => subjectHash(key, v)));
    const other = { author: { name: 'Bob Durand-Lefèvre', verified: true }, published: '2026-09-15' };
    expect(filterExcludedItems(key, excluded, authorSchema, [other]).kept).toEqual([other]);
  });
});

describe('téléphones en E.164 (revue 1.8, point 3)', () => {
  test('06…, +33 6…, 0033 6… et +33 (0)6… ont la même forme et la même empreinte', () => {
    const key = randomBytes(32);
    const forms = ['06 12 34 56 78', '+33 6 12 34 56 78', '0033 6 12 34 56 78', '+33 (0)6 12 34 56 78', '06.12.34.56.78'];
    for (const f of forms) {
      expect(normalizeSubjectValue(f)).toBe('+33612345678');
      expect(subjectHash(key, f)).toBe(subjectHash(key, '+33612345678'));
    }
    expect(normalizeSubjectValue('2026-09-15')).toBe('2026-09-15'); // une date n'est pas un téléphone
  });

  test('la recherche d’un +33 trouve la forme nationale 06, sans coller à d’autres chiffres', () => {
    const re = new RegExp(subjectSearchRegex(['+33 6 12 34 56 78'])!, 'i');
    for (const t of ['06 12 34 56 78', '06.12.34.56.78', '0612345678', '+33612345678', '+33 (0)6 12 34 56 78', '0033 6 12 34 56 78', 'tel:+33612345678']) {
      expect(re.test(t), t).toBe(true);
    }
    for (const t of ['+336123456789', '106 12 34 56 78', '0612345679']) expect(re.test(t), t).toBe(false);
    const national = new RegExp(subjectSearchRegex(['06 12 34 56 78'])!, 'i');
    expect(national.test('+33 6 12 34 56 78')).toBe(true);
  });
});

describe('recherche bornée aux limites de mot (revue 1.8, points 1 et 15)', () => {
  test('« Anne Martin » ne trouve ni « Jeanne Martinez » ni « annexe » ; casse et espaces libres', () => {
    const re = new RegExp(subjectSearchRegex(['Anne Martin'])!, 'i');
    expect(re.test('{"name":"Jeanne Martinez"}')).toBe(false);
    expect(re.test('Anne Martine')).toBe(false);
    expect(re.test('{"name":"anne   MARTIN"}')).toBe(true);
    const mail = new RegExp(subjectSearchRegex(['al@example.test'])!, 'i');
    expect(mail.test('val@example.test')).toBe(false);
    expect(mail.test('écrire à al@example.test.')).toBe(true);
    expect(subjectSearchRegex(['  '])).toBeNull();
  });
});

describe('registre de masquage par run (revue 1.8, points 8 et 19)', () => {
  test('plafonné : les valeurs les plus anciennes sortent ; vidé en fin de run', () => {
    const reg = new PersonalValueRegistry({ maxValues: 2 });
    reg.add('Alice Martin');
    reg.add('Bob Durand');
    reg.add('Carole Petit');
    expect(reg.size).toBe(2);
    expect(maskPersonalText('Alice Martin, Bob Durand, Carole Petit', reg)).toBe(`Alice Martin, ${PERSONAL_MASK}, ${PERSONAL_MASK}`);
    reg.clear();
    expect(maskPersonalText('Bob Durand', reg)).toBe('Bob Durand');
  });

  test('ajouts nombreux : coût linéaire (motif reconstruit à la lecture, pas à chaque ajout)', () => {
    const reg = new PersonalValueRegistry({ maxValues: 50_000 });
    const t0 = performance.now();
    for (let i = 0; i < 20_000; i++) reg.add(`personne numéro ${i}`);
    expect(maskPersonalText('vu personne numéro 19999 hier', reg)).toBe(`vu ${PERSONAL_MASK} hier`);
    expect(performance.now() - t0).toBeLessThan(3000); // ajouts + première lecture ; ancienne version : ~120 s (O(n²))
  });

  test('e-mail encodé dans une URL (%40) masqué', () => {
    expect(maskPersonalText('GET https://example.test/p?email=alice.martin%40example.test&x=1')).not.toMatch(/alice/i);
  });
});
