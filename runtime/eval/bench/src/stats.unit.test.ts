// SPDX-License-Identifier: AGPL-3.0-only
// Statistiques du banc (15 §11) : IC de Wilson à 95 %, pass^k, médiane, différence appariée avec IC bootstrap à graine.
import { describe, expect, test } from 'vitest';
import { median, pairedBootstrap, passHatK, wilson } from './stats.ts';

const pct = (x: number): number => Math.round(x * 1000) / 10;

describe('wilson', () => {
  test('valeurs de 15 §11 : 12/15 → 54,8 à 93,0 ; 27/30 → 74,4 à 96,5', () => {
    const a = wilson(12, 15);
    expect([pct(a.low), pct(a.high)]).toEqual([54.8, 93]);
    const b = wilson(27, 30);
    expect([pct(b.low), pct(b.high)]).toEqual([74.4, 96.5]);
  });

  test('bornes : 0/n et n/n restent dans [0, 1] ; n = 0 donne un intervalle vide [0, 1]', () => {
    expect(wilson(0, 10).low).toBe(0);
    expect(wilson(10, 10).high).toBe(1);
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1, rate: null });
    expect(() => wilson(3, 2)).toThrow();
  });
});

describe('pass^k (estimateur sans biais C(c,k)/C(n,k))', () => {
  test('cas simples', () => {
    expect(passHatK(3, 3, 3)).toBe(1);
    expect(passHatK(2, 3, 3)).toBe(0);
    expect(passHatK(9, 10, 3)).toBeCloseTo(84 / 120, 10);
    expect(passHatK(10, 10, 3)).toBe(1);
    expect(() => passHatK(1, 2, 3)).toThrow();
  });
});

describe('médiane et différences appariées', () => {
  test('médiane', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test('bootstrap apparié à graine : reproductible, l’intervalle contient la différence moyenne', () => {
    const a = [1, 1, 0, 1, 1, 0, 1, 1, 1, 0];
    const b = [0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
    const first = pairedBootstrap(a, b, { seed: 7, iterations: 2000 });
    expect(pairedBootstrap(a, b, { seed: 7, iterations: 2000 })).toEqual(first);
    expect(first.mean).toBeCloseTo(0.3, 10);
    expect(first.low).toBeLessThanOrEqual(first.mean);
    expect(first.high).toBeGreaterThanOrEqual(first.mean);
    expect(() => pairedBootstrap([1], [1, 2])).toThrow();
  });
});
