// SPDX-License-Identifier: AGPL-3.0-only
// Verrou de domaines (1.6), portée de site de la reconnaissance (2.1, correctif 7) : les suffixes ne sont admis que par
// une option explicite du code (jamais par une chaîne d'`allowed_hosts`), la comparaison des hôtes reste exacte sinon.
import { describe, expect, test } from 'vitest';
import { domainLock } from './domain-lock.js';

describe('verrou de domaines', () => {
  test('hôtes exacts : un sous-domaine ou une chaîne joker ne passent pas', () => {
    const lock = domainLock(['www.exemple.test', '*.exemple.test', '.exemple.test']);
    expect(lock('www.exemple.test')).toBe(true);
    expect(lock('WWW.exemple.test.')).toBe(true);
    expect(lock('api.exemple.test')).toBe(false);
    expect(lock('exemple.test')).toBe(false);
  });

  test('portée de site explicite : le domaine et ses sous-domaines, jamais un voisin ni un domaine qui le prolonge', () => {
    const lock = domainLock(['www.exemple.test'], ['exemple.test']);
    expect(lock('api.exemple.test')).toBe(true);
    expect(lock('exemple.test')).toBe(true);
    expect(lock('a.b.exemple.test')).toBe(true);
    expect(lock('evilexemple.test')).toBe(false);
    expect(lock('exemple.test.evil.test')).toBe(false);
    expect(lock('autre.test')).toBe(false);
  });
});
