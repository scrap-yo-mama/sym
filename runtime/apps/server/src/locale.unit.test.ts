// SPDX-License-Identifier: AGPL-3.0-only
// Langue du premier compte (06 § 1, U2 06-i18n) : l'en-tête Accept-Language de l'assistant de premier démarrage.
import { expect, test } from 'vitest';
import { localeFromAcceptLanguage } from './locale.js';

test('première langue gérée par ordre de préférence, variantes régionales ramenées à la langue', () => {
  expect(localeFromAcceptLanguage('fr-FR,fr;q=0.9,en;q=0.8')).toBe('fr');
  expect(localeFromAcceptLanguage('en-US,en;q=0.9,fr;q=0.8')).toBe('en');
  expect(localeFromAcceptLanguage('de-DE,de;q=0.9,fr;q=0.5')).toBe('fr');
  expect(localeFromAcceptLanguage('en;q=0.3, fr;q=0.9')).toBe('fr');
  expect(localeFromAcceptLanguage('FR_ca')).toBe('fr');
});

test('en-tête absent, vide, mal formé ou sans langue gérée : en (défaut de l’instance)', () => {
  expect(localeFromAcceptLanguage(undefined)).toBe('en');
  expect(localeFromAcceptLanguage('')).toBe('en');
  expect(localeFromAcceptLanguage('*')).toBe('en');
  expect(localeFromAcceptLanguage('de,es;q=0.5')).toBe('en');
  expect(localeFromAcceptLanguage(';;;,,q=x')).toBe('en');
  expect(localeFromAcceptLanguage('fr;q=0')).toBe('en');
});
