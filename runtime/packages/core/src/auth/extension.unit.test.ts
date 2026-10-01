// SPDX-License-Identifier: AGPL-3.0-only
// Appairage de l'extension (07 § 1) : codes lisibles à usage unique, jetons d'appareil, cookies limités au domaine.
import { describe, expect, test } from 'vitest';
import { kekFor, MasterKey, openSecret, sealSecret, SecretDecryptError, siteSessionAad } from '../crypto/index.js';
import {
  cookieMatchesDomain,
  generateExtensionToken,
  generatePairingCode,
  hashExtensionToken,
  hashPairingCode,
  isApiKeyFormat,
  isExtensionTokenFormat,
  liveCookies,
  normalizePairingCode,
} from './index.js';

describe('codes d’appairage', () => {
  test('format XXXXX-XXXXX en base32 de Crockford ; saisie tolérante ; empreinte identique quelle que soit la saisie', () => {
    const { code, hash } = generatePairingCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(hashPairingCode(code)).toBe(hash);
    expect(hashPairingCode(code.toLowerCase().replace('-', ' '))).toBe(hash);
    expect(normalizePairingCode('o0il1-ABCDE')).toBe('00111ABCDE');
    for (const bad of ['', 'ABCDE', 'ABCDE-FGHJKL', 'ABCDE-FGHJU', 'ABCDE_FGHJK']) expect(hashPairingCode(bad), bad).toBeNull();
    expect(new Set(Array.from({ length: 200 }, () => generatePairingCode().code)).size).toBe(200);
  });
});

describe('jetons d’appareil', () => {
  test('préfixe distinct des clés d’API : un jeton d’extension n’est jamais une clé, et inversement', () => {
    const { token, hash } = generateExtensionToken();
    expect(isExtensionTokenFormat(token)).toBe(true);
    expect(isApiKeyFormat(token)).toBe(false);
    expect(hashExtensionToken(token)).toBe(hash);
    expect(hash).not.toContain(token.slice(7, 20));
    expect(isExtensionTokenFormat('sy_live_abcdefgh_' + 'a'.repeat(43))).toBe(false);
  });
});

describe('cookies d’un site connecté', () => {
  test('domaine exact ou parent seulement ; jamais un autre site ni un suffixe public seul', () => {
    expect(cookieMatchesDomain('shop.example.com', 'shop.example.com')).toBe(true);
    expect(cookieMatchesDomain('.example.com', 'shop.example.com')).toBe(true);
    expect(cookieMatchesDomain('evil.example', 'shop.example.com')).toBe(false);
    expect(cookieMatchesDomain('other.shop.example.com', 'shop.example.com')).toBe(false);
    expect(cookieMatchesDomain('.com', 'shop.example.com')).toBe(false);
    expect(cookieMatchesDomain('xample.com', 'shop.example.com')).toBe(false);
  });

  test('cookies expirés écartés', () => {
    const base = { value: 'v', domain: 'a.example', path: '/', secure: true, httpOnly: true };
    expect(liveCookies([{ ...base, name: 'session' }, { ...base, name: 'old', expirationDate: 10 }, { ...base, name: 'new', expirationDate: 30 }], 20).map((c) => c.name)).toEqual(['session', 'new']);
  });

  test('assert_identity_pinned (AAD) : une valeur scellée pour A sur un domaine ne s’ouvre ni pour B ni pour un autre domaine', () => {
    const kek = kekFor(MasterKey.generate(), 1, 'site_sessions');
    const a = siteSessionAad({ ownerId: '00000000-0000-4000-8000-00000000000a', domain: 'shop.example.com', keyVersion: 1 });
    const sealed = sealSecret('[{"name":"sid","value":"zz_test"}]', kek, a);
    expect(openSecret(sealed, kek, a)).toContain('zz_test');
    for (const other of [
      siteSessionAad({ ownerId: '00000000-0000-4000-8000-00000000000b', domain: 'shop.example.com', keyVersion: 1 }),
      siteSessionAad({ ownerId: '00000000-0000-4000-8000-00000000000a', domain: 'other.example.com', keyVersion: 1 }),
      siteSessionAad({ ownerId: '00000000-0000-4000-8000-00000000000a', domain: 'shop.example.com', keyVersion: 2 }),
    ]) {
      expect(() => openSecret(sealed, kek, other)).toThrow(SecretDecryptError);
    }
    // Les KEK des secrets et de la signature d'auth ne sont pas celle des cookies.
    const master = MasterKey.generate();
    expect(master.kek('site_sessions').equals(master.kek('sessions'))).toBe(false);
    expect(master.kek('site_sessions').equals(master.kek('secrets'))).toBe(false);
  });
});
