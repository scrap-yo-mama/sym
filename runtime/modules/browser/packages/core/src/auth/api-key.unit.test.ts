// SPDX-License-Identifier: AGPL-3.0-only
// Clés d'API (cdc/sym-browser 03 § 5, 04 § 1, tâche 2.1) : format à préfixe affiché, empreinte argon2id (node:crypto),
// scopes fermés, authentification (inconnue, révoquée, expirée), affichage unique.
import { inspect } from 'node:util';
import { describe, expect, test } from 'vitest';
import {
  API_KEY_PREFIX,
  API_SCOPES,
  ApiKeyAuthenticator,
  apiKeyPrefixOf,
  ARGON2ID_PARAMS,
  generateApiKey,
  hashSecret,
  newApiKey,
  parseScopes,
  verifySecret,
  type ApiKeyRecord,
  type ApiKeyStore,
} from './index.js';

class MemoryStore implements ApiKeyStore {
  readonly rows = new Map<string, ApiKeyRecord>();
  readonly lookups: string[] = [];
  readonly touches: Array<{ id: string; at: Date }> = [];
  async findByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    this.lookups.push(prefix);
    return this.rows.get(prefix) ?? null;
  }
  async touch(id: string, at: Date): Promise<void> {
    this.touches.push({ id, at });
  }
}

async function storeWith(over: Partial<ApiKeyRecord> = {}, scopes = ['sessions:read'] as const) {
  const store = new MemoryStore();
  const created = await newApiKey({ scopes: [...scopes] });
  store.rows.set(created.prefix, {
    id: 'k1', tenantId: 't1', keyHash: created.keyHash, scopes: created.scopes, expiresAt: null, revokedAt: null, lastUsedAt: null, ...over,
  });
  return { store, key: created.key.reveal(), prefix: created.prefix };
}

describe('format des clés', () => {
  test('symb_ + identifiant affiché de 12 caractères + secret de 32 octets ; deux clés jamais égales', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(API_KEY_PREFIX).toBe('symb_');
    expect(a.key.reveal()).toMatch(/^symb_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    expect(a.prefix).toMatch(/^symb_[A-Za-z0-9]{12}$/);
    expect(a.key.reveal().startsWith(`${a.prefix}_`)).toBe(true);
    expect(a.key.reveal()).not.toBe(b.key.reveal());
    expect(a.prefix).not.toBe(b.prefix);
  });

  test('la clé ne se sérialise jamais en clair (JSON, inspect, gabarit)', () => {
    const { key } = generateApiKey();
    const clear = key.reveal();
    for (const out of [JSON.stringify({ key }), inspect({ key }), `${key}`]) expect(out).not.toContain(clear);
  });

  test('apiKeyPrefixOf : préfixe d’une clé bien formée, null sinon', () => {
    const { key, prefix } = generateApiKey();
    expect(apiKeyPrefixOf(key.reveal())).toBe(prefix);
    for (const bad of ['', 'symb_', prefix, `${prefix}_court`, `symt_${'a'.repeat(60)}`, `${key.reveal()}x`, ` ${key.reveal()}`, key.reveal().replace('symb_', 'SYMB_')]) {
      expect(apiKeyPrefixOf(bad), bad).toBeNull();
    }
  });
});

