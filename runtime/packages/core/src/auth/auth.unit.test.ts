// Auth noyau (0.3b) : matrice de rôles (13 § 2), format des clés d'API (13 § 8), mots de passe argon2id (13 § 5).
import { describe, expect, test } from 'vitest';
import { API_KEY_PREFIX, generateApiKey, GRANTABLE_SCOPES, hashApiKey, isApiKeyFormat, isGrantableScope } from './api-keys.js';
import { ARGON2_PARAMS, hashPassword, passwordHashParams, passwordPolicyViolation, verifyPassword } from './password.js';
import { can, isRole, PERMISSIONS, ROLES, STRUCTURALLY_DENIED, type Permission } from './roles.js';

describe('rôles et permissions', () => {
  test('lignes structurellement refusées à tous les rôles, owner compris (INV5, X5)', () => {
    for (const permission of STRUCTURALLY_DENIED) for (const role of ROLES) expect(can(role, permission), `${role} ${permission}`).toBe(false);
  });

  test('hiérarchie : seul l’owner nomme les admins, transfère la propriété et règle sécurité et SSO', () => {
    for (const p of ['users:set_role', 'owner:transfer', 'settings:security:write', 'settings:sso:write', 'audit:export'] as Permission[]) {
      expect([can('member', p), can('admin', p), can('owner', p)], p).toEqual([false, false, true]);
    }
  });

  test('un membre n’a aucune permission d’administration', () => {
    const adminOnly = (Object.keys(PERMISSIONS) as Permission[]).filter((p) => /^(users|settings|audit|tunnel:revoke_other|apikeys:revoke_other)/.test(p));
    expect(adminOnly.length).toBeGreaterThan(8);
    for (const p of adminOnly) expect(can('member', p), p).toBe(false);
  });

  test('isRole', () => {
    expect(ROLES.every(isRole)).toBe(true);
    expect(isRole('superadmin')).toBe(false);
  });
});

describe('clés d’API', () => {
  test('format sy_live_ + préfixe + 32 octets ; SHA-256 stocké ; clés distinctes', () => {
    const k = generateApiKey();
    expect(k.key.startsWith(k.prefix)).toBe(true);
    expect(k.prefix.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(isApiKeyFormat(k.key)).toBe(true);
    expect(Buffer.from(k.key.slice(-43), 'base64url')).toHaveLength(32);
    expect(k.hash).toBe(hashApiKey(k.key));
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(generateApiKey().key).not.toBe(k.key);
    expect(isApiKeyFormat(`${k.key}x`)).toBe(false);
    expect(isApiKeyFormat('sy_live_short')).toBe(false);
  });

  test('assert_api_key_scopes : users:*, settings:*, audit:*, api_keys:*, sites:write, tunnel:* jamais accordables', () => {
    for (const s of ['users:invite', 'settings:llm', 'audit:read', 'api_keys:write', 'sites:write', 'tunnel:pair']) expect(isGrantableScope(s), s).toBe(false);
    expect(GRANTABLE_SCOPES.every(isGrantableScope)).toBe(true);
  });
});

describe('mots de passe', () => {
  test('argon2id aux paramètres OWASP, vérification, refus d’un autre mot de passe', async () => {
    const stored = await hashPassword('zz_test_correct horse');
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(passwordHashParams(stored)).toEqual({ memory: ARGON2_PARAMS.memory, passes: ARGON2_PARAMS.passes, parallelism: ARGON2_PARAMS.parallelism });
    expect(await verifyPassword(stored, 'zz_test_correct horse')).toBe(true);
    expect(await verifyPassword(stored, 'zz_test_correct horsE')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
    expect(await hashPassword('zz_test_correct horse')).not.toBe(stored); // sel aléatoire
  });

  test('politique : 12 à 128 caractères, liste locale, aucune règle de composition', () => {
    expect(passwordPolicyViolation('short')).toBe('too_short');
    expect(passwordPolicyViolation('a'.repeat(129))).toBe('too_long');
    expect(passwordPolicyViolation('Password1234')).toBe('common');
    expect(passwordPolicyViolation('tout en minuscules sans chiffre')).toBeNull();
    expect(passwordPolicyViolation('é'.repeat(12))).toBeNull();
  });
});
