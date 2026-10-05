// SPDX-License-Identifier: AGPL-3.0-only
// U1.12, UX-37 : différentiel par champ d'une compilation refusée, tel qu'il est publié (événement `strategy.compiled`) :
// nombre d'écarts et deux exemples attendu/obtenu au plus, valeurs personnelles masquées (champ `x-personal` : aucun exemple).
import { PersonalValueRegistry } from '@runtime/core';
import type { HtmlDiff } from '@runtime/core/investigation';
import { describe, expect, test } from 'vitest';
import { publishedFieldDiff } from './compile-diff.js';

const SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, name: { type: 'string', 'x-personal': true }, agency: { type: 'string' }, mail: { type: 'string' } },
};
const diff = (fields: HtmlDiff['fields']): HtmlDiff => ({ expected: 57, got: 57, compared: 228, matched: 168, ratio: 0.7368, mismatches: [], fields, problems: [], reason: 'values' });

describe('différentiel par champ publié (UX-37)', () => {
  test('nombre d’écarts par champ ; un champ sans écart n’est pas publié ; deux exemples au plus', () => {
    const out = publishedFieldDiff(
      diff([
        { field: 'title', compared: 57, mismatched: 0, examples: [] },
        { field: 'agency', compared: 57, mismatched: 15, examples: [{ expected: 'Siège', got: 'Agence Nord' }, { expected: 'Siège 2', got: 'Agence Sud' }, { expected: 'x', got: 'y' }] },
      ]),
      SCHEMA,
      new PersonalValueRegistry(),
    );
    expect(out).toEqual([{ field: 'agency', compared: 57, mismatched: 15, examples: [{ expected: 'Siège', got: 'Agence Nord' }, { expected: 'Siège 2', got: 'Agence Sud' }] }]);
  });

  test('champ x-personal : le nombre d’écarts, jamais d’exemple', () => {
    const out = publishedFieldDiff(diff([{ field: 'name', compared: 57, mismatched: 12, examples: [{ expected: 'Anna Martin', got: 'Anna' }] }]), SCHEMA, new PersonalValueRegistry());
    expect(out).toEqual([{ field: 'name', compared: 57, mismatched: 12, examples: [], masked: true }]);
    expect(JSON.stringify(out)).not.toContain('Anna');
  });

  test('autre champ : e-mails, téléphones et valeurs personnelles connues du run masqués ; exemple tronqué', () => {
    const registry = new PersonalValueRegistry();
    registry.add('Bruno Durand');
    const out = publishedFieldDiff(
      diff([{ field: 'mail', compared: 57, mismatched: 3, examples: [{ expected: 'contact: bruno@zz-test.example, 06 12 34 56 78', got: `Bruno Durand ${'x'.repeat(200)}` }] }]),
      SCHEMA,
      registry,
    );
    const example = out[0]!.examples[0]!;
    expect(JSON.stringify(out)).not.toMatch(/bruno@zz-test|06 12 34|Bruno Durand/);
    expect(String(example.got).length).toBeLessThanOrEqual(81);
  });

  test('valeurs non texte : rendues en texte borné ; absence : null', () => {
    const out = publishedFieldDiff(diff([{ field: 'agency', compared: 5, mismatched: 1, examples: [{ expected: 42, got: null }] }]), SCHEMA, new PersonalValueRegistry());
    expect(out[0]!.examples).toEqual([{ expected: '42', got: null }]);
  });

  test('au plus 12 champs publiés', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ field: `f${i}`, compared: 10, mismatched: 1, examples: [] }));
    expect(publishedFieldDiff(diff(many), SCHEMA, new PersonalValueRegistry())).toHaveLength(12);
  });
});
