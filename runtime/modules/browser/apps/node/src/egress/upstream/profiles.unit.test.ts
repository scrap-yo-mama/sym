// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.6 (04c § 2.2, BINV6) : profils de proxy nommés, identifiants scellés par l'enveloppe AES-256-GCM de la tâche 0.3
// (AAD `proxy_profile|tenantId|profileId`), relus en mémoire par le nœud seulement ; réponses masquées (`passwordSet`,
// utilisateur `ab***`). Identifiants en ligne d'une session : scellés pour `sessions.options` (AAD `session_proxy|…`).
import { inspect } from 'node:util';
import { describe, expect, test } from 'vitest';
import { MasterKey, kekFor, secretValues } from '@sym-browser/core';
import { EgressPolicyError } from '../index.js';
import { createMemoryProxyProfileStore, createProxyProfiles, maskUsername, openInlineUpstream, sealInlineUpstream, type ProxyProfileKeys } from './index.js';

const TENANT = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const PASSWORD = 'zz_test_profile_pw_7f3a';

function keys(version = 1, master = MasterKey.generate()): ProxyProfileKeys {
  return { current: kekFor(master, version) };
}

function service(k = keys()) {
  const store = createMemoryProxyProfileStore();
  let n = 0;
  const profiles = createProxyProfiles({ store, keys: k, newId: () => `00000000-0000-4000-8000-00000000000${(n += 1)}`, now: () => new Date('2026-10-02T12:00:00Z') });
  return { store, profiles };
}

