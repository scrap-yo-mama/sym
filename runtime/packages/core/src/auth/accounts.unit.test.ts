// SPDX-License-Identifier: AGPL-3.0-only
// Comptes avancés (3.7) : TOTP RFC 6238 et anti-rejeu, codes de secours, hiérarchie, rôle depuis les groupes d'IdP.
import { describe, expect, test } from 'vitest';
import { canActOnAccount, canInviteAs, emailDomainAllowed, generateOpaqueToken, hashOpaqueToken, isOpaqueTokenFormat, roleFromGroups } from './accounts.js';
import {
  base32Decode,
  base32Encode,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  idpAssertsMfa,
  matchTotp,
  mfaRequiredFor,
  normalizeBackupCode,
  otpauthUri,
  parseMfaEnforced,
  totpCode,
  totpStep,
  twoFactorAad,
} from './totp.js';

describe('TOTP (RFC 6238)', () => {
  // Vecteurs de l'annexe B de la RFC 6238 (SHA-1, graine ASCII « 12345678901234567890 »), tronqués à 6 chiffres.
  const rfcSecret = Buffer.from('12345678901234567890', 'ascii');
  test.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('vecteur RFC à t = %i s', (seconds, expected) => {
    expect(totpCode(rfcSecret, totpStep(seconds * 1000))).toBe(expected);
  });

  test('base32 : aller-retour, graine de 160 bits', () => {
    const secret = generateTotpSecret();
    expect(secret).toHaveLength(20);
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(() => base32Decode('ab1')).toThrow();
  });

  test('fenêtre ±1 pas ; hors fenêtre ou format invalide : refus', () => {
    const secret = generateTotpSecret();
    const at = 1_800_000_000_000;
    const step = totpStep(at);
    expect(matchTotp(secret, totpCode(secret, step), { at })).toBe(step);
    expect(matchTotp(secret, totpCode(secret, step - 1), { at })).toBe(step - 1);
    expect(matchTotp(secret, totpCode(secret, step + 1), { at })).toBe(step + 1);
    expect(matchTotp(secret, totpCode(secret, step - 2), { at })).toBeNull();
    expect(matchTotp(secret, '12345', { at })).toBeNull();
    expect(matchTotp(secret, 'abcdef', { at })).toBeNull();
  });

  test('assert_totp_replay_refused : un code d’un pas déjà utilisé (ou plus ancien) est refusé', () => {
    const secret = generateTotpSecret();
    const at = 1_800_000_000_000;
    const step = totpStep(at);
    const code = totpCode(secret, step);
    expect(matchTotp(secret, code, { at, lastUsedStep: step - 1 })).toBe(step);
    expect(matchTotp(secret, code, { at, lastUsedStep: step })).toBeNull();
    expect(matchTotp(secret, totpCode(secret, step - 1), { at, lastUsedStep: step })).toBeNull();
    expect(matchTotp(secret, totpCode(secret, step + 1), { at, lastUsedStep: step })).toBe(step + 1);
  });

  test('URI otpauth : émetteur, compte, graine base32', () => {
    const secret = generateTotpSecret();
    const uri = new URL(otpauthUri(secret, 'zz_test@example.test'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.searchParams.get('secret')).toBe(base32Encode(secret));
    expect(uri.searchParams.get('period')).toBe('30');
    expect(decodeURIComponent(uri.pathname)).toContain('zz_test@example.test');
  });

  test('AAD liée à l’utilisateur', () => {
    expect(twoFactorAad('u1')).toBe('two_factor|u1');
    expect(() => twoFactorAad('a|b')).toThrow();
  });
});

describe('codes de secours', () => {
  test('10 codes distincts de 80 bits, saisie tolérante, empreinte liée à l’utilisateur', () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    const code = codes[0]!;
    expect(normalizeBackupCode(code.toUpperCase().replace(/-/g, ' '))).toBe(code.replace(/-/g, ''));
    expect(hashBackupCode('u1', code)).toBe(hashBackupCode('u1', code.toUpperCase()));
    expect(hashBackupCode('u1', code)).not.toBe(hashBackupCode('u2', code));
    expect(hashBackupCode('u1', '123456')).toBeNull();
  });
});

