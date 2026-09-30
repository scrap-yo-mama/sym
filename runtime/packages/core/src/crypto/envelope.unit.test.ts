// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { kekFor, openSecret, rotate, SEAL_ALG, sealSecret, SecretDecryptError, secretAad } from './envelope.js';
import { createKeyCheck, verifyKeyCheck } from './key-check.js';
import { generateMasterKey, MasterKey } from './master-key.js';

const newKey = () => MasterKey.parse(generateMasterKey());
const canary = () => `zz_test_canary_${randomBytes(8).toString('hex')}`;

describe('enveloppe AES-256-GCM + DEK/KEK', () => {
  const kek = kekFor(newKey(), 1);
  const row = { id: randomUUID(), kind: 'llm_api_key', ownerId: null };
  const aad = secretAad(row);

  test('aller-retour, format et versions', () => {
    const value = canary();
    const sealed = sealSecret(value, kek, aad);
    expect(sealed.alg).toBe(SEAL_ALG);
    expect(sealed.kekVersion).toBe(1);
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.dekWrapped).toHaveLength(12 + 32 + 16);
    expect(sealed.ciphertext).toHaveLength(Buffer.byteLength(value) + 16);
    expect(sealed.ciphertext.includes(Buffer.from(value))).toBe(false);
    expect(openSecret(sealed, kek, aad)).toBe(value);
  });

  test('nonces et DEK jamais réutilisés (2 000 scellements de la même valeur)', () => {
    const nonces = new Set<string>();
    const wraps = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const s = sealSecret('même valeur', kek, aad);
      nonces.add(s.nonce.toString('hex'));
      nonces.add(s.dekWrapped.subarray(0, 12).toString('hex'));
      wraps.add(s.dekWrapped.toString('hex'));
    }
    expect(nonces.size).toBe(2000);
    expect(wraps.size).toBe(1000);
  });

  test('assert_aad_binding (U1) : autre ligne, autre type, autre propriétaire → échec', () => {
    const sealed = sealSecret(canary(), kek, aad);
    for (const other of [
      { ...row, id: randomUUID() },
      { ...row, kind: 'proxy_url' },
      { ...row, ownerId: randomUUID() },
    ]) {
      expect(() => openSecret(sealed, kek, secretAad(other))).toThrow(SecretDecryptError);
    }
    // DEK d'une ligne greffée sur le chiffré d'une autre : échec aussi.
    const other = sealSecret(canary(), kek, aad);
    expect(() => openSecret({ ...sealed, dekWrapped: other.dekWrapped }, kek, aad)).toThrow(SecretDecryptError);
  });

  test('AAD : composant vide ou contenant « | » refusé', () => {
    expect(() => secretAad({ id: 'a|b', kind: 'k', ownerId: null })).toThrow(/AAD invalide/);
    expect(() => secretAad({ id: '', kind: 'k', ownerId: null })).toThrow(/AAD invalide/);
  });

  test('altération d’un octet, autre KEK, autre usage, autre alg → échec générique', () => {
    const value = canary();
    const sealed = sealSecret(value, kek, aad);
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0] = flipped[0]! ^ 1;
    expect(() => openSecret({ ...sealed, ciphertext: flipped }, kek, aad)).toThrow(SecretDecryptError);
    expect(() => openSecret(sealed, kekFor(newKey(), 1), aad)).toThrow(SecretDecryptError);
    const master = newKey();
    const s2 = sealSecret(value, kekFor(master, 1, 'secrets'), aad);
    expect(() => openSecret(s2, kekFor(master, 1, 'sessions'), aad)).toThrow(SecretDecryptError);
    expect(() => openSecret({ ...sealed, alg: 'aes-128-gcm' }, kek, aad)).toThrow(SecretDecryptError);
    try {
      openSecret({ ...sealed, ciphertext: flipped }, kek, aad);
    } catch (error) {
      expect((error as Error).message).not.toContain(value);
    }
  });

  test('assert_rekey_complete (U1) : rotate rescelle sous la nouvelle clé, l’ancienne n’ouvre plus', () => {
    const [oldKey, newK] = [newKey(), newKey()];
    const from = kekFor(oldKey, 3);
    const to = kekFor(newK, 4);
    const value = canary();
    const sealed = sealSecret(value, from, aad);
    const next = rotate(sealed, from, to, aad);
    expect(next.kekVersion).toBe(4);
    expect(next.nonce.equals(sealed.nonce)).toBe(false);
    expect(openSecret(next, to, aad)).toBe(value);
    expect(() => openSecret(next, from, aad)).toThrow(SecretDecryptError);
    expect(() => rotate(sealed, kekFor(newKey(), 3), to, aad)).toThrow(SecretDecryptError);
  });
});

describe('key_check', () => {
  test('la bonne clé ouvre le témoin, une autre non ; l’empreinte seule ne suffit pas', () => {
    const key = newKey();
    const record = createKeyCheck(key, 2);
    expect(record.version).toBe(2);
    expect(record.fingerprint).toBe(key.fingerprint);
    expect(JSON.stringify(record)).not.toContain(key.exportBase64());
    expect(verifyKeyCheck(record, key)).toBe(true);
    expect(verifyKeyCheck(record, newKey())).toBe(false);
    expect(verifyKeyCheck({ ...record, version: 3 }, key)).toBe(false);
  });
});
