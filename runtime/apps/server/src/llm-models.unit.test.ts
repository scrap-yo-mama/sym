// SPDX-License-Identifier: AGPL-3.0-only
// UX-17 : toute écriture de `settings.llm` fusionne `models[m]` ; un prix existant n'est jamais effacé par une requête qui ne le
// mentionne pas (PUT d'une console au GET périmé, script qui ne pose que le profil, enregistrement du profil après la sonde).
import { describe, expect, test } from 'vitest';
import { mergeModels } from './llm-models.js';

const PRICE = { in: 5, out: 25, in_cached: 0.5 };
const PROFILE = { tools: true, structured: 'json_schema', probed_at: '2026-10-03T10:00:00Z' };

describe('mergeModels (UX-17)', () => {
  test('une requête sans prix pour le modèle garde le prix enregistré', () => {
    const merged = mergeModels({ 'claude-opus-4-8': { price: PRICE } }, { 'claude-opus-4-8': { profile: PROFILE } });
    expect(merged).toEqual({ 'claude-opus-4-8': { price: PRICE, profile: PROFILE } });
  });

  test('l’enregistrement du profil après la sonde garde le prix et l’extra_body', () => {
    const merged = mergeModels({ m: { price: PRICE, extra_body: { zz: 1 } } }, { m: { profile: PROFILE } });
    expect(merged['m']).toEqual({ price: PRICE, extra_body: { zz: 1 }, profile: PROFILE });
  });

  test('un prix envoyé remplace le prix enregistré ; le profil absent de la requête reste', () => {
    const merged = mergeModels({ m: { price: PRICE, profile: PROFILE } }, { m: { price: { in: 1, out: 2 } } });
    expect(merged['m']).toEqual({ price: { in: 1, out: 2 }, profile: PROFILE });
  });

  test('price: null change explicitement le prix : il est retiré, le reste est gardé', () => {
    const merged = mergeModels({ m: { price: PRICE, profile: PROFILE } }, { m: { price: null } });
    expect(merged['m']).toEqual({ profile: PROFILE });
    expect('price' in merged['m']!).toBe(false);
  });

  test('un modèle absent de la requête est gardé tel quel ; un nouveau modèle est ajouté', () => {
    const merged = mergeModels({ a: { price: PRICE } }, { b: { price: { in: 1, out: 2 } } });
    expect(merged).toEqual({ a: { price: PRICE }, b: { price: { in: 1, out: 2 } } });
  });

  test('sans ancien réglage ni requête : objet vide, jamais d’exception ; l’entrée n’est pas modifiée', () => {
    expect(mergeModels(undefined, undefined)).toEqual({});
    const old = { m: { price: PRICE } };
    mergeModels(old, { m: { price: null } });
    expect(old).toEqual({ m: { price: PRICE } });
  });
});

describe('mergeModels : retrait d’un modèle (revue fix-ux-11, point 5)', () => {
  test('models[m]: null retire le modèle entier ; les autres sont gardés', () => {
    const merged = mergeModels({ a: { price: PRICE }, b: { price: { in: 1, out: 2 } } }, { a: null });
    expect(merged).toEqual({ b: { price: { in: 1, out: 2 } } });
    expect('a' in merged).toBe(false);
  });
});