describe('empreinte argon2id (node:crypto)', () => {
  test('format PHC argon2id v=19 aux paramètres OWASP, sel unique, jamais le clair', async () => {
    const secret = generateApiKey().key.reveal();
    const [h1, h2] = await Promise.all([hashSecret(secret), hashSecret(secret)]);
    const { memory, passes, parallelism } = ARGON2ID_PARAMS;
    expect(memory).toBeGreaterThanOrEqual(19_456);
    expect(passes).toBeGreaterThanOrEqual(2);
    expect(h1).toMatch(new RegExp(`^\\$argon2id\\$v=19\\$m=${memory},t=${passes},p=${parallelism}\\$[A-Za-z0-9+/]{22}\\$[A-Za-z0-9+/]{43}$`));
    expect(h1).not.toBe(h2);
    expect(h1).not.toContain(secret);
    expect(h1).not.toContain(secret.slice(18));
  });

  test('vérification : bon secret accepté, autre secret ou empreinte altérée refusés', async () => {
    const secret = generateApiKey().key.reveal();
    const phc = await hashSecret(secret);
    expect(await verifySecret(secret, phc)).toBe(true);
    expect(await verifySecret(`${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`, phc)).toBe(false);
    const parts = phc.split('$');
    const tampered = [...parts.slice(0, -1), `${parts.at(-1)!.startsWith('A') ? 'B' : 'A'}${parts.at(-1)!.slice(1)}`].join('$');
    expect(await verifySecret(secret, tampered)).toBe(false);
  });

  test('empreinte malformée ou paramètres hors bornes : refus sans exception', async () => {
    const secret = 'x'.repeat(40);
    const phc = await hashSecret(secret);
    for (const bad of ['', 'argon2id', phc.replace('argon2id', 'argon2i'), phc.replace('v=19', 'v=16'), phc.replace(/m=\d+/, 'm=4194304'), phc.replace(/t=\d+/, 't=0'), phc.replace(/\$[^$]+$/, '$court')]) {
      expect(await verifySecret(secret, bad), bad).toBe(false);
    }
  });
});

describe('scopes fermés (04 § 1)', () => {
  test('quatre scopes, toute autre valeur refusée', () => {
    expect(API_SCOPES).toEqual(['sessions:write', 'sessions:read', 'profiles:write', 'admin']);
    expect(parseScopes(['sessions:read', 'admin'])).toEqual(['sessions:read', 'admin']);
    for (const bad of [[], ['sessions:*'], ['ADMIN'], ['sessions:read', 'sessions:read'], 'admin', [1], null]) {
      expect(() => parseScopes(bad), JSON.stringify(bad)).toThrow(/scope/i);
    }
  });

  test('newApiKey : clé affichée une seule fois, seule l’empreinte est à stocker ; expiration passée refusée', async () => {
    const created = await newApiKey({ scopes: ['sessions:write'], expiresAt: new Date(Date.now() + 60_000) });
    expect(Object.keys(created).sort()).toEqual(['expiresAt', 'key', 'keyHash', 'prefix', 'scopes']);
    expect(JSON.stringify(created)).not.toContain(created.key.reveal());
    expect(await verifySecret(created.key.reveal(), created.keyHash)).toBe(true);
    await expect(newApiKey({ scopes: ['sessions:write'], expiresAt: new Date(Date.now() - 1000) })).rejects.toThrow(/expir/i);
    await expect(newApiKey({ scopes: ['root' as never] })).rejects.toThrow(/scope/i);
  });
});

