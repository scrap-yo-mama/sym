// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from 'vitest';
import { kekFor, openSecret, sealSecret, SecretDecryptError } from './envelope.js';
import { MasterKey } from './master-key.js';
import { kekForSealed, parseSealed, serializeSealed } from './serialized.js';

describe('forme texte d’une valeur scellée', () => {
  test('aller-retour : le texte se rouvre avec la KEK de sa version, sans clair dans le texte', () => {
    const old = kekFor(MasterKey.generate(), 1);
    const current = kekFor(MasterKey.generate(), 2);
    const text = serializeSealed(sealSecret('whsec_valeur_de_test', old, 'webhook_secret|t1'));
    expect(text).not.toContain('whsec_valeur_de_test');
    const sealed = parseSealed(text);
    expect(openSecret(sealed, kekForSealed({ current, previous: old }, sealed), 'webhook_secret|t1')).toBe('whsec_valeur_de_test');
    expect(() => kekForSealed({ current }, sealed)).toThrow(SecretDecryptError);
  });

  test.each(['', 'pas du json', '{"v":2}', '{"v":1,"alg":"aes-256-gcm","kekVersion":"1","nonce":"","ciphertext":"","dekWrapped":""}'])('forme illisible %j : SecretDecryptError', (text) => {
    expect(() => parseSealed(text)).toThrow(SecretDecryptError);
  });
});
