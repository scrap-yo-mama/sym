// SPDX-License-Identifier: AGPL-3.0-only
// Formats d'affichage : une estimation est toujours préfixée de « ~ », un prix inconnu n'est jamais affiché comme 0.
import { describe, expect, test } from 'vitest';
import { formatDateTime, formatDuration, formatUsd } from './format';

describe('formatUsd', () => {
  test('estimation préfixée de ~, montant exact sans préfixe, localisé', () => {
    expect(formatUsd(0.002, 'en', true)).toBe('~$0.002');
    expect(formatUsd(0.002, 'en')).toBe('$0.002');
    expect(formatUsd(0.002, 'fr', true)).toMatch(/^~0,002\s\$$/u);
    expect(formatUsd(1.5, 'en')).toBe('$1.50');
  });

  test('un prix inconnu n’est jamais 0', () => {
    expect(formatUsd(null, 'en')).toBeNull();
    expect(formatUsd(undefined, 'fr', true)).toBeNull();
    expect(formatUsd(Number.NaN, 'en')).toBeNull();
  });
});

describe('formatDuration', () => {
  test('ms, secondes, minutes', () => {
    expect(formatDuration(240, 'en')).toMatch(/^240\s?ms$/u);
    expect(formatDuration(1200, 'en')).toBe('1.2 sec');
    expect(formatDuration(1200, 'fr')).toMatch(/^1,2\s?s$/u);
    expect(formatDuration(125_000, 'en')).toBe(new (Intl as unknown as { DurationFormat: new (l: string, o: object) => { format(d: object): string } }).DurationFormat('en', { style: 'short' }).format({ minutes: 2, seconds: 5 }));
    expect(formatDuration(null, 'en')).toBeNull();
    expect(formatDuration(-1, 'en')).toBeNull();
  });
});

describe('formatDateTime', () => {
  test('date lisible ou null', () => {
    expect(formatDateTime('2026-10-01T10:00:00Z', 'en')).toMatch(/2026/);
    expect(formatDateTime('pas une date', 'en')).toBeNull();
    expect(formatDateTime(null, 'en')).toBeNull();
  });
});
