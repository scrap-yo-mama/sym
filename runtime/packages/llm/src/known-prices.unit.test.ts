// SPDX-License-Identifier: AGPL-3.0-only
// UX-11 : table versionnée des prix connus (USD par million de jetons). Un prix n'y figure que s'il est déjà relevé dans le
// dépôt ; un modèle sans prix relevé est « à valider » et n'a AUCUN chiffre (jamais un prix inventé, jamais 0).
import { describe, expect, it } from 'vitest';
import { KNOWN_PRICES, KNOWN_PRICES_VERSION, knownPriceOf } from './known-prices.js';

describe('table des prix connus (UX-11)', () => {
  it('claude-opus-4-8 : 5 / 25, entrée mise en cache 0,5 (relevé du test agent-live)', () => {
    expect(knownPriceOf('claude-opus-4-8')).toMatchObject({ model: 'claude-opus-4-8', status: 'verified', price: { in: 5, out: 25, in_cached: 0.5 } });
  });

  it('claude-opus-5-5, claude-sonnet-5-5 et claude-haiku-4-5 : « à valider », sans chiffre', () => {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']) {
      expect(knownPriceOf(model), model).toMatchObject({ model, status: 'to_validate', price: null });
    }
  });

  it('un modèle inconnu n’a pas d’entrée ; la recherche ignore la casse et les espaces autour', () => {
    expect(knownPriceOf('zz-modele-inconnu')).toBeNull();
    expect(knownPriceOf('  Claude-Opus-4-8 ')?.model).toBe('claude-opus-4-8');
  });

  it('chaque entrée vérifiée porte un prix positif et sa source dans le dépôt ; une entrée à valider n’a pas de prix', () => {
    expect(KNOWN_PRICES_VERSION).toBe(1);
    expect(new Set(KNOWN_PRICES.map((e) => e.model)).size).toBe(KNOWN_PRICES.length);
    for (const entry of KNOWN_PRICES) {
      expect(entry.source, entry.model).toMatch(/\S/);
      if (entry.status === 'verified') {
        expect(entry.price, entry.model).not.toBeNull();
        expect(entry.price!.in, entry.model).toBeGreaterThan(0);
        expect(entry.price!.out, entry.model).toBeGreaterThan(0);
      } else {
        expect(entry.price, entry.model).toBeNull();
      }
    }
  });
});
