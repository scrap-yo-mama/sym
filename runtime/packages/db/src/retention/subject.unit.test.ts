import { describe, expect, test } from 'vitest';
import { scrubSubject, searchForms, subjectRegex } from './subject.js';

describe('motifs de recherche du sujet', () => {
  test('un téléphone est reconnu quels que soient les séparateurs, sans être collé à d’autres chiffres', () => {
    const re = new RegExp(subjectRegex(['+33 6 12 34 56 78'])!, 'i');
    for (const t of ['+33 6 12 34 56 78', '+33.6.12.34.56.78', '+33612345678', '+33 (6) 12-34-56-78']) expect(re.test(t)).toBe(true);
    expect(re.test('+336123456789')).toBe(false);
    expect(re.test('tel:+33612345678')).toBe(true);
  });

  test('e-mail et nom : insensibles à la casse, caractères spéciaux échappés', () => {
    const re = new RegExp(subjectRegex(['a.b+c@Example.test', 'Jean (Dupont)'])!, 'i');
    expect(re.test('A.B+C@example.TEST')).toBe(true);
    expect(re.test('axb+c@example.test')).toBe(false);
    expect(re.test('jean (dupont)')).toBe(true);
    expect(subjectRegex(['   '])).toBeNull();
    expect(searchForms([])).toEqual([]);
  });

  test('scrubSubject : chaînes, clés et nombres ; reste intact', () => {
    const out = scrubSubject({ 'Alice Martin': 1, note: 'vu Alice Martin (alice@example.test)', tel: '06 12 34 56 78', n: 5, 'n°': 0.12 }, ['alice martin', 'alice@example.test', '0612345678']);
    expect(out).toEqual({ '[erased]': 1, note: 'vu [erased] ([erased])', tel: '[erased]', n: 5, 'n°': 0.12 });
  });
});