describe('ApiKeyAuthenticator', () => {
  test('clé valide : principal (client, clé, scopes) ; last_used_at mis à jour', async () => {
    const { store, key } = await storeWith({}, ['sessions:read']);
    const auth = new ApiKeyAuthenticator(store);
    expect(await auth.authenticate(key)).toEqual({ tenantId: 't1', apiKeyId: 'k1', scopes: ['sessions:read'] });
    expect(store.touches.map((t) => t.id)).toEqual(['k1']);
  });

  test.each([
    ['inconnue', async () => ({ ...(await storeWith()), key: generateApiKey().key.reveal() }), 'unknown'],
    ['malformée', async () => ({ ...(await storeWith()), key: 'symb_pas-une-cle' }), 'malformed'],
    ['bon préfixe, mauvais secret', async () => { const s = await storeWith(); return { ...s, key: `${s.prefix}_${'A'.repeat(43)}` }; }, 'mismatch'],
    ['révoquée', async () => storeWith({ revokedAt: new Date(Date.now() - 1000) }), 'revoked'],
    ['expirée', async () => storeWith({ expiresAt: new Date(Date.now() - 1000) }), 'expired'],
  ])('clé %s : refusée (null), motif %s', async (_label, setup, reason) => {
    const { store, key } = await setup();
    const auth = new ApiKeyAuthenticator(store);
    expect(await auth.authenticate(key)).toBeNull();
    expect(await auth.check(key)).toEqual({ ok: false, reason });
    expect(store.touches).toEqual([]);
  });

  test('expiration à la milliseconde : valide avant, refusée à l’instant exact', async () => {
    const at = new Date('2026-10-02T12:00:00.000Z');
    const { store, key } = await storeWith({ expiresAt: at });
    const before = new ApiKeyAuthenticator(store, { now: () => new Date(at.getTime() - 1) });
    const exact = new ApiKeyAuthenticator(store, { now: () => at });
    expect(await before.authenticate(key)).not.toBeNull();
    expect(await exact.authenticate(key)).toBeNull();
  });

  test('révocation immédiate malgré le cache de vérification', async () => {
    const { store, key, prefix } = await storeWith();
    const auth = new ApiKeyAuthenticator(store);
    expect(await auth.authenticate(key)).not.toBeNull();
    store.rows.set(prefix, { ...store.rows.get(prefix)!, revokedAt: new Date() });
    expect(await auth.authenticate(key)).toBeNull();
  });

  test('scope retiré en base : pris en compte à la requête suivante', async () => {
    const { store, key, prefix } = await storeWith({}, ['sessions:read']);
    const auth = new ApiKeyAuthenticator(store);
    await auth.authenticate(key);
    store.rows.set(prefix, { ...store.rows.get(prefix)!, scopes: ['admin'] });
    expect((await auth.authenticate(key))?.scopes).toEqual(['admin']);
  });

  test('scopes inconnus en base : clé refusée (ensemble fermé)', async () => {
    const { store, key } = await storeWith({ scopes: ['sessions:read', 'superuser'] });
    expect(await new ApiKeyAuthenticator(store).check(key)).toEqual({ ok: false, reason: 'invalid_record' });
  });

  test('last_used_at écrit au plus une fois par intervalle', async () => {
    let now = Date.parse('2026-10-02T12:00:00Z');
    const { store, key } = await storeWith();
    const auth = new ApiKeyAuthenticator(store, { now: () => new Date(now), touchIntervalMs: 60_000 });
    await auth.authenticate(key);
    now += 30_000;
    await auth.authenticate(key);
    now += 31_000;
    await auth.authenticate(key);
    expect(store.touches).toHaveLength(2);
  });

  test('aucune recherche en base pour un secret qui n’est pas une clé', async () => {
    const { store } = await storeWith();
    const auth = new ApiKeyAuthenticator(store);
    for (const value of ['', 'Bearer', 'symt_abc', 'n'.repeat(80)]) expect(await auth.authenticate(value)).toBeNull();
    expect(store.lookups).toEqual([]);
  });
});

describe('audit 5.3 S15 : coût argon2id borné face à des clés inventées (OWASP API4)', () => {
  test('au plus N calculs simultanés, file bornée : au-delà, refus immédiat « busy » sans calcul', async () => {
    const store = new MemoryStore();
    const auth = new ApiKeyAuthenticator(store, { maxConcurrentVerifications: 1, maxQueuedVerifications: 1 });
    const forged = () => generateApiKey().key.reveal();
    const results = await Promise.all(Array.from({ length: 6 }, () => auth.check(forged())));
    const reasons = results.map((r) => (r.ok ? 'ok' : r.reason));
    expect(reasons.filter((r) => r === 'unknown')).toHaveLength(2);
    expect(reasons.filter((r) => r === 'busy')).toHaveLength(4);
  });

  test('une clé déjà vérifiée (cache) passe même file pleine', async () => {
    const { store, key } = await storeWith();
    const auth = new ApiKeyAuthenticator(store, { maxConcurrentVerifications: 1, maxQueuedVerifications: 0 });
    expect((await auth.check(key)).ok).toBe(true);
    const flood = Array.from({ length: 3 }, () => auth.check(generateApiKey().key.reveal()));
    expect((await auth.check(key)).ok).toBe(true);
    await Promise.all(flood);
  });
});
