// SPDX-License-Identifier: AGPL-3.0-only
// Complétude d'un essai contre le compteur affiché par la page (banc réel R13 : « 6197 annonces », 24 livrées, « sain »).
import { describe, expect, it } from 'vitest';
import { incompleteVsCounter } from './investigation-executor.js';

describe('incompleteVsCounter (R13)', () => {
  it('liste finie bien en deçà du compteur : écart rendu (compteur, livrés)', () => {
    expect(incompleteVsCounter(6197, [{ records: 24, stop: 'records_empty' }])).toEqual({ counter: 6197, delivered: 24 });
    expect(incompleteVsCounter(100, [{ records: 24, stop: 'no_pagination' }, { records: 24, stop: 'no_pagination' }])).toEqual({ counter: 100, delivered: 24 });
  });

  it('aucun écart : compteur absent, liste non finie (plafond de pages), ou livrés proches du compteur', () => {
    expect(incompleteVsCounter(undefined, [{ records: 24, stop: 'records_empty' }])).toBeNull();
    expect(incompleteVsCounter(6197, [{ records: 48, stop: 'max_pages_input' }, { records: 1440, stop: 'hard_max_pages' }])).toBeNull();
    expect(incompleteVsCounter(359, [{ records: 350, stop: 'no_next' }])).toBeNull();
    expect(incompleteVsCounter(12, [{ records: 5, stop: 'records_empty' }])).toBeNull();
  });
});
