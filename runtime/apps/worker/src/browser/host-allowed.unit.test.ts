// SPDX-License-Identifier: AGPL-3.0-only
// Politique de domaines du contexte Chromium (1.6), portée de site de la reconnaissance (2.1, correctif 7) : un
// sous-domaine du site n'est admis que par une portée posée par le code, jamais par une chaîne d'`allowed_hosts`.
import { describe, expect, test } from 'vitest';
import { hostAllowed } from './run-context.js';

describe('hostAllowed', () => {
  test('hôtes exacts seulement sans portée ; `*.x` dans allowed_hosts ne vaut rien', () => {
    expect(hostAllowed('https://www.exemple.test/a', ['www.exemple.test'])).toBe(true);
    expect(hostAllowed('https://api.exemple.test/a', ['www.exemple.test', '*.exemple.test'])).toBe(false);
  });

  test('portée de site : domaine et sous-domaines, jamais un domaine qui le prolonge ni un autre schéma', () => {
    const scope = ['exemple.test'];
    expect(hostAllowed('https://api.exemple.test/v1', ['www.exemple.test'], scope)).toBe(true);
    expect(hostAllowed('wss://live.exemple.test/s', ['www.exemple.test'], scope)).toBe(true);
    expect(hostAllowed('https://exemple.test.evil.test/', ['www.exemple.test'], scope)).toBe(false);
    expect(hostAllowed('https://evilexemple.test/', ['www.exemple.test'], scope)).toBe(false);
    expect(hostAllowed('ftp://api.exemple.test/', ['www.exemple.test'], scope)).toBe(false);
  });
});
