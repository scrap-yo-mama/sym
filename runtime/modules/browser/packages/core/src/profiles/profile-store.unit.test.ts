// SPDX-License-Identifier: AGPL-3.0-only
// ProfileStore (cdc/sym-browser 04c § 4, tâche 3.1) sur un ObjectStore disk et le registre en mémoire : verrou d'écriture
// exclusif (409 `profile_locked` avec `lockedBySession`), lecture seule partagée, versions `v{n}` successives, bascule du
// pointeur et libération du verrou ensemble, taille plafonnée, plantage sans sauvegarde. Partie 3.1 de
// assert_secrets_protected (BINV6) : l'objet de profil est chiffré, illisible sans la clé maîtresse et lié à sa clé.
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { SecretDecryptError } from '../crypto/envelope.js';
import { MasterKey } from '../crypto/master-key.js';
import { DiskBlobStore } from '../storage/disk-store.js';
import { profileObjectKey } from '../storage/keys.js';
import { ObjectStore } from '../storage/object-store.js';
import { MemoryProfileRegistry, ProfileLockedError, ProfileNotFoundError, type ProfileRegistry } from './registry.js';
import { ProfileStore, type ProfileEvent } from './profile-store.js';

const dirs: string[] = [];
const newDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'symb-pstore-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const CANARY = 'zz_test_cookie_canary_31';

