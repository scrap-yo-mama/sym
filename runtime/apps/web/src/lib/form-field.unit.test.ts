// SPDX-License-Identifier: AGPL-3.0-only
// Lecture de la valeur réelle d'un champ au submit (F-20261001-UX01) : l'autoremplissage du navigateur remplit le champ
// sans déclencher `input`, la `ref` Vue reste donc vide. Aucun DOM simulé : le formulaire est un double minimal.
import { describe, expect, test } from 'vitest';
import { ref } from 'vue';
import { readFieldValue, takeFieldValue } from './form-field';

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

describe('takeFieldValue', () => {
  test('renvoie la valeur du DOM (autoremplissage) puis vide le champ et la ref', () => {
    const field = { value: 'rempli-par-chrome' };
    const model = ref('');
    expect(takeFieldValue(form({ currentPassword: field }), 'currentPassword', model)).toBe('rempli-par-chrome');
    expect(field.value).toBe('');
    expect(model.value).toBe('');
  });

  test('champ vide dans le DOM, ref périmée : rien n’est envoyé, et la ref ne garde pas l’ancien secret', () => {
    const field = { value: '' };
    const model = ref('ancien-secret');
    expect(takeFieldValue(form({ currentPassword: field }), 'currentPassword', model)).toBe('');
    expect(model.value).toBe('');
  });

  test('sans formulaire : la valeur de la ref, qui est vidée', () => {
    const model = ref('ref');
    expect(takeFieldValue(null, 'currentPassword', model)).toBe('ref');
    expect(model.value).toBe('');
  });
});
