// SPDX-License-Identifier: AGPL-3.0-only
// Premier démarrage (cdc/sym-browser 04d § 5.3, 04b § 11, 04g § 6 ; tâche 2.1) : jeton de `/setup` (lu ou généré, comparé à
// temps constant, consommé par la création de l'admin) et première clé d'API (`SYMB_BOOTSTRAP_API_KEY`, client `sym`).
import { describe, expect, test } from 'vitest';
import {
  ADMIN_PASSWORD_MIN_LENGTH,
  BOOTSTRAP_API_KEY_SCOPES,
  bootstrapApiKeyRecord,
  bootstrapTokenMatches,
  generateApiKey,
  resolveBootstrapToken,
  setupFirstAdmin,
  verifySecret,
  type FirstAdminStore,
} from './index.js';
import { Secret } from '../crypto/redact.js';

class MemoryAdmins implements FirstAdminStore {
  readonly admins: Array<{ email: string; passwordHash: string }> = [];
  async createFirstAdmin(admin: { email: string; passwordHash: string }): Promise<'created' | 'exists'> {
    if (this.admins.length > 0) return 'exists';
    this.admins.push(admin);
    return 'created';
  }
}

describe('jeton de premier démarrage (SYMB_BOOTSTRAP_TOKEN)', () => {
  test('lu s’il est fourni, sinon généré (32 octets, base64url) et signalé comme généré', () => {
    const given = resolveBootstrapToken(new Secret('x'.repeat(40)));
    expect(given.generated).toBe(false);
    expect(given.token.reveal()).toBe('x'.repeat(40));
    const a = resolveBootstrapToken(null);
    const b = resolveBootstrapToken(null);
    expect(a.generated).toBe(true);
    expect(a.token.reveal()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token.reveal()).not.toBe(b.token.reveal());
    expect(JSON.stringify(a)).not.toContain(a.token.reveal());
  });

  test('comparaison : égalité stricte, longueurs différentes et vides refusés', () => {
    const expected = new Secret('jeton-de-setup-de-test-assez-long-0123456789');
    expect(bootstrapTokenMatches(expected.reveal(), expected)).toBe(true);
    for (const bad of ['', expected.reveal().slice(0, -1), `${expected.reveal()}x`, expected.reveal().toUpperCase()]) {
      expect(bootstrapTokenMatches(bad, expected), bad).toBe(false);
    }
    expect(bootstrapTokenMatches('', new Secret(''))).toBe(false);
  });
});

describe('création de l’admin d’instance par jeton (/setup)', () => {
  const token = new Secret('jeton-de-setup-de-test-assez-long-0123456789');
  const form = { email: 'admin@example.org', password: 'un-mot-de-passe-solide', token: token.reveal() };

  test('mauvais jeton : refus, 0 compte créé ; bon jeton : admin créé (argon2id), puis jeton consommé', async () => {
    const store = new MemoryAdmins();
    expect(await setupFirstAdmin(store, token, { ...form, token: 'mauvais' })).toEqual({ ok: false, reason: 'bad_token' });
    expect(store.admins).toHaveLength(0);
    expect(await setupFirstAdmin(store, token, form)).toEqual({ ok: true });
    expect(store.admins).toHaveLength(1);
    expect(store.admins[0]!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(store.admins[0]!.passwordHash).not.toContain(form.password);
    expect(await verifySecret(form.password, store.admins[0]!.passwordHash)).toBe(true);
    expect(await setupFirstAdmin(store, token, { ...form, email: 'autre@example.org' })).toEqual({ ok: false, reason: 'already_done' });
    expect(store.admins).toHaveLength(1);
  });

  test('mot de passe trop court ou e-mail invalide : refus, 0 compte créé', async () => {
    const store = new MemoryAdmins();
    expect(ADMIN_PASSWORD_MIN_LENGTH).toBe(12);
    expect(await setupFirstAdmin(store, token, { ...form, password: 'a'.repeat(11) })).toEqual({ ok: false, reason: 'weak_password' });
    expect(await setupFirstAdmin(store, token, { ...form, email: 'pas-un-email' })).toEqual({ ok: false, reason: 'invalid_email' });
    expect(store.admins).toHaveLength(0);
  });
});

describe('première clé d’API (SYMB_BOOTSTRAP_API_KEY)', () => {
  test('enregistrement prêt à insérer : préfixe de la clé, empreinte argon2id, scopes sessions:write et sessions:read', async () => {
    const { key, prefix } = generateApiKey();
    const record = await bootstrapApiKeyRecord(key);
    expect(BOOTSTRAP_API_KEY_SCOPES).toEqual(['sessions:write', 'sessions:read']);
    expect(record).toMatchObject({ tenantName: 'sym', prefix, scopes: ['sessions:write', 'sessions:read'], expiresAt: null });
    expect(await verifySecret(key.reveal(), record.keyHash)).toBe(true);
    expect(JSON.stringify(record)).not.toContain(key.reveal());
  });

  test('valeur qui n’est pas une clé symb_ : refus nommant la variable, sans la valeur', async () => {
    const value = 'n'.repeat(48);
    const error = await bootstrapApiKeyRecord(new Secret(value)).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/SYMB_BOOTSTRAP_API_KEY/);
    expect((error as Error).message).not.toContain(value);
  });
});