describe('profils de proxy nommés', () => {
  test('création : identifiants scellés en base, jamais en clair ; réponse masquée (passwordSet, ab***)', async () => {
    const { store, profiles } = service();
    const view = await profiles.create(TENANT, { name: 'ISP Paris', type: 'socks5', host: 'Proxy.Example.COM', port: 1080, username: 'zz_test_user', password: PASSWORD, kind: 'isp' });
    expect(view).toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'ISP Paris',
      type: 'socks5',
      kind: 'isp',
      host: 'proxy.example.com',
      port: 1080,
      username: 'zz***',
      passwordSet: true,
      dnsViaProxy: true,
      createdAt: '2026-10-02T12:00:00.000Z',
      updatedAt: '2026-10-02T12:00:00.000Z',
    });
    const row = await store.get(TENANT, view.id);
    expect(row?.credentialsEncrypted).toBeTypeOf('string');
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain('zz_test_user');
    expect(stored).not.toContain(Buffer.from(PASSWORD).toString('base64'));
  });

  test('lecture par le nœud : identifiants ouverts en mémoire, mot de passe en Secret (jamais sérialisé)', async () => {
    const { profiles } = service();
    const { id } = await profiles.create(TENANT, { name: 'p', type: 'http', host: 'proxy.example.com', port: 3128, username: 'zz_test_user', password: PASSWORD });
    const upstream = await profiles.open(TENANT, id);
    expect(upstream).toMatchObject({ type: 'http', host: 'proxy.example.com', port: 3128, username: 'zz_test_user', dnsViaProxy: true });
    expect(upstream.password?.reveal()).toBe(PASSWORD);
    expect(JSON.stringify(upstream)).not.toContain(PASSWORD);
    expect(inspect(upstream, { depth: 5 })).not.toContain(PASSWORD);
    // Ouverture = valeur connue du masquage des journaux (couche 3).
    expect(secretValues.redactText(`échec ${PASSWORD}`)).toBe("échec [REDACTED]");
  });

  test('scellé lié à la ligne : un autre client, un autre id ou une autre clé ne l’ouvrent pas', async () => {
    const k = keys();
    const { store, profiles } = service(k);
    const { id } = await profiles.create(TENANT, { name: 'p', type: 'http', host: 'proxy.example.com', port: 3128, username: 'u', password: PASSWORD });
    const row = await store.get(TENANT, id);
    if (row === undefined) throw new Error('profil absent');
    // Ligne copiée chez un autre client : AAD différente, ouverture refusée.
    await store.insert({ ...row, tenantId: OTHER });
    await expect(profiles.open(OTHER, id)).rejects.toThrow(/déchiffrement impossible/);
    const other = createProxyProfiles({ store, keys: keys() });
    await expect(other.open(TENANT, id)).rejects.toThrow(/déchiffrement impossible/);
  });

  test('clé précédente (changement de MASTER_KEY en cours) : lecture par la version de KEK du scellé', async () => {
    const old = MasterKey.generate();
    const before = service({ current: kekFor(old, 1) });
    const { id } = await before.profiles.create(TENANT, { name: 'p', type: 'http', host: 'proxy.example.com', port: 3128, username: 'u', password: PASSWORD });
    const after = createProxyProfiles({ store: before.store, keys: { current: kekFor(MasterKey.generate(), 2), previous: kekFor(old, 1) } });
    expect((await after.open(TENANT, id)).password?.reveal()).toBe(PASSWORD);
  });

  test('liste, lecture, modification et suppression par client ; nom unique par client', async () => {
    const { profiles } = service();
    const a = await profiles.create(TENANT, { name: 'a', type: 'http', host: 'proxy.example.com', port: 3128 });
    await expect(profiles.create(TENANT, { name: 'a', type: 'http', host: 'proxy.example.com', port: 3128 })).rejects.toMatchObject({ field: 'name' });
    await profiles.create(OTHER, { name: 'a', type: 'http', host: 'proxy.example.com', port: 3128 });
    expect((await profiles.list(TENANT)).map((p) => p.name)).toEqual(['a']);
    expect(await profiles.get(OTHER, a.id)).toBeUndefined();
    expect(a).toMatchObject({ passwordSet: false });
    expect(a).not.toHaveProperty('username');

    const withCreds = await profiles.update(TENANT, a.id, { username: 'abcdef', password: PASSWORD, port: 8080 });
    expect(withCreds).toMatchObject({ port: 8080, username: 'ab***', passwordSet: true });
    // Mot de passe absent du correctif : conservé.
    expect((await profiles.update(TENANT, a.id, { name: 'b' })).passwordSet).toBe(true);
    expect((await profiles.open(TENANT, a.id)).password?.reveal()).toBe(PASSWORD);
    // null : identifiants effacés.
    expect(await profiles.update(TENANT, a.id, { username: null, password: null })).toMatchObject({ passwordSet: false });
    expect(await profiles.remove(TENANT, a.id)).toBe(true);
    expect(await profiles.get(TENANT, a.id)).toBeUndefined();
    expect(await profiles.remove(TENANT, a.id)).toBe(false);
  });

  test.each([
    [{ name: '', type: 'http', host: 'p.test', port: 1 }, 'name'],
    [{ name: 'n', type: 'ftp', host: 'p.test', port: 1 }, 'type'],
    [{ name: 'n', type: 'http', host: 'http://p.test', port: 1 }, 'host'],
    [{ name: 'n', type: 'http', host: 'p.test', port: 0 }, 'port'],
    [{ name: 'n', type: 'http', host: 'p.test', port: 1, password: 'x' }, 'username'],
    [{ name: 'n', type: 'http', host: 'p.test', port: 1, username: 'a:b', password: 'x' }, 'username'],
    [{ name: 'n', type: 'socks5', host: 'p.test', port: 1, username: 'u', password: 'x'.repeat(256) }, 'password'],
    [{ name: 'n', type: 'http', host: 'p.test', port: 1, kind: 'mobile' }, 'kind'],
  ])('profil invalide %j → invalid_option (%s), mot de passe absent du message', async (input, field) => {
    const { profiles } = service();
    const error = await profiles.create(TENANT, input as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EgressPolicyError);
    expect(error).toMatchObject({ code: 'invalid_option', field });
    expect(String(error)).not.toContain('x'.repeat(20));
  });

  test('profil inconnu à l’ouverture : invalid_option sur egress.upstream.profileId', async () => {
    const { profiles } = service();
    await expect(profiles.open(TENANT, '00000000-0000-4000-8000-0000000000ff')).rejects.toMatchObject({ field: 'egress.upstream.profileId' });
  });

  test('ligne conforme à la table proxy_profiles de la tâche 0.2 (colonnes du miroir Drizzle)', async () => {
    const { store, profiles } = service();
    const { id } = await profiles.create(TENANT, { name: 'p', type: 'https', host: 'proxy.example.com', port: 443, dnsViaProxy: false });
    expect(Object.keys((await store.get(TENANT, id)) ?? {}).sort()).toEqual(
      ['createdAt', 'credentialsEncrypted', 'dnsViaProxy', 'host', 'id', 'kind', 'name', 'port', 'tenantId', 'type', 'updatedAt'].sort(),
    );
  });
});

describe('identifiants en ligne d’une session (sessions.options)', () => {
  test('scellés pour la base (AAD session_proxy|client|session), masqués à la relecture, rouverts par le nœud', () => {
    const k = keys();
    const row = { tenantId: TENANT, sessionId: '00000000-0000-4000-8000-0000000000c3' };
    const stored = sealInlineUpstream({ type: 'http', host: 'proxy.example.com', port: 3128, username: 'zz_test_user', password: PASSWORD }, k, row);
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    expect(stored).toMatchObject({ type: 'http', host: 'proxy.example.com', port: 3128, username: 'zz***', passwordSet: true });
    const opened = openInlineUpstream(stored, k, row);
    expect(opened.username).toBe('zz_test_user');
    expect(opened.password?.reveal()).toBe(PASSWORD);
    expect(() => openInlineUpstream(stored, k, { ...row, sessionId: '00000000-0000-4000-8000-0000000000c4' })).toThrow(/déchiffrement impossible/);
  });

  test('masquage de l’utilisateur : deux premiers caractères puis ***', () => {
    expect(maskUsername('abcdef')).toBe('ab***');
    expect(maskUsername('a')).toBe('***');
    expect(maskUsername('')).toBe('***');
  });
});
