// SPDX-License-Identifier: AGPL-3.0-only
// Enveloppe DEK/KEK AES-256-GCM avec AAD (cdc/sym-browser 03 § 1, 04c § 2 et § 4) et assert_secrets_protected (BINV6),
// partie chiffrement de la tâche 0.3 : chiffré sans clair, illisible sans la clé, lié à sa ligne.
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  buildAad,
  kekFor,
  openSecret,
  openSecretBytes,
  profileAad,
  proxyProfileAad,
  rotate,
  SEAL_ALG,
  sealSecret,
  SecretDecryptError,
  sessionProxyAad,
} from './envelope.js';
import { createKeyCheck, verifyKeyCheck } from './key-check.js';
import { generateMasterKey, MasterKey } from './master-key.js';

const newKey = () => MasterKey.parse(generateMasterKey());
const canary = () => `zz_test_canary_${randomBytes(8).toString('hex')}`;

describe('enveloppe AES-256-GCM + DEK/KEK', () => {
  const kek = kekFor(newKey(), 1);
  const aad = proxyProfileAad({ tenantId: randomUUID(), profileId: randomUUID() });

  test('aller-retour, format et versions', () => {
    const value = canary();
    const sealed = sealSecret(value, kek, aad);
    expect(sealed.alg).toBe(SEAL_ALG);
    expect(sealed.kekVersion).toBe(1);
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.dekWrapped).toHaveLength(12 + 32 + 16);
    expect(sealed.ciphertext).toHaveLength(Buffer.byteLength(value) + 16);
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

  test('octets bruts (profil archivé) : aller-retour', () => {
    const bytes = randomBytes(4096);
    const a = profileAad({ tenantId: 't1', profileId: 'p1', version: 3 });
    expect(openSecretBytes(sealSecret(bytes, kek, a), kek, a).equals(bytes)).toBe(true);
  });

  test('AAD de SYM Browser : un composant par champ lié, préfixe du type de ligne', () => {
    expect(proxyProfileAad({ tenantId: 't1', profileId: 'p1' })).toBe('proxy_profile|t1|p1');
    expect(sessionProxyAad({ tenantId: 't1', sessionId: 's1' })).toBe('session_proxy|t1|s1');
    expect(profileAad({ tenantId: 't1', profileId: 'p1', version: 3 })).toBe('profile|t1|p1|3');
    expect(() => buildAad(['a|b'])).toThrow(/AAD invalide/);
    expect(() => buildAad(['ok', ''])).toThrow(/AAD invalide/);
    expect(() => proxyProfileAad({ tenantId: 't|1', profileId: 'p1' })).toThrow(/AAD invalide/);
    expect(() => profileAad({ tenantId: 't1', profileId: 'p1', version: -1 })).toThrow(/version/);
  });

  test('altération d’un octet, autre KEK, autre usage, autre alg → échec générique, sans la valeur', () => {
    const value = canary();
    const sealed = sealSecret(value, kek, aad);
    for (const field of ['ciphertext', 'nonce', 'dekWrapped'] as const) {
      const flipped = Buffer.from(sealed[field]);
      flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 1;
      expect(() => openSecret({ ...sealed, [field]: flipped }, kek, aad), field).toThrow(SecretDecryptError);
    }
    expect(() => openSecret(sealed, kekFor(newKey(), 1), aad)).toThrow(SecretDecryptError);
    const master = newKey();
    const s2 = sealSecret(value, kekFor(master, 1, 'secrets'), aad);
    expect(() => openSecret(s2, kekFor(master, 1, 'tokens'), aad)).toThrow(SecretDecryptError);
    expect(() => openSecret({ ...sealed, alg: 'aes-128-gcm' }, kek, aad)).toThrow(SecretDecryptError);
    expect(() => openSecret({ ...sealed, nonce: Buffer.alloc(8) }, kek, aad)).toThrow(SecretDecryptError);
    try {
      openSecret(sealed, kekFor(newKey(), 1), aad);
    } catch (error) {
      expect((error as Error).message).not.toContain(value);
      expect((error as Error).message).not.toContain(aad);
    }
  });
});

describe('assert_secrets_protected (BINV6, partie chiffrement, tâche 0.3)', () => {
  test('identifiants de proxy : chiffré sans aucune forme du clair (brut, base64, hex)', () => {
    const password = canary();
    const sealed = sealSecret(password, kekFor(newKey(), 1), proxyProfileAad({ tenantId: 't1', profileId: 'p1' }));
    const stored = Buffer.concat([sealed.ciphertext, sealed.nonce, sealed.dekWrapped]);
    const raw = Buffer.from(password);
    expect(stored.includes(raw)).toBe(false);
    for (const encoding of ['base64', 'hex', 'latin1'] as const) expect(stored.toString(encoding)).not.toContain(raw.toString(encoding));
    expect(JSON.stringify(sealed)).not.toContain(password);
  });

  test('objet (profil persistant) illisible sans la clé maîtresse qui l’a scellé', () => {
    const [mine, other] = [newKey(), newKey()];
    const a = profileAad({ tenantId: 't1', profileId: 'p1', version: 1 });
    const sealed = sealSecret(randomBytes(1024), kekFor(mine, 1), a);
    expect(() => openSecretBytes(sealed, kekFor(other, 1), a)).toThrow(SecretDecryptError);
    expect(() => openSecretBytes(sealed, kekFor(mine, 1, 'tokens'), a)).toThrow(SecretDecryptError);
  });

  test('chiffré lié à sa ligne : autre client, autre profil, autre version, autre session → échec', () => {
    const kek = kekFor(newKey(), 1);
    const proxy = sealSecret(canary(), kek, proxyProfileAad({ tenantId: 't1', profileId: 'p1' }));
    for (const other of [proxyProfileAad({ tenantId: 't2', profileId: 'p1' }), proxyProfileAad({ tenantId: 't1', profileId: 'p2' }), sessionProxyAad({ tenantId: 't1', sessionId: 'p1' })]) {
      expect(() => openSecret(proxy, kek, other), other).toThrow(SecretDecryptError);
    }
    const profile = sealSecret(randomBytes(64), kek, profileAad({ tenantId: 't1', profileId: 'p1', version: 2 }));
    expect(() => openSecretBytes(profile, kek, profileAad({ tenantId: 't1', profileId: 'p1', version: 1 }))).toThrow(SecretDecryptError);
    // DEK d'une ligne greffée sur le chiffré d'une autre : échec aussi.
    const graft = sealSecret(canary(), kek, proxyProfileAad({ tenantId: 't1', profileId: 'p1' }));
    expect(() => openSecret({ ...proxy, dekWrapped: graft.dekWrapped }, kek, proxyProfileAad({ tenantId: 't1', profileId: 'p1' }))).toThrow(
      SecretDecryptError,
    );
  });

  test('rotate : nouvelle DEK et nouveaux nonces sous la nouvelle clé, l’ancienne n’ouvre plus', () => {
    const [oldKey, newK] = [newKey(), newKey()];
    const from = kekFor(oldKey, 3);
    const to = kekFor(newK, 4);
    const a = proxyProfileAad({ tenantId: 't1', profileId: 'p1' });
    const value = canary();
    const sealed = sealSecret(value, from, a);
    const next = rotate(sealed, from, to, a);
    expect(next.kekVersion).toBe(4);
    expect(next.nonce.equals(sealed.nonce)).toBe(false);
    expect(next.dekWrapped.equals(sealed.dekWrapped)).toBe(false);
    expect(openSecret(next, to, a)).toBe(value);
    expect(() => openSecret(next, from, a)).toThrow(SecretDecryptError);
    expect(() => rotate(sealed, kekFor(newKey(), 3), to, a)).toThrow(SecretDecryptError);
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
    expect(verifyKeyCheck({ ...record, nonce: 'AAAA' }, key)).toBe(false);
  });
});