function put(root: string, rel: string, content: string | Buffer): void {
  const file = join(root, ...rel.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
const read = (root: string, rel: string) => readFileSync(join(root, ...rel.split('/')), 'utf8');
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

function setup(opts: { maxBytes?: number; master?: MasterKey; objectsDir?: string; registry?: ProfileRegistry } = {}) {
  const objectsDir = opts.objectsDir ?? newDir();
  const master = opts.master ?? MasterKey.generate();
  const objects = new ObjectStore({ blobs: new DiskBlobStore(objectsDir), master, kekVersion: 1 });
  const ended = new Set<string>();
  const registry = (opts.registry as MemoryProfileRegistry | undefined) ?? new MemoryProfileRegistry({ sessionEnded: (id) => ended.has(id) });
  const events: ProfileEvent[] = [];
  const store = new ProfileStore({ objects, registry, maxBytes: opts.maxBytes ?? 1_000_000, onEvent: (e) => events.push(e) });
  return { objectsDir, master, objects, registry: registry as MemoryProfileRegistry, store, events, ended };
}

const tenantId = randomUUID();
const target = (profileId: string, mode: 'read' | 'write', sessionId = randomUUID()) => ({ tenantId, profileId, mode, sessionId });

/** Session d'écriture complète : restauration, écriture d'un cookie de connexion, sauvegarde. */
async function writeSession(store: ProfileStore, profileId: string, value: string) {
  const t = target(profileId, 'write');
  const dir = newDir();
  await store.restore(t, dir);
  put(dir, 'Default/Network/Cookies', value);
  return { t, dir, result: await store.save(t, dir) };
}

describe('ProfileStore : versions et verrou d’écriture (04c § 4.2)', () => {
  test('profil vide : restauration sans fichier ; sauvegarde → v1, pointeur basculé et verrou libéré ensemble', async () => {
    const { store, registry, objects } = setup();
    const profileId = registry.create(tenantId, 'fixture');
    const t = target(profileId, 'write');
    const dir = newDir();
    expect(await store.restore(t, dir)).toMatchObject({ version: 0, files: 0 });
    expect((await registry.get(tenantId, profileId))?.lockSessionId).toBe(t.sessionId);
    put(dir, 'Default/Network/Cookies', CANARY);
    put(dir, 'Default/Cache/data_0', 'cache jamais sauvegardé');
    const saved = await store.save(t, dir);
    expect(saved).toMatchObject({ saved: true, version: 1 });
    const row = await registry.get(tenantId, profileId);
    expect(row).toMatchObject({ version: 1, objectKey: profileObjectKey({ tenantId, profileId, version: 1 }), lockSessionId: null });
    expect(row!.sizeBytes).toBeGreaterThan(0);
    expect((await objects.list(`profiles/${tenantId}/${profileId}/`)).map((o) => o.key)).toEqual([row!.objectKey]);
  });

  test('nouvelle session sur le même profil : état restauré (toujours connecté) ; chaque sauvegarde ajoute v{n+1}, les anciennes restent', async () => {
    const { store, registry, objects } = setup();
    const profileId = registry.create(tenantId, 'suite');
    await writeSession(store, profileId, 'login-1');
    const second = target(profileId, 'write');
    const dir = newDir();
    expect(await store.restore(second, dir)).toMatchObject({ version: 1, files: 1 });
    expect(read(dir, 'Default/Network/Cookies')).toBe('login-1');
    put(dir, 'Default/Network/Cookies', 'login-2');
    expect(await store.save(second, dir)).toMatchObject({ saved: true, version: 2 });
    const third = newDir();
    await store.restore(target(profileId, 'read'), third);
    expect(read(third, 'Default/Network/Cookies')).toBe('login-2');
    expect((await objects.list(`profiles/${tenantId}/${profileId}/`)).map((o) => o.key)).toEqual([1, 2].map((version) => profileObjectKey({ tenantId, profileId, version })));
  });

  test('2e écriture simultanée → ProfileLockedError 409 profile_locked avec lockedBySession ; avant tout fichier restauré', async () => {
    const { store, registry } = setup();
    const profileId = registry.create(tenantId, 'verrou');
    await writeSession(store, profileId, 'login');
    const first = target(profileId, 'write');
    await store.restore(first, newDir());
    const dir = newDir();
    const error = await store.restore(target(profileId, 'write'), dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProfileLockedError);
    expect(error).toMatchObject({ code: 'profile_locked', status: 409, retryable: false, lockedBySession: first.sessionId });
    expect(readdirSync(dir)).toEqual([]);
    const api = (error as ProfileLockedError).toApiError('req-1');
    expect(api).toMatchObject({ error: { code: 'profile_locked', retryable: false, requestId: 'req-1', details: { lockedBySession: first.sessionId } } });
    expect(api.error.what_to_do.length).toBeGreaterThan(0);
  });

  test('accès concurrents : sur 20 demandes d’écriture simultanées, une seule obtient le verrou', async () => {
    const { store, registry } = setup();
    const profileId = registry.create(tenantId, 'course');
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => store.restore(target(profileId, 'write'), newDir())));
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    for (const o of outcomes.filter((x) => x.status === 'rejected')) expect((o as PromiseRejectedResult).reason).toBeInstanceOf(ProfileLockedError);
  });

  test('lecture seule partagée : en parallèle d’une écriture, autant de lectures que voulu ; leurs modifications disparaissent', async () => {
    const { store, registry } = setup();
    const profileId = registry.create(tenantId, 'lecture');
    await writeSession(store, profileId, 'login');
    const writer = target(profileId, 'write');
    await store.restore(writer, newDir());
    const readers = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const dir = newDir();
        const t = target(profileId, 'read');
        await store.restore(t, dir);
        return { t, dir };
      }),
    );
    for (const { t, dir } of readers) {
      expect(read(dir, 'Default/Network/Cookies')).toBe('login');
      put(dir, 'Default/Network/Cookies', 'modifié en lecture');
      await expect(store.save(t, dir)).rejects.toThrow(/lecture seule/);
      await store.release(t);
    }
    expect(await registry.get(tenantId, profileId)).toMatchObject({ version: 1, lockSessionId: writer.sessionId });
    const check = newDir();
    await store.restore(target(profileId, 'read'), check);
    expect(read(check, 'Default/Network/Cookies')).toBe('login');
  });

  test('verrou tenu par une session terminée : repris par la suivante', async () => {
    const { store, registry, ended } = setup();
    const profileId = registry.create(tenantId, 'reprise');
    const dead = target(profileId, 'write');
    await store.restore(dead, newDir());
    await expect(store.restore(target(profileId, 'write'), newDir())).rejects.toBeInstanceOf(ProfileLockedError);
    ended.add(dead.sessionId);
    const next = target(profileId, 'write');
    await store.restore(next, newDir());
    expect((await registry.get(tenantId, profileId))?.lockSessionId).toBe(next.sessionId);
    // La session morte ne peut plus rien sauvegarder ni libérer.
    await expect(store.save(dead, newDir())).rejects.toThrow(/verrou/);
    expect((await registry.get(tenantId, profileId))?.lockSessionId).toBe(next.sessionId);
  });

  test('plantage (release sans sauvegarde) : la dernière version valide reste, le verrou est libéré', async () => {
    const { store, registry } = setup();
    const profileId = registry.create(tenantId, 'plantage');
    await writeSession(store, profileId, 'login');
    const t = target(profileId, 'write');
    const dir = newDir();
    await store.restore(t, dir);
    put(dir, 'Default/Network/Cookies', 'jamais sauvegardé');
    await store.release(t);
    await store.release(t);
    expect(await registry.get(tenantId, profileId)).toMatchObject({ version: 1, lockSessionId: null });
  });

  test('au-delà de SYMB_PROFILE_MAX_BYTES : sauvegarde abandonnée, profile.save_failed {reason: size_exceeded}, version précédente intacte, verrou libéré', async () => {
    const { store, registry, events, objects } = setup({ maxBytes: 1_000 });
    const profileId = registry.create(tenantId, 'taille');
    await writeSession(store, profileId, 'login');
    const t = target(profileId, 'write');
    const dir = newDir();
    await store.restore(t, dir);
    put(dir, 'Default/IndexedDB/x.leveldb/000001.ldb', Buffer.alloc(5_000, 1));
    expect(await store.save(t, dir)).toEqual({ saved: false, reason: 'size_exceeded' });
    expect(events).toEqual([{ type: 'profile.save_failed', tenantId, profileId, sessionId: t.sessionId, data: { reason: 'size_exceeded' } }]);
    expect(await registry.get(tenantId, profileId)).toMatchObject({ version: 1, lockSessionId: null });
    expect(await objects.list(`profiles/${tenantId}/${profileId}/`)).toHaveLength(1);
  });

  test('restauration en échec en écriture (objet absent) : verrou libéré, erreur rendue', async () => {
    const { store, registry, objects } = setup();
    const profileId = registry.create(tenantId, 'perdu');
    await writeSession(store, profileId, 'login');
    await objects.delete(profileObjectKey({ tenantId, profileId, version: 1 }));
    const t = target(profileId, 'write');
    await expect(store.restore(t, newDir())).rejects.toThrow();
    expect((await registry.get(tenantId, profileId))?.lockSessionId).toBeNull();
  });

  test('profil inconnu ou d’un autre client : ProfileNotFoundError, en lecture comme en écriture', async () => {
    const { store, registry } = setup();
    const profileId = registry.create(tenantId, 'à moi');
    for (const mode of ['read', 'write'] as const) {
      await expect(store.restore(target(randomUUID(), mode), newDir())).rejects.toBeInstanceOf(ProfileNotFoundError);
      await expect(store.restore({ ...target(profileId, mode), tenantId: randomUUID() }, newDir())).rejects.toBeInstanceOf(ProfileNotFoundError);
    }
  });
});

