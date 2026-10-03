// SPDX-License-Identifier: AGPL-3.0-only
// `Retry-After` des refus de file (cdc/sym-browser 04b § 7) : délai médian récent d'attente en file, borné entre 1 et 60 s ;
// solde mensuel épuisé : secondes jusqu'au début du mois suivant (UTC).
import { describe, expect, test } from 'vitest';
import { QueueWaits, secondsUntilNextMonth } from './retry-after.js';

describe('QueueWaits : délai médian récent, borné entre 1 et 60 s', () => {
  test('sans mesure : 1 s', () => {
    expect(new QueueWaits().retryAfterSeconds()).toBe(1);
  });

  test('médiane des attentes récentes, arrondie à la seconde supérieure', () => {
    const waits = new QueueWaits();
    for (const ms of [1_000, 9_000, 4_200]) waits.record(ms);
    expect(waits.retryAfterSeconds()).toBe(5);
    waits.record(2_000);
    expect(waits.retryAfterSeconds()).toBe(4); // (2 000 + 4 200) / 2 = 3,1 s → 4
  });

  test('bornes : jamais moins de 1 s ni plus de 60 s', () => {
    const fast = new QueueWaits();
    fast.record(10);
    expect(fast.retryAfterSeconds()).toBe(1);
    const slow = new QueueWaits();
    slow.record(600_000);
    expect(slow.retryAfterSeconds()).toBe(60);
  });

  test('fenêtre glissante : seules les 50 dernières attentes comptent', () => {
    const waits = new QueueWaits();
    for (let i = 0; i < 100; i += 1) waits.record(50_000);
    for (let i = 0; i < 50; i += 1) waits.record(2_000);
    expect(waits.retryAfterSeconds()).toBe(2);
  });

  test('valeurs aberrantes ignorées (négatives, non finies)', () => {
    const waits = new QueueWaits();
    waits.record(-5);
    waits.record(Number.NaN);
    waits.record(Number.POSITIVE_INFINITY);
    expect(waits.retryAfterSeconds()).toBe(1);
  });
});

describe('secondsUntilNextMonth', () => {
  test('jusqu’au 1er du mois suivant à 00:00 UTC, au moins 1 s', () => {
    expect(secondsUntilNextMonth(new Date('2026-10-31T23:59:30Z'))).toBe(30);
    expect(secondsUntilNextMonth(new Date('2026-12-31T23:00:00Z'))).toBe(3_600);
    expect(secondsUntilNextMonth(new Date('2026-02-01T00:00:00Z'))).toBe(28 * 86_400);
    expect(secondsUntilNextMonth(new Date('2026-10-31T23:59:59.900Z'))).toBe(1);
  });
});
