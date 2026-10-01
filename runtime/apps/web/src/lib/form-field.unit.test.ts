// SPDX-License-Identifier: AGPL-3.0-only
// Lecture de la valeur réelle d'un champ au submit (F-20261001-UX01) : l'autoremplissage du navigateur remplit le champ
// sans déclencher `input`, la `ref` Vue reste donc vide. Aucun DOM simulé : le formulaire est un double minimal.
import { describe, expect, test } from 'vitest';
import { readFieldValue } from './form-field';

const form = (fields: Record<string, unknown>) => ({ elements: { namedItem: (name: string) => fields[name] ?? null } }) as unknown as HTMLFormElement;

describe('readFieldValue', () => {
  test('la valeur du champ dans le DOM l’emporte sur la ref (autoremplissage sans événement input)', () => {
    expect(readFieldValue(form({ password: { value: 'rempli-par-chrome' } }), 'password', '')).toBe('rempli-par-chrome');
  });

  test('un champ vidé dans le DOM reste vide même si la ref garde une ancienne valeur', () => {
    expect(readFieldValue(form({ password: { value: '' } }), 'password', 'ancienne')).toBe('');
  });

  test('sans formulaire ou sans champ de ce nom : la valeur de la ref', () => {
    expect(readFieldValue(null, 'password', 'ref')).toBe('ref');
    expect(readFieldValue(undefined, 'password', 'ref')).toBe('ref');
    expect(readFieldValue(form({}), 'password', 'ref')).toBe('ref');
    expect(readFieldValue(form({ password: { checked: true } }), 'password', 'ref')).toBe('ref');
  });
});