describe('MFA_ENFORCED et amr', () => {
  test('valeurs et portée', () => {
    expect(parseMfaEnforced(undefined)).toBe('off');
    expect(parseMfaEnforced('ALL')).toBe('all');
    expect(() => parseMfaEnforced('yes')).toThrow(/MFA_ENFORCED/);
    expect([mfaRequiredFor('admins', 'owner'), mfaRequiredFor('admins', 'admin'), mfaRequiredFor('admins', 'member')]).toEqual([true, true, false]);
    expect(mfaRequiredFor('off', 'owner')).toBe(false);
    expect(mfaRequiredFor('all', 'member')).toBe(true);
  });

  test('assert_oidc_amr_mfa_strict : « mfa », ou deux catégories de facteurs distinctes (RFC 8176) ; une méthode seule (otp, swk, hwk), sms, pwd, absence : non', () => {
    expect(idpAssertsMfa(['pwd', 'mfa'])).toBe(true);
    expect(idpAssertsMfa(['mfa'])).toBe(true);
    expect(idpAssertsMfa(['pwd', 'otp'])).toBe(true);
    expect(idpAssertsMfa(['hwk', 'pin'])).toBe(true);
    expect(idpAssertsMfa(['swk', 'face'])).toBe(true);
    // Une méthode n'est pas une authentification multifacteur : connexion sans mot de passe par code ou clé seule.
    expect(idpAssertsMfa(['otp'])).toBe(false);
    expect(idpAssertsMfa(['swk'])).toBe(false);
    expect(idpAssertsMfa(['hwk'])).toBe(false);
    // Deux méthodes de la même catégorie (possession) : un seul facteur.
    expect(idpAssertsMfa(['otp', 'swk'])).toBe(false);
    expect(idpAssertsMfa(['pwd', 'pin'])).toBe(false);
    // SMS, téléphone, e-mail : jamais un facteur (13 § 7).
    expect(idpAssertsMfa(['pwd', 'tel'])).toBe(false);
    expect(idpAssertsMfa(['pwd', 'sms'])).toBe(false);
    expect(idpAssertsMfa(undefined)).toBe(false);
    expect(idpAssertsMfa('mfa')).toBe(false);
  });
});

describe('hiérarchie des comptes (13 § 2)', () => {
  const owner = { id: 'o', role: 'owner' as const };
  const admin = { id: 'a', role: 'admin' as const };
  const admin2 = { id: 'a2', role: 'admin' as const };
  const member = { id: 'm', role: 'member' as const };

  test('personne n’agit sur lui-même ni sur l’owner', () => {
    for (const action of ['manage', 'revoke_access', 'set_role'] as const) {
      expect(canActOnAccount(owner, owner, action)).toBe(false);
      expect(canActOnAccount(admin, owner, action)).toBe(false);
      expect(canActOnAccount(admin, admin, action)).toBe(false);
    }
  });

  test('un admin gère les membres ; sur un autre admin, révocation seulement ; jamais de changement de rôle', () => {
    expect(canActOnAccount(admin, member, 'manage')).toBe(true);
    expect(canActOnAccount(admin, admin2, 'manage')).toBe(false);
    expect(canActOnAccount(admin, admin2, 'revoke_access')).toBe(true);
    expect(canActOnAccount(admin, member, 'set_role')).toBe(false);
    expect(canActOnAccount(member, member, 'revoke_access')).toBe(false);
  });

  test('l’owner gère admins et membres', () => {
    expect(canActOnAccount(owner, admin, 'set_role')).toBe(true);
    expect(canActOnAccount(owner, admin, 'manage')).toBe(true);
  });

  test('invitation admin réservée à l’owner', () => {
    expect(canInviteAs('owner', 'admin')).toBe(true);
    expect(canInviteAs('admin', 'admin')).toBe(false);
    expect(canInviteAs('admin', 'member')).toBe(true);
    expect(canInviteAs('member', 'member')).toBe(false);
  });

  test('groupes d’IdP : jamais owner, owner jamais retiré, défaut member', () => {
    const mapping = [{ group: 'ops', role: 'admin' as const }, { group: 'staff', role: 'member' as const }];
    expect(roleFromGroups(null, ['ops'], mapping)).toBe('admin');
    expect(roleFromGroups('admin', ['staff'], mapping)).toBe('member');
    expect(roleFromGroups('owner', [], mapping)).toBe('owner');
    expect(roleFromGroups(null, ['owner'], mapping)).toBe('member');
    expect(roleFromGroups('admin', 'ops', [])).toBe('admin');
  });

  test('domaines autorisés', () => {
    expect(emailDomainAllowed('a@Example.test', [])).toBe(true);
    expect(emailDomainAllowed('a@Example.test', ['example.test'])).toBe(true);
    expect(emailDomainAllowed('a@evil.test', ['example.test'])).toBe(false);
  });

  test('jetons opaques : 256 bits, empreinte SHA-256', () => {
    const { token, hash } = generateOpaqueToken();
    expect(isOpaqueTokenFormat(token)).toBe(true);
    expect(hash).toBe(hashOpaqueToken(token));
    expect(isOpaqueTokenFormat(`${token}x`)).toBe(false);
  });
});