describe('assert_secrets_protected (3.1, BINV6) : profil chiffré au repos', () => {
  test('aucun octet en clair dans le stockage ; objet illisible sans la MASTER_KEY ; objet déplacé sur un autre profil refusé', async () => {
    const a = setup();
    const profileId = a.registry.create(tenantId, 'secret');
    await writeSession(a.store, profileId, CANARY);
    const stored = walk(a.objectsDir);
    expect(stored).toHaveLength(1);
    expect(statSync(stored[0]!).mode & 0o777).toBe(0o600);
    const raw = readFileSync(stored[0]!);
    expect(raw.includes(Buffer.from(CANARY))).toBe(false);
    expect(raw.includes(Buffer.from('Cookies'))).toBe(false);

    // Même stockage, même registre, autre clé maîtresse : restauration impossible.
    const b = setup({ objectsDir: a.objectsDir, master: MasterKey.generate(), registry: a.registry });
    await expect(b.store.restore(target(profileId, 'read'), newDir())).rejects.toBeInstanceOf(SecretDecryptError);

    // Objet copié sous la clé d'un autre profil (AAD tenantId|profileId|version) : refusé.
    const other = a.registry.create(tenantId, 'autre');
    const from = join(a.objectsDir, ...profileObjectKey({ tenantId, profileId, version: 1 }).split('/'));
    const to = join(a.objectsDir, ...profileObjectKey({ tenantId, profileId: other, version: 1 }).split('/'));
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
    a.registry.forceVersion(tenantId, other, 1, profileObjectKey({ tenantId, profileId: other, version: 1 }));
    await expect(a.store.restore(target(other, 'read'), newDir())).rejects.toBeInstanceOf(SecretDecryptError);
  });
});

describe('audit 5.3 S08 (BINV1, BINV6) : un registre altéré ne fait jamais restaurer le profil d’un autre client', () => {
  test('pointeur de A vers l’objet de B : restauration refusée, aucun fichier écrit, verrou libéré', async () => {
    const base = setup();
    const victim = base.registry.create(tenantId, 'victime');
    await writeSession(base.store, victim, CANARY);
    const victimRow = await base.registry.get(tenantId, victim);
    const otherTenant = randomUUID();
    const attacker = base.registry.create(otherTenant, 'attaquant');
    // Registre altéré (erreur d'administration, injection ailleurs) : la ligne de A pointe vers l'objet de B.
    const tampered: ProfileRegistry = {
      get: async (t, p) => {
        const row = await base.registry.get(t, p);
        return row && { ...row, version: victimRow!.version, objectKey: victimRow!.objectKey };
      },
      acquireWriteLock: async (t, p, s) => {
        const lock = await base.registry.acquireWriteLock(t, p, s);
        return lock.ok ? { ...lock, profile: { ...lock.profile, version: victimRow!.version, objectKey: victimRow!.objectKey } } : lock;
      },
      commitVersion: (...args) => base.registry.commitVersion(...args),
      releaseLock: (...args) => base.registry.releaseLock(...args),
    };
    const store = new ProfileStore({ objects: base.objects, registry: tampered, maxBytes: 1_000_000 });
    for (const mode of ['read', 'write'] as const) {
      const dir = newDir();
      const sessionId = randomUUID();
      await expect(store.restore({ tenantId: otherTenant, profileId: attacker, mode, sessionId }, dir)).rejects.toThrow(/clé d’objet/);
      expect(walk(dir)).toEqual([]);
    }
    expect((await base.registry.get(otherTenant, attacker))?.lockSessionId ?? null).toBeNull();
  });
});
